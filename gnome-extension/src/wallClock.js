// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The time of day as GNOME's own clock keeps it: each minute, on waking from suspend, and when the time
// zone or the 12/24-hour setting changes. One clock for the whole island, made while anything watches it.

import GnomeDesktop from 'gi://GnomeDesktop';

let clock = null;
const callbacks = new Set();

/** Calls `callback` whenever the time shown should change; returns how to stop. */
export function watchClock(callback) {
    clock ??= new GnomeDesktop.WallClock({time_only: true});
    callbacks.add(callback);
    const id = clock.connect('notify::clock', () => callback());
    let stopped = false;
    return () => {
        if (stopped)
            return;
        stopped = true;
        callbacks.delete(callback);
        clock.disconnect(id);
        if (callbacks.size === 0) {
            clock.run_dispose();
            clock = null;
        }
    };
}

/** Shows every clock again now: Isle's own 12/24-hour setting changed. */
export function refreshClocks() {
    [...callbacks].forEach(callback => callback());
}
