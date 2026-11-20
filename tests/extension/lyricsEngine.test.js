// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Asking the lyrics providers in Settings' order, against stand-ins for isled, Settings and the web:
// `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {LyricsEngine, needsEngine, providerPlan, trackKey, trackQuery} from '../../gnome-extension/src/lyricsEngine.js';

/** Time for what is waiting on a promise to run. */
const settle = async () => {
    for (let i = 0; i < 12; i++)
        await new Promise(resolve => setTimeout(resolve, 0));
};

class FakeDaemon {
    constructor() {
        this.state = {nowPlaying: null, lyrics: null};
        this.handlers = [];
        this.calls = [];
        this.published = [];
        this.republished = 0;
        this.interceptLyrics = null;
        this._raw = null;
    }

    connect(_signal, handler) {
        this.handlers.push(handler);
        return this.handlers.length;
    }

    disconnect() {}

    call(_interface, method, ...args) {
        this.calls.push([method, ...args]);
    }

    publishLyrics(lyrics) {
        this.state.lyrics = lyrics;
        this.published.push(lyrics);
    }

    republishLyrics() {
        this.state.lyrics = this._raw;
        this.republished++;
    }

    setNowPlaying(nowPlaying) {
        this.state.nowPlaying = nowPlaying;
        this.handlers.forEach(handler => handler(this, 'nowPlaying'));
    }

    /** isled sends `Lyrics`. */
    isled(lyrics) {
        this._raw = lyrics;
        if (this.interceptLyrics)
            this.interceptLyrics(lyrics);
        else
            this.state.lyrics = lyrics;
    }

    get shown() {
        return this.state.lyrics;
    }

    /** What the engine told isled with `SetLyrics`. */
    get told() {
        return this.calls.filter(call => call[0] === 'SetLyrics').map(call => call[1]);
    }
}

class FakeSettings {
    constructor(values) {
        this.values = {'lyrics-provider-order': ['lrclib', 'musixmatch', 'netease'], 'lyrics-providers-off': ['musixmatch'],
            'musixmatch-api-key': '', ...values};
        this.handlers = [];
    }

    get_strv(key) {
        return this.values[key];
    }

    get_string(key) {
        return this.values[key];
    }

    connect(signal, handler) {
        this.handlers.push([signal, handler]);
        return this.handlers.length;
    }

    disconnect() {}

    set(key, value) {
        this.values[key] = value;
        this.handlers.filter(([signal]) => signal === `changed::${key}`).forEach(([, handler]) => handler());
    }
}

class FakeWeb {
    constructor(routes) {
        this.routes = routes;
        this.urls = [];
    }

    async getText(url) {
        this.urls.push(url);
        for (const [part, reply] of this.routes) {
            const answer = typeof reply === 'function' ? reply(url) : reply;
            if (!url.includes(part))
                continue;
            if (answer instanceof Error)
                throw answer;
            return {status: answer.status ?? 200, text: JSON.stringify(answer.body ?? {})};
        }
        return {status: 404, text: ''};
    }
}

class FakeTimers {
    constructor() {
        this.list = [];
        this.schedule = (ms, run) => {
            const timer = {ms, run, live: true};
            this.list.push(timer);
            return () => (timer.live = false);
        };
    }

    get waiting() {
        return this.list.filter(timer => timer.live);
    }
}

