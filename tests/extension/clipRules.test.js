// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// How clipboard cards show thumbnails: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {thumbSize} from '../../gnome-extension/src/clipRules.js';

test('a full thumbnail covers the card at 1× and 2×', () => {
    assert.equal(thumbSize(272, 216, 1), 'cover');
    assert.equal(thumbSize(272, 216, 2), 'cover');
    // Past 2× it still fills the card, a little soft.
    assert.equal(thumbSize(272, 216, 3), 'cover');
});

test('a thin strip is shown at its own pixels, not blown up', () => {
    // 1913×56 becomes 272×56: 56 rows never stretched to the card's height.
    assert.equal(thumbSize(272, 56, 1), '272px');
    assert.equal(thumbSize(272, 56, 2), '136px');
});

test('a short screenshot covers at 1× and keeps its pixels at 2×', () => {
    // 417×137 becomes 272×137.
    assert.equal(thumbSize(272, 137, 1), 'cover');
    assert.equal(thumbSize(272, 137, 2), '136px');
    assert.equal(thumbSize(272, 137, 1.5), '181px');
});

test('a tall image is sized by its height', () => {
    assert.equal(thumbSize(100, 216, 1), 'auto 216px');
    assert.equal(thumbSize(100, 216, 2), 'auto 108px');
});

test('a small icon stays its own size', () => {
    assert.equal(thumbSize(32, 32, 1), '32px');
    assert.equal(thumbSize(32, 32, 2), '16px');
});

test("an older isled's thumbnail covers, as before", () => {
    assert.equal(thumbSize(undefined, undefined, 2), 'cover');
    assert.equal(thumbSize(null, null, 1), 'cover');
});
