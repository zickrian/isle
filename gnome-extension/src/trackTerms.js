// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Cleaning up a track's title and artist so a lyrics search finds it, e.g. YouTube's "Artist - Song (Official Video)"
// by "ArtistVEVO" becomes "Song" by "Artist". The same cleaning as isled's (isle-core's track.rs).

/** Words that mark a bracketed suffix as noise rather than part of the title. */
const NOISE = ['official', 'video', 'audio', 'lyric', 'lyrics', 'visualizer', 'mv', 'm/v', 'hd', '4k', 'remaster',
    'remastered', 'live', 'explicit', 'clip'];

/** Removes bracketed suffixes like "(Official Video)" or "[4K]". */
function stripNoise(title) {
    let result = '';
    let rest = title;
    for (;;) {
        const start = rest.search(/[([]/);
        if (start < 0)
            break;
        const close = rest[start] === '(' ? ')' : ']';
        const length = rest.slice(start).indexOf(close);
        if (length < 0)
            break;
        const inner = rest.slice(start + 1, start + length).toLowerCase();
        result += rest.slice(0, start);
        if (!NOISE.some(word => inner.split(/\s+/).includes(word)))
            result += rest.slice(start, start + length + 1);
        rest = rest.slice(start + length + 1);
    }
    result += rest;
    return result.split(/\s+/).filter(Boolean).join(' ');
}

/** The title without noise but with any "Artist - " prefix still in it: a free-text search for when the split from
 * `searchTerms` finds nothing. */
export function fullTitle(title) {
    // "Song | Channel": what follows the bar is the uploader's branding, never part of the song's name.
    return stripNoise(String(title ?? '').split(' | ')[0]);
}

/** Drops YouTube's " - Topic" and "VEVO" channel suffixes from an artist name. */
function cleanArtist(artist) {
    let result = String(artist ?? '').trim();
    if (result.endsWith(' - Topic'))
        result = result.slice(0, -' - Topic'.length);
    if (result.endsWith('VEVO'))
        result = result.slice(0, -'VEVO'.length);
    return result.trim();
}

/** Whether `artist` is probably the uploader's channel rather than the performer named on the left of the title. */
function looksLikeChannel(artist, titleArtist) {
    const a = artist.toLowerCase().replaceAll(' ', '');
    const b = titleArtist.toLowerCase().replaceAll(' ', '');
    return a === b || a.includes(b) || b.includes(a) || a.endsWith('records') || a.endsWith('music');
}

/** [title, artist] cleaned for a lyrics search. */
export function searchTerms(rawTitle, rawArtist) {
    let title = fullTitle(rawTitle);
    let artist = cleanArtist(rawArtist);

    // "Artist - Song" in the title wins over a channel name in the artist.
    const dash = title.indexOf(' - ');
    if (dash >= 0) {
        const left = title.slice(0, dash).trim();
        const right = title.slice(dash + 3).trim();
        if (!artist || (right && looksLikeChannel(artist, left))) {
            artist = left;
            title = right;
        }
    }

    // "Song ft. Someone": the featured artist is rarely part of the stored title.
    for (const marker of [' ft. ', ' feat. ', ' ft ', ' feat ']) {
        const lower = title.toLowerCase();
        const index = lower.indexOf(marker);
        // Lowercasing can change lengths outside ASCII; only cut where both agree.
        if (index >= 0 && lower.length === title.length)
            title = title.slice(0, index);
    }
    return [title.trim(), artist.trim()];
}
