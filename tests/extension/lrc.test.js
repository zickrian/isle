// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Synced lyrics in LRC: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {parse, plain} from '../../gnome-extension/src/lrc.js';

test('lines are read with their times, metadata and untimed lines skipped', () => {
    assert.deepEqual(parse('[ar:Someone]\n[00:01.50]Hello\n[00:03.250]World\nno time'),
        [{time_ms: 1500, text: 'Hello'}, {time_ms: 3250, text: 'World'}]);
});

test('one line with several times is repeated, and the lines come out sorted', () => {
    assert.deepEqual(parse('[00:10.00][00:02.00]Chorus\n[00:05.00]Verse').map(line => line.time_ms), [2000, 5000, 10000]);
});

test('an offset moves every line, and never before the start', () => {
    assert.deepEqual(parse('[offset:500]\n[00:01.00]A').map(line => line.time_ms), [500]);
    assert.deepEqual(parse('[offset:5000]\n[00:01.00]A').map(line => line.time_ms), [0]);
});

test('an empty line is kept: a pause', () => {
    assert.deepEqual(parse('[00:01.00]\n[00:02.00]x'), [{time_ms: 1000, text: ''}, {time_ms: 2000, text: 'x'}]);
});

test('times that cannot be real are skipped', () => {
    assert.deepEqual(parse('[99:99.99]a\n[00:61.00]b\n[-1:00.00]c'), []);
});

test('tenths, hundredths and thousandths are all fractions of a second', () => {
    assert.deepEqual(parse('[00:01.5][00:01.50][00:01.500][00:01.5009]x').map(line => line.time_ms), [1500, 1500, 1500, 1500]);
    assert.equal(parse('[01:02]x')[0].time_ms, 62000);
});

test('line breaks of both kinds are read', () => {
    assert.equal(parse('[00:01.00]a\r\n[00:02.00]b\r\n').length, 2);
});

test('unsynced lyrics split into lines with no time, and no empty line after the last break', () => {
    assert.deepEqual(plain('a\n b \n').map(line => [line.time_ms, line.text]), [[-1, 'a'], [-1, 'b']]);
});
