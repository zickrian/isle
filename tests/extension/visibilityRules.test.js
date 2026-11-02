// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// When the closed island auto-hides: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {autoHideWanted} from '../../gnome-extension/src/visibilityRules.js';

const closed = {enabled: true, fullscreenOnly: false, appFillsScreen: false, presentation: 'compact',
    hovered: false, visible: true};

test('auto-hide sends only a closed, visible island with the pointer away', () => {
    assert.equal(autoHideWanted(closed), true);
    assert.equal(autoHideWanted({...closed, enabled: false}), false);
    assert.equal(autoHideWanted({...closed, presentation: 'peek'}), false);
    assert.equal(autoHideWanted({...closed, presentation: 'expanded'}), false);
    assert.equal(autoHideWanted({...closed, hovered: true}), false);
    assert.equal(autoHideWanted({...closed, visible: false}), false);
});

test('the fullscreen-only setting keeps the island out of the way only over a filled screen', () => {
    assert.equal(autoHideWanted({...closed, fullscreenOnly: true, appFillsScreen: false}), false);
    assert.equal(autoHideWanted({...closed, fullscreenOnly: true, appFillsScreen: true}), true);
    assert.equal(autoHideWanted({...closed, fullscreenOnly: false, appFillsScreen: false}), true);
});
