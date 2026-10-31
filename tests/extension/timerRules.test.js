// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The timer's typed lengths: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {typedMinutes} from '../../gnome-extension/src/timerRules.js';

test('a typed length is kept within its stepper', () => {
    assert.equal(typedMinutes('45', 1, 180), 45);
    assert.equal(typedMinutes(' 7 ', 1, 60), 7);
    assert.equal(typedMinutes('0', 1, 180), 1);
    assert.equal(typedMinutes('240', 1, 180), 180);
});

test('anything but digits is no length', () => {
    assert.equal(typedMinutes('', 1, 180), null);
    assert.equal(typedMinutes('4m', 1, 180), null);
    assert.equal(typedMinutes('+5', 1, 180), null);
    assert.equal(typedMinutes('–', 1, 180), null);
});
