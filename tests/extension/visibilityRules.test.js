// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// When the closed island auto-hides: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {autoHide, revealBand} from '../../gnome-extension/src/visibilityRules.js';

const closed = {mode: 'always', presentation: 'compact', visible: true, hovered: false, fullscreen: false,
    barHidden: false, windowAtTop: false};

test('only a closed island on screen hides, after the wait, with the pointer away', () => {
    assert.equal(autoHide(closed), 'later');
    assert.equal(autoHide({...closed, mode: 'off'}), false);
    assert.equal(autoHide({...closed, presentation: 'peek'}), false);
    assert.equal(autoHide({...closed, presentation: 'expanded'}), false);
    assert.equal(autoHide({...closed, presentation: 'voice'}), false);
    assert.equal(autoHide({...closed, hovered: true}), false);
    assert.equal(autoHide({...closed, visible: false}), false);
});

test('with the top bar, it hides at once as the bar goes and shows as it comes back', () => {
    assert.equal(autoHide({...closed, mode: 'top-bar', barHidden: true}), 'now');
    assert.equal(autoHide({...closed, mode: 'top-bar', barHidden: true, hovered: true}), 'now');
    assert.equal(autoHide({...closed, mode: 'top-bar', barHidden: false}), false);
    // An alert still shows while the bar is away.
    assert.equal(autoHide({...closed, mode: 'top-bar', barHidden: true, presentation: 'peek'}), false);
});

test('beside windows, it hides only while a window reaches the top', () => {
    assert.equal(autoHide({...closed, mode: 'windows', windowAtTop: false}), false);
    assert.equal(autoHide({...closed, mode: 'windows', windowAtTop: true}), 'later');
    assert.equal(autoHide({...closed, mode: 'windows', windowAtTop: true, hovered: true}), false);
});

test('over a full-screen app it hides at once, whatever the mode, and alerts still show', () => {
    for (const mode of ['off', 'always', 'top-bar', 'windows']) {
        assert.equal(autoHide({...closed, mode, fullscreen: true}), 'now');
        assert.equal(autoHide({...closed, mode, fullscreen: true, hovered: true}), 'now');
        assert.equal(autoHide({...closed, mode, fullscreen: true, presentation: 'peek'}), false);
    }
});

test('the hidden island takes the pointer only where it can come back from', () => {
    assert.equal(revealBand({mode: 'always', fullscreen: false, barHeight: 32, edge: 2}), 32);
    assert.equal(revealBand({mode: 'windows', fullscreen: false, barHeight: 0, edge: 2}), 2);
    assert.equal(revealBand({mode: 'always', fullscreen: true, barHeight: 32, edge: 2}), 0);
    assert.equal(revealBand({mode: 'top-bar', fullscreen: false, barHeight: 32, edge: 2}), 0);
});
