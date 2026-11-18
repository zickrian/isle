// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The order of the open island's tabs (Settings → Island → Pages), needing nothing of GNOME, kept apart so tests
// run it anywhere (tests/). The Call tab is not among them: it comes first, and only during a call.

/** The pages that can be moved, in the order they had before it was a setting: the order with none set. */
export const DEFAULT_ORDER = ['music', 'notifications', 'focus', 'reminders', 'shelf', 'calendar', 'apps', 'devices',
    'usage'];

/**
 * `wanted` (the `page-order` setting) made whole: names not in `defaults` and repeats are dropped, and each page it
 * leaves out (one new in this version, say) goes back after the page it follows by default, or first.
 */
export function pageOrder(wanted, defaults = DEFAULT_ORDER) {
    const order = [];
    for (const name of wanted ?? []) {
        if (defaults.includes(name) && !order.includes(name))
            order.push(name);
    }
    defaults.forEach((name, index) => {
        if (order.includes(name))
            return;
        const before = defaults.slice(0, index).findLast(other => order.includes(other));
        order.splice(before === undefined ? 0 : order.indexOf(before) + 1, 0, name);
    });
    return order;
}

/** `order` with `name` swapped with its neighbour `step` (±1) away; the same order at either end. */
export function movePage(order, name, step) {
    const from = order.indexOf(name);
    const to = from + step;
    if (from < 0 || to < 0 || to >= order.length)
        return [...order];
    const moved = [...order];
    [moved[from], moved[to]] = [moved[to], moved[from]];
    return moved;
}

/** What to store for `order`: none (the default, which then follows Isle's own) when it is the default order. */
export function storedOrder(order, defaults = DEFAULT_ORDER) {
    const whole = pageOrder(order, defaults);
    return whole.join() === defaults.join() ? [] : whole;
}
