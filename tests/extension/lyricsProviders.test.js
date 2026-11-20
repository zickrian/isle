// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The lyrics providers Isle asks itself, against stand-ins for the web: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {LyricsFailure, PROVIDERS, pickNeteaseSong, stripMusixmatchNotice} from '../../gnome-extension/src/lyricsProviders.js';

/** A web whose answers are `routes`: [part of an address, {status?, body}]. Remembers what was asked. */
function web(routes) {
    return {
        urls: [],
        async getText(url) {
            this.urls.push(url);
            for (const [part, reply] of routes) {
                if (url.includes(part))
                    return {status: reply.status ?? 200, text: JSON.stringify(reply.body ?? {})};
            }
            return {status: 404, text: ''};
        },
    };
}

const SONG = {title: 'Blinding Lights', artist: 'The Weeknd', album: 'After Hours', lengthS: 200};
const netease = (lyric, extra = {}) => web([
    ['/search/get/web', {body: {result: {songs: [{id: 7, name: 'Blinding Lights', duration: 200500, artists: [{name: 'The Weeknd'}]}]}}}],
    ['/song/lyric', {body: {lrc: {lyric}, ...extra}}],
]);

test('NetEase: the song is searched with its title and artist, and its lyric read as synced', async () => {
    const http = netease('[00:01.00]Hello\n[00:05.00]World');
    const found = await PROVIDERS.netease.fetch(SONG, {http});
    assert.equal(found.status, 'synced');
    assert.deepEqual(found.lines.map(line => line.text), ['Hello', 'World']);
    assert.ok(decodeURIComponent(http.urls[0]).includes('Blinding Lights The Weeknd'));
    assert.ok(http.urls[1].includes('id=7'));
});

test('NetEase: words with no times are plain; "pure music" is an instrumental; nothing is none', async () => {
    assert.equal((await PROVIDERS.netease.fetch(SONG, {http: netease('one\ntwo')})).status, 'plain');
    assert.equal((await PROVIDERS.netease.fetch(SONG, {http: netease('', {nolyric: true})})).status, 'instrumental');
    assert.equal(await PROVIDERS.netease.fetch(SONG, {http: netease('')}), null);
    assert.equal(await PROVIDERS.netease.fetch(SONG, {http: web([])}), null);
});

test('NetEase: a song with no artist is not looked up', async () => {
    const http = netease('[00:01.00]x');
    assert.equal(await PROVIDERS.netease.fetch({...SONG, artist: ''}, {http}), null);
    assert.equal(http.urls.length, 0);
});

test('NetEase: a service that is busy is a failure, not "no lyrics"', async () => {
    await assert.rejects(PROVIDERS.netease.fetch(SONG, {http: web([['/search', {status: 503}]])}),
        error => error instanceof LyricsFailure && error.kind === 'service');
});

test('NetEase: the right song among the results', () => {
    const cover = {id: 1, name: 'x', duration: 190000, artists: [{name: 'Cover Band'}]};
    const original = {id: 2, name: 'x', duration: 200000, artists: [{name: 'The Weeknd'}]};
    assert.equal(pickNeteaseSong([cover, original], 'x', 'The Weeknd', 200).id, 2);
    assert.equal(pickNeteaseSong([{...original, duration: 150000}], 'x', 'The Weeknd', 200), null);
    // The artist written another way: the same title and a length to the second.
    assert.equal(pickNeteaseSong([{id: 3, name: 'Blinding Lights', duration: 200900, artists: [{name: '威肯'}]}], 'Blinding Lights', 'The Weeknd', 200).id, 3);
});

const synced = {message: {header: {status_code: 200}, body: {subtitle: {subtitle_body: '[00:02.00]mm line'}}}};

test('Musixmatch: asked with the key, the song and its length; its subtitle is synced', async () => {
    const http = web([['matcher.subtitle.get', {body: synced}]]);
    const found = await PROVIDERS.musixmatch.fetch(SONG, {http, key: 'KEY123'});
    assert.equal(found.status, 'synced');
    assert.equal(found.lines[0].text, 'mm line');
    assert.ok(http.urls[0].includes('apikey=KEY123') && http.urls[0].includes('q_track=Blinding%20Lights') && http.urls[0].includes('f_subtitle_length=200'));
});

test('Musixmatch: with no subtitle, the words are plain and, from the free plan, partial', async () => {
    const free = {message: {header: {status_code: 200}, body: {lyrics: {lyrics_body: 'one\ntwo\n\n******* This Lyrics is NOT for Commercial use *******\n(1)'}}}};
    const http = web([['matcher.subtitle.get', {body: {message: {header: {status_code: 403}, body: {}}}}], ['matcher.lyrics.get', {body: free}]]);
    const found = await PROVIDERS.musixmatch.fetch(SONG, {http, key: 'K'});
    assert.equal(found.status, 'plain');
    assert.equal(found.partial, true);
    assert.equal(found.lines.length, 2);
});

test('Musixmatch: no key, or a refused one, is an "auth" failure', async () => {
    await assert.rejects(PROVIDERS.musixmatch.fetch(SONG, {http: web([]), key: ''}), error => error.kind === 'auth');
    const refused = web([['matcher.', {body: {message: {header: {status_code: 401}, body: []}}}]]);
    await assert.rejects(PROVIDERS.musixmatch.fetch(SONG, {http: refused, key: 'BAD'}), error => error.kind === 'auth');
});

test('Musixmatch: its notice at the end of free lyrics is cut off', () => {
    assert.deepEqual(stripMusixmatchNotice('a\nb\n\n******* This Lyrics is NOT for Commercial use *******\n(1)'), {text: 'a\nb', partial: true});
    assert.deepEqual(stripMusixmatchNotice('a\nb'), {text: 'a\nb', partial: false});
});

test('every provider has a name, and only Musixmatch needs a key', () => {
    assert.equal(PROVIDERS.lrclib.name, 'LRCLIB');
    assert.deepEqual(Object.values(PROVIDERS).filter(provider => provider.needsKey).map(provider => provider.id), ['musixmatch']);
});
