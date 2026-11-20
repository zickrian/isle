// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The parts of cava's bars that are only sums: its config and its output (the colours of the bars are in barColors.js).

/** Cava's config for `bars` bars, written as text: it prints each frame as numbers on a line, to its standard output. */
export function buildConfig({bars, smoothness, source}) {
    const clamp = (value, low, high) => Math.min(high, Math.max(low, Math.round(Number(value) || 0)));
    return `[general]
bars = ${clamp(bars, 1, 256)}
framerate = 30
autosens = 1

[input]
method = ${source === 'pulse' ? 'pulse' : 'pipewire'}
source = auto

[output]
method = raw
raw_target = /dev/stdout
data_format = ascii
ascii_max_range = 100
bar_delimiter = 59
frame_delimiter = 10
channels = mono

[smoothing]
noise_reduction = ${clamp(smoothness, 0, 100)}
`;
}

/** One line of cava's output as `bars` heights between 0 and 1, or null if it is not a frame. */
export function parseFrame(line, bars) {
    if (typeof line !== 'string')
        return null;
    const parts = line.trim().split(';').filter(part => part !== '');
    if (!parts.length)
        return null;
    const heights = parts.map(part => Number(part) / 100);
    if (heights.some(height => !Number.isFinite(height)))
        return null;
    // Whatever cava made of it, as many as there are bars on screen.
    return Array.from({length: bars}, (_, i) => Math.min(1, Math.max(0, heights[Math.min(i, heights.length - 1)])));
}
