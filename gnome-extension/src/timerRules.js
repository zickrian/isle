// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The timer's typed lengths, kept apart so tests run it anywhere (tests/).

/** The minutes typed in `text`, kept to `min`..`max`; null when it holds no number. */
export function typedMinutes(text, min, max) {
    const trimmed = String(text).trim();
    if (!/^\d+$/.test(trimmed))
        return null;
    return Math.min(max, Math.max(min, Number.parseInt(trimmed, 10)));
}
