// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Cleaning a track's title and artist for a lyrics search: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {fullTitle, searchTerms} from '../../gnome-extension/src/trackTerms.js';

test('a plain title and artist are left alone', () => {
    assert.deepEqual(searchTerms('Paper Sky', 'Lumen Coast'), ['Paper Sky', 'Lumen Coast']);
});

test('"Artist - Song (Official Video)" by a channel is split', () => {
    assert.deepEqual(searchTerms('Lumen Coast - Paper Sky (Official Video)', 'LumenCoastVEVO'), ['Paper Sky', 'Lumen Coast']);
    assert.deepEqual(searchTerms('Lumen Coast - Paper Sky [4K]', ''), ['Paper Sky', 'Lumen Coast']);
});

test('a topic channel and a featured artist are dropped', () => {
    assert.deepEqual(searchTerms('Paper Sky ft. Someone', 'Lumen Coast - Topic'), ['Paper Sky', 'Lumen Coast']);
});

test('what follows a bar is the uploader\'s branding', () => {
    assert.deepEqual(searchTerms('Lumen Coast - Paper Sky (Lyrics) | Night Drive', 'Lyric Hub'), ['Lumen Coast - Paper Sky', 'Lyric Hub']);
    assert.equal(fullTitle('Lumen Coast - Paper Sky (Lyrics) | Night Drive'), 'Lumen Coast - Paper Sky');
});

test('brackets that are part of the title stay', () => {
    assert.equal(searchTerms('Song (Acoustic)', 'A')[0], 'Song (Acoustic)');
});

test('a dash in a real title is not an artist', () => {
    assert.equal(searchTerms('Part 1 - Intro', 'Band')[0], 'Part 1 - Intro');
});
