// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// How a clipboard card shows its image's thumbnail, kept apart so tests run it anywhere (tests/).

/** The card's picture in CSS px: `.isle-clip` inside its border, as tall as the Shelf page leaves it
 * (about 105). isled makes thumbnails at twice that (THUMB_WIDTH in its clipboard.rs) or smaller. */
export const CARD_PICTURE = [136, 108];
const THUMB_SCALE = 2;

/** The `background-size` for a `width`×`height` px thumbnail at `density` screen pixels per CSS px:
 * `cover` when it has the pixels for that, else one of its pixels per screen pixel, never blown up. */
export function thumbSize(width, height, density) {
    // An older isled's thumbnail, of no known size.
    if (!(width > 0 && height > 0))
        return 'cover';
    // Past 2× they show as at 2×: a little soft, never smaller.
    const scale = Math.min(Math.max(density, 1), THUMB_SCALE);
    const cover = Math.max(CARD_PICTURE[0] / width, CARD_PICTURE[1] / height);
    if (cover * scale <= 1 + 1e-6)
        return 'cover';
    // St rounds lengths to whole CSS px: the longer side, so the image keeps its shape best.
    return width >= height ? `${Math.round(width / scale)}px` : `auto ${Math.round(height / scale)}px`;
}

/** Next selected card index for an arrow step (`dx` for ←/→, `dy` for ↑/↓) in a `columns`-wide grid. */
export function stepSelection(current, count, {dx = 0, dy = 0} = {}, {vertical = false, columns = 1} = {}) {
    if (count <= 0)
        return 0;
    const clamped = Math.min(count - 1, Math.max(0, current));
    const cols = vertical ? Math.max(1, columns) : 1;
    if (cols === 1)
        return Math.min(count - 1, Math.max(0, clamped + dx + dy));
    if (dx !== 0)
        return Math.min(count - 1, Math.max(0, clamped + dx));
    if (dy < 0)
        return clamped >= cols ? clamped - cols : clamped;
    if (dy > 0) {
        const row = Math.floor(clamped / cols);
        const lastRow = Math.floor((count - 1) / cols);
        if (row >= lastRow)
            return clamped;
        return Math.min(count - 1, clamped + cols);
    }
    return clamped;
}
