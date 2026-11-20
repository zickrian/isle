// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Where lyrics come from. LRCLIB is looked up by isled, Isle's service, as it always was; Musixmatch and NetEase are
// looked up here, one after the other in the order Settings give (see lyricsEngine.js). A provider's `fetch(query,
// {http, key})` answers null (nothing for this song), or {status: 'synced' | 'plain' | 'instrumental', lines, partial?},
// or throws a LyricsFailure.

import * as Lrc from './lrc.js';
import {searchTerms} from './trackTerms.js';

/** Why a lookup failed: 'network' (could not be reached), 'service' (answered with an error or nonsense) or 'auth'
 * (the API key is missing or refused; not worth asking again, nor worth telling the song has no lyrics). */
export class LyricsFailure extends Error {
    constructor(kind, message) {
        super(message);
        this.kind = kind;
    }
}

/** How far a result's length may differ from the song's, in seconds. */
const DURATION_TOLERANCE = 5;
/** Looser matches (the artist's name written another way) must be this close. */
const STRICT_TOLERANCE = 2;

/** The host of a web address, for what is said of a failure. */
const hostOf = url => url.replace(/^https?:\/\//, '').split('/')[0];

/** `http.getText(url, {headers})` answers {status, text}; this reads JSON from it. Null body for 404. */
async function getJson(http, url, headers = {}) {
    const {status, text} = await http.getText(url, {headers});
    if (status === 404)
        return null;
    if (status === 429 || status >= 500)
        throw new LyricsFailure('service', `${hostOf(url)} answered HTTP ${status}`);
    if (status < 200 || status >= 300)
        throw new LyricsFailure('service', `${hostOf(url)} answered HTTP ${status}`);
    try {
        return JSON.parse(text);
    } catch (e) {
        throw new LyricsFailure('service', `${hostOf(url)} sent an unreadable answer`);
    }
}

const encode = text => encodeURIComponent(String(text));

/** Names written alike: one holds the other, lower-cased. */
function sameName(a, b) {
    const x = String(a ?? '').toLowerCase().trim();
    const y = String(b ?? '').toLowerCase().trim();
    return Boolean(x) && Boolean(y) && (x.includes(y) || y.includes(x));
}

// ---- NetEase Cloud Music ---------------------------------------------------------------------------------------

const NETEASE = 'https://music.163.com/api';
const NETEASE_HEADERS = {
    'Referer': 'https://music.163.com/',
    'Cookie': 'appver=2.0.2; os=pc',
};

/** The song from NetEase's search that is this one: the same artist and length first, then (the artist written
 * another way) the same title and a length to the second; none rather than a wrong song. */
export function pickNeteaseSong(songs, title, artist, lengthS) {
    const fits = (song, tolerance) => lengthS <= 0 || !song.duration ||
        Math.abs(song.duration / 1000 - lengthS) <= tolerance;
    const sameArtist = song => (song.artists ?? []).some(each => sameName(each?.name, artist));
    const sameTitle = song => sameName(song.name, title);
    return songs.find(song => sameArtist(song) && fits(song, DURATION_TOLERANCE))
        ?? songs.find(song => sameTitle(song) && lengthS > 0 && song.duration && fits(song, STRICT_TOLERANCE))
        ?? null;
}

async function netease(query, {http}) {
    const [title, artist] = searchTerms(query.title, query.artist);
    // Without an artist it is rarely a song, and any song of that name would match.
    if (!title || !artist)
        return null;
    const search = await getJson(http,
        `${NETEASE}/search/get/web?csrf_token=&hlpretag=&hlposttag=&s=${encode(`${title} ${artist}`)}&type=1&offset=0&total=true&limit=10`,
        NETEASE_HEADERS);
    const song = pickNeteaseSong(search?.result?.songs ?? [], title, artist, query.lengthS);
    if (!song?.id)
        return null;
    const answer = await getJson(http, `${NETEASE}/song/lyric?id=${encode(song.id)}&lv=-1&kv=-1&tv=-1`, NETEASE_HEADERS);
    if (!answer)
        return null;
    // "Pure music": a song with no words.
    if (answer.nolyric === true)
        return {status: 'instrumental', lines: []};
    const text = String(answer.lrc?.lyric ?? '');
    const synced = Lrc.parse(text);
    if (synced.length)
        return {status: 'synced', lines: synced};
    if (text.trim())
        return {status: 'plain', lines: Lrc.plain(text)};
    return null;
}

// ---- Musixmatch -------------------------------------------------------------------------------------------------

const MUSIXMATCH = 'https://api.musixmatch.com/ws/1.1';

/** The `status_code` of a Musixmatch answer, which is also its real HTTP status (the HTTP one is often 200). */
function musixmatchStatus(answer) {
    return Number(answer?.message?.header?.status_code ?? 0);
}

/** Musixmatch's free lyrics end with a notice, after the part it shows (about a third of the song). */
export function stripMusixmatchNotice(body) {
    const lines = String(body ?? '').split(/\r?\n/);
    const notice = lines.findIndex(line => /^\*{3,}/.test(line.trim()));
    const kept = notice < 0 ? lines : lines.slice(0, notice);
    return {text: kept.join('\n').trim(), partial: notice >= 0};
}

async function musixmatch(query, {http, key}) {
    if (!key)
        throw new LyricsFailure('auth', 'Musixmatch needs an API key');
    const [title, artist] = searchTerms(query.title, query.artist);
    if (!title || !artist)
        return null;
    const base = `q_track=${encode(title)}&q_artist=${encode(artist)}&apikey=${encode(key)}&format=json`;
    // Synced first. Some plans leave it out (401/402/403 for that call only): the words alone then.
    const length = query.lengthS > 0
        ? `&f_subtitle_length=${Math.round(query.lengthS)}&f_subtitle_length_max_deviation=3` : '';
    const subtitle = await getJson(http, `${MUSIXMATCH}/matcher.subtitle.get?${base}&subtitle_format=lrc${length}`);
    const code = musixmatchStatus(subtitle);
    if (code === 401 && !subtitle?.message?.body?.subtitle)
        throw new LyricsFailure('auth', 'Musixmatch refused the API key');
    if (code === 200) {
        const synced = Lrc.parse(subtitle?.message?.body?.subtitle?.subtitle_body ?? '');
        if (synced.length)
            return {status: 'synced', lines: synced};
    } else if (code === 429) {
        throw new LyricsFailure('service', 'Musixmatch: too many requests today');
    }
    const words = await getJson(http, `${MUSIXMATCH}/matcher.lyrics.get?${base}`);
    const wordsCode = musixmatchStatus(words);
    if (wordsCode === 401)
        throw new LyricsFailure('auth', 'Musixmatch refused the API key');
    if (wordsCode === 429)
        throw new LyricsFailure('service', 'Musixmatch: too many requests today');
    if (wordsCode !== 200)
        return null;
    const lyrics = words?.message?.body?.lyrics;
    if (Number(lyrics?.instrumental) === 1)
        return {status: 'instrumental', lines: []};
    const {text, partial} = stripMusixmatchNotice(lyrics?.lyrics_body);
    return text ? {status: 'plain', lines: Lrc.plain(text), partial} : null;
}

// ---- The list ---------------------------------------------------------------------------------------------------

/** Each provider: how Settings name it, and `fetch` (none for LRCLIB: isled looks that up). */
export const PROVIDERS = {
    lrclib: {
        id: 'lrclib',
        name: 'LRCLIB',
        description: 'Free, community-made synced lyrics. No key needed.',
        needsKey: false,
    },
    musixmatch: {
        id: 'musixmatch',
        name: 'Musixmatch',
        description: 'Needs an API key from developer.musixmatch.com. Synced lyrics depend on its plan; the free one gives part of the words.',
        needsKey: true,
        fetch: musixmatch,
    },
    netease: {
        id: 'netease',
        name: 'NetEase Cloud Music',
        description: 'Large library, strong for Chinese and Asian songs. No key needed.',
        needsKey: false,
        fetch: netease,
    },
};

/** The order they are tried in until Settings say otherwise. */
export const DEFAULT_ORDER = ['lrclib', 'musixmatch', 'netease'];
