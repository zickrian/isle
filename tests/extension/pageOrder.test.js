// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The open island's tab order: `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {DEFAULT_ORDER, movePage, pageOrder, storedOrder} from '../../gnome-extension/src/pageOrder.js';

test('none set is the order the tabs always had', () => {
    assert.deepEqual(pageOrder([]), DEFAULT_ORDER);
    assert.deepEqual(pageOrder(null), DEFAULT_ORDER);
    assert.deepEqual(DEFAULT_ORDER, ['music', 'notifications', 'focus', 'reminders', 'shelf', 'calendar', 'apps',
        'devices', 'usage']);
});

test('a full order is kept as it is', () => {
    const order = ['usage', 'devices', 'apps', 'music', 'notifications', 'focus', 'reminders', 'shelf', 'calendar'];
    assert.deepEqual(pageOrder(order), order);
});

test('unknown names and repeats are dropped; the call never moves', () => {
    assert.deepEqual(pageOrder(['calendar', 'call', 'nope', 'calendar', 'music']),
        ['calendar', 'apps', 'devices', 'usage', 'music', 'notifications', 'focus', 'reminders', 'shelf']);
});

test('a page left out goes after the one it follows by default, or first', () => {
    const defaults = ['a', 'b', 'c', 'd'];
    assert.deepEqual(pageOrder(['d', 'b'], defaults), ['a', 'd', 'b', 'c']);
    assert.deepEqual(pageOrder(['c', 'a'], defaults), ['c', 'd', 'a', 'b']);
    // A page new in a later version, missing from an order stored before it.
    assert.deepEqual(pageOrder(['b', 'a', 'c'], defaults), ['b', 'a', 'c', 'd']);
});

test('moving swaps with the neighbour and stops at the ends', () => {
    const order = ['a', 'b', 'c'];
    assert.deepEqual(movePage(order, 'b', -1), ['b', 'a', 'c']);
    assert.deepEqual(movePage(order, 'b', 1), ['a', 'c', 'b']);
    assert.deepEqual(movePage(order, 'a', -1), order);
    assert.deepEqual(movePage(order, 'c', 1), order);
    assert.deepEqual(movePage(order, 'x', 1), order);
    assert.deepEqual(order, ['a', 'b', 'c'], 'the order given is left alone');
});

test('the default order is stored as none, so it follows Isle', () => {
    assert.deepEqual(storedOrder(DEFAULT_ORDER), []);
    assert.deepEqual(storedOrder(movePage(DEFAULT_ORDER, 'calendar', 1)),
        ['music', 'notifications', 'focus', 'reminders', 'shelf', 'apps', 'calendar', 'devices', 'usage']);
});