const SONG = {available: true, status: 'Playing', title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', length_us: 200_000_000};
const KEY = trackKey(trackQuery(SONG));
const isled = (status, lines = []) => ({track: KEY, status, lines});
const neteaseRoutes = (lrc = '[00:01.00]Hello\n[00:05.00]World') => [
    ['/search/get/web', {body: {result: {songs: [{id: 7, name: 'Blinding Lights', duration: 200500, artists: [{name: 'The Weeknd'}]}]}}}],
    ['/song/lyric', {body: {lrc: {lyric: lrc}}}],
];

/** An engine with lyrics wanted (unless `wanted` is false) and the song playing (unless `nowPlaying` is null). */
function start({settings = {}, routes = neteaseRoutes(), nowPlaying = SONG, wanted = true} = {}) {
    const daemon = new FakeDaemon(), fake = new FakeSettings(settings), web = new FakeWeb(routes), timers = new FakeTimers();
    daemon.state.nowPlaying = nowPlaying;
    const engine = new LyricsEngine({daemon, settings: fake, http: web, schedule: timers.schedule});
    if (wanted)
        engine.setWanted(true);
    return {daemon, settings: fake, web, timers, engine};
}

test('the plan: Settings\' order, the providers that are on, and Musixmatch only with a key', () => {
    assert.deepEqual(providerPlan({order: ['lrclib', 'musixmatch', 'netease'], off: ['musixmatch'], keys: {}}), ['lrclib', 'netease']);
    assert.deepEqual(providerPlan({order: ['netease', 'lrclib', 'musixmatch'], off: [], keys: {musixmatch: 'k'}}), ['netease', 'lrclib', 'musixmatch']);
    assert.deepEqual(providerPlan({order: ['musixmatch', 'lrclib'], off: [], keys: {musixmatch: '  '}}), ['lrclib', 'netease']);
    assert.deepEqual(providerPlan({order: ['unknown', 'netease'], off: ['musixmatch'], keys: {}}), ['netease', 'lrclib']);
    assert.deepEqual(providerPlan({order: [], off: ['lrclib', 'musixmatch', 'netease'], keys: {}}), []);
});

test('the engine has work unless LRCLIB is the only provider', () => {
    assert.equal(needsEngine(['lrclib']), false);
    assert.ok(needsEngine(['lrclib', 'netease']) && needsEngine(['netease']) && needsEngine([]));
});

test('with LRCLIB alone, isled\'s lyrics go to the page untouched, as before', () => {
    const {daemon, engine} = start({settings: {'lyrics-providers-off': ['musixmatch', 'netease']}});
    assert.equal(daemon.interceptLyrics, null);
    assert.deepEqual(daemon.told, [true]);
    daemon.isled(isled('synced', [{time_ms: 0, text: 'x'}]));
    assert.equal(daemon.shown.status, 'synced');
    assert.equal(daemon.published.length, 0);
    engine.setWanted(false);
    assert.deepEqual(daemon.told, [true, false]);
});

test('LRCLIB first, and it has the lyrics: NetEase is never asked', async () => {
    const {daemon, web} = start();
    await settle();
    assert.equal(daemon.shown.status, 'loading');
    daemon.isled(isled('loading'));
    await settle();
    assert.equal(daemon.shown.status, 'loading');
    daemon.isled(isled('synced', [{time_ms: 1000, text: 'la'}]));
    await settle();
    assert.equal(daemon.shown.status, 'synced');
    assert.equal(web.urls.length, 0);
    assert.deepEqual(daemon.told, [true]);
});

test('LRCLIB has none: the next provider is asked, and the page is told loading, then the lyrics', async () => {
    const {daemon, web} = start();
    daemon.isled(isled('not_found'));
    await settle();
    assert.equal(daemon.shown.status, 'synced');
    assert.equal(daemon.shown.lines.length, 2);
    assert.deepEqual(daemon.published.map(lyrics => lyrics.status), ['loading', 'synced']);
    assert.ok(web.urls[1].includes('id=7'));
});

test('isled had answered already when its turn came: the answer is used at once', async () => {
    const {daemon, engine} = start({wanted: false});
    daemon.isled(isled('not_found'));
    engine.setWanted(true);
    await settle();
    assert.equal(daemon.shown.status, 'synced');
});

test('NetEase first: isled is not asked until its turn, and not at all if NetEase has them', async () => {
    const {daemon} = start({settings: {'lyrics-provider-order': ['netease', 'lrclib', 'musixmatch']}});
    await settle();
    assert.equal(daemon.shown.status, 'synced');
    assert.deepEqual(daemon.told, [false]);
});

test('NetEase first and has none: isled is asked, its lyrics shown, and isled told to stop after', async () => {
    const {daemon} = start({settings: {'lyrics-provider-order': ['netease', 'lrclib', 'musixmatch']}, routes: []});
    await settle();
    assert.equal(daemon.told.at(-1), true);
    daemon.isled(isled('synced', [{time_ms: 0, text: 'from lrclib'}]));
    await settle();
    assert.equal(daemon.shown.lines[0].text, 'from lrclib');
    assert.equal(daemon.told.at(-1), false);
});

test('plain words are shown at once, and replaced if a later provider has them synced', async () => {
    const {daemon} = start();
    daemon.isled(isled('plain', [{time_ms: -1, text: 'words only'}]));
    await settle();
    assert.equal(daemon.shown.status, 'synced');
    assert.deepEqual(daemon.published.map(lyrics => lyrics.status), ['loading', 'plain', 'synced']);
    const alone = start({routes: []});
    alone.daemon.isled(isled('plain', [{time_ms: -1, text: 'words only'}]));
    await settle();
    assert.equal(alone.daemon.shown.status, 'plain');
});

test('every provider failing shows an error and asks again later', async () => {
    const {daemon, web, timers} = start({routes: [['/search', new Error('offline')]]});
    daemon.isled(isled('error'));
    await settle();
    assert.equal(daemon.shown.status, 'error');
    const retry = timers.waiting.find(timer => timer.ms === 15000);
    assert.ok(retry);
    web.routes = neteaseRoutes();
    retry.run();
    await settle();
    assert.equal(daemon.shown.status, 'synced');
});

test('no lyrics anywhere is "not found", remembered for a while, with no retry', async () => {
    const {daemon, web, timers, engine} = start({routes: []});
    daemon.isled(isled('not_found'));
    await settle();
    assert.equal(daemon.shown.status, 'not_found');
    assert.ok(!timers.waiting.some(timer => timer.ms === 15000));
    const asked = web.urls.length;
    engine.setWanted(false);
    engine.setWanted(true);
    await settle();
    assert.equal(web.urls.length, asked);
    assert.equal(daemon.shown.status, 'not_found');
});

test('a service that refuses is "unavailable"', async () => {
    const {daemon} = start({routes: [['/search', {status: 503}]]});
    daemon.isled(isled('not_found'));
    await settle();
    assert.equal(daemon.shown.status, 'unavailable');
});

test('isled silent for its whole wait: on to the next provider', async () => {
    const {daemon, timers} = start();
    await settle();
    timers.waiting.find(timer => timer.ms === 30000).run();
    await settle();
    assert.equal(daemon.shown.status, 'synced');
});

const musixmatchSettings = order => ({'lyrics-provider-order': order, 'lyrics-providers-off': [], 'musixmatch-api-key': 'KEY'});

test('Musixmatch with a key is asked in its place; partial words give way to whole ones', async () => {
    const free = {message: {header: {status_code: 200}, body: {lyrics: {lyrics_body: 'a\nb\n\n******* This Lyrics is NOT for Commercial use *******'}}}};
    const {daemon} = start({
        settings: musixmatchSettings(['musixmatch', 'netease', 'lrclib']),
        routes: [['matcher.subtitle.get', {body: {message: {header: {status_code: 403}, body: {}}}}], ['matcher.lyrics.get', {body: free}],
            ['/search/get/web', {body: {result: {songs: [{id: 1, name: 'Blinding Lights', duration: 200000, artists: [{name: 'The Weeknd'}]}]}}}],
            ['/song/lyric', {body: {lrc: {lyric: 'whole\nplain\nlyrics\nfrom netease'}}}]],
    });
    daemon.isled(isled('not_found'));
    await settle();
    assert.equal(daemon.shown.status, 'plain');
    assert.equal(daemon.shown.lines.length, 4);
});

test('a refused key is skipped quietly; Musixmatch without a key is not asked', async () => {
    const refused = start({settings: musixmatchSettings(['musixmatch', 'netease', 'lrclib']),
        routes: [['matcher.', {body: {message: {header: {status_code: 401}, body: []}}}], ...neteaseRoutes()]});
    await settle();
    assert.equal(refused.daemon.shown.status, 'synced');
    assert.ok(!refused.timers.waiting.some(timer => timer.ms === 15000));
    const none = start({settings: {...musixmatchSettings(['musixmatch', 'lrclib', 'netease']), 'musixmatch-api-key': ''}});
    await settle();
    assert.ok(!none.web.urls.some(url => url.includes('musixmatch')));
});

test('turning a provider off steps the engine aside; turning it on brings it back', async () => {
    const {daemon, settings} = start();
    daemon.isled(isled('not_found'));
    await settle();
    settings.set('lyrics-providers-off', ['musixmatch', 'netease']);
    assert.equal(daemon.interceptLyrics, null);
    assert.equal(daemon.republished, 1);
    settings.set('lyrics-providers-off', ['musixmatch']);
    assert.equal(typeof daemon.interceptLyrics, 'function');
});

test('a new song starts a new lookup, and the old song\'s answer never lands on it', async () => {
    const {daemon} = start();
    daemon.isled(isled('loading'));
    await settle();
    const next = {...SONG, title: 'Save Your Tears'};
    daemon.setNowPlaying(next);
    await settle();
    assert.equal(daemon.shown.track, trackKey(trackQuery(next)));
    assert.equal(daemon.shown.status, 'loading');
    daemon.isled({track: trackKey(trackQuery(next)), status: 'synced', lines: [{time_ms: 0, text: 'tears'}]});
    await settle();
    assert.equal(daemon.shown.lines[0].text, 'tears');
});

test('nothing playing is "none", and a position changing does not look the song up again', async () => {
    const {daemon} = start({nowPlaying: null});
    assert.equal(daemon.shown?.status, 'none');
    daemon.setNowPlaying(SONG);
    await settle();
    assert.equal(daemon.shown.status, 'loading');
    daemon.setNowPlaying({...SONG, status: 'Paused'});
    daemon.setNowPlaying({...SONG, position_us: 5e6});
    await settle();
    assert.equal(daemon.published.filter(lyrics => lyrics.status === 'loading').length, 1);
});

test('lyrics not wanted: the page says off, and nothing is fetched or asked of isled', () => {
    const {daemon, web, engine} = start({wanted: false});
    engine.setWanted(false);
    assert.equal(daemon.shown.status, 'off');
    assert.equal(web.urls.length, 0);
    assert.ok(!daemon.told.includes(true));
});
