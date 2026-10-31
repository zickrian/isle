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
