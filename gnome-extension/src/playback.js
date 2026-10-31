// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Helpers for the daemon's `NowPlaying` and `Lyrics` state.

import {DesktopAppInfo} from './appInfo.js';
import {nowMs} from './format.js';

/** Whether a player is up and playing right now. */
export function isPlaying(nowPlaying) {
    return nowPlaying?.available && nowPlaying.status === 'Playing';
}

/** Whether a player is up with a titled track, playing or paused. */
export function hasTrack(nowPlaying) {
    return nowPlaying?.available && Boolean(nowPlaying.title);
}

/** The speed it plays at; 0 while isled sees it buffering, though the player says it plays. */
function rateOf(nowPlaying) {
    return nowPlaying.rate ?? 1;
}

/** The playback position now (ms), advanced in real time from the daemon's last sample while playing. */
export function positionMs(nowPlaying) {
    if (!nowPlaying?.available)
        return 0;
    let position = nowPlaying.position_us / 1000;
    if (nowPlaying.status === 'Playing')
        position += (nowMs() - nowPlaying.sampled_at_ms) * rateOf(nowPlaying);
    const length = nowPlaying.length_us / 1000;
    return length > 0 ? Math.min(Math.max(position, 0), length) : Math.max(position, 0);
}

/** The track's length in ms, 0 when unknown. */
export function lengthMs(nowPlaying) {
    return (nowPlaying?.length_us ?? 0) / 1000;
}

/** Index of the line being sung at `position`, or -1 before the first line. */
export function lineIndexAt(lines, position) {
    let low = 0;
    let high = lines.length - 1;
    let found = -1;
    while (low <= high) {
        const middle = (low + high) >> 1;
        if (lines[middle].time_ms <= position) {
            found = middle;
            low = middle + 1;
        } else {
            high = middle - 1;
        }
    }
    return found;
}

/** Milliseconds until the line after `index` starts at the current playback speed, or null if none (or stalled). */
export function msUntilLine(nowPlaying, lines, index) {
    const next = lines[index + 1];
    const rate = rateOf(nowPlaying);
    if (!next || !(rate > 0))
        return null;
    return Math.max(0, (next.time_ms - positionMs(nowPlaying)) / rate);
}

/** The playing app per player, looked up once: `desktop_entry|identity`. */
const playerApps = new Map();
/** Players remembered at most; the oldest goes first. */
const MAX_PLAYER_APPS = 20;

/** The playing app, from the player's desktop entry or else its name (Chrome gives only "Chrome"); or null. */
export function playerApp({desktop_entry: entry, identity}) {
    const key = `${entry}|${identity}`;
    if (!playerApps.has(key)) {
        const ids = [];
        if (entry)
            ids.push(`${entry}.desktop`);
        if (identity)
            ids.push(...DesktopAppInfo.search(identity).flat());
        let app = null;
        for (const id of ids) {
            app = DesktopAppInfo.new(id);
            if (app)
                break;
        }
        if (playerApps.size >= MAX_PLAYER_APPS)
            playerApps.delete(playerApps.keys().next().value);
        playerApps.set(key, app);
    }
    return playerApps.get(key);
}
