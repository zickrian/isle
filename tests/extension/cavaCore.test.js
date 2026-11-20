// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Cava's config and its output: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {buildConfig, parseFrame} from '../../gnome-extension/src/cavaCore.js';

test('the config asks for raw ascii on the standard output', () => {
    const config = buildConfig({bars: 28, smoothness: 65, source: 'pipewire'});
    for (const line of ['bars = 28', 'noise_reduction = 65', 'method = raw', 'raw_target = /dev/stdout', 'data_format = ascii',
        'ascii_max_range = 100', 'bar_delimiter = 59'])
        assert.ok(config.includes(line), line);
    assert.match(buildConfig({bars: 8, smoothness: 0, source: 'pulse'}), /\[input\]\nmethod = pulse/);
});

test('the config keeps its numbers in range', () => {
    const config = buildConfig({bars: 9999, smoothness: 500, source: 'anything'});
    assert.ok(config.includes('bars = 256') && config.includes('noise_reduction = 100') && config.includes('method = pipewire'));
});

test('a line of cava is a row of heights from 0 to 1', () => {
    assert.deepEqual(parseFrame('0;50;100;', 3), [0, 0.5, 1]);
    assert.deepEqual(parseFrame('10;20', 4), [0.1, 0.2, 0.2, 0.2]);
    assert.equal(parseFrame('1;2;3;4;5', 2).length, 2);
    assert.equal(parseFrame('250;0', 2)[0], 1);
});

test('anything else is no frame', () => {
    assert.equal(parseFrame('abc', 3), null);
    assert.equal(parseFrame('', 3), null);
    assert.equal(parseFrame(null, 3), null);
});
