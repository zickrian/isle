// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// When the closed island auto-hides: no GNOME imports, so it can be tested without a shell.

/** When the closed island on screen hides ('now', 'later' after Settings' wait, or false) for `mode` (off, always,
 * top-bar or windows); at once over a full-screen app, unless `revealInFullscreen` holds it shown while `hovered`. */
export function autoHide({mode, presentation, visible, hovered, fullscreen, revealInFullscreen = false, barHidden, windowAtTop}) {
    if (!visible || presentation !== 'compact')
        return false;
    if (fullscreen)
        return revealInFullscreen && hovered ? false : 'now';
    if (mode === 'top-bar' && barHidden)
        return 'now';
    if (hovered)
        return false;
    if (mode === 'always' || (mode === 'windows' && windowAtTop))
        return 'later';
    return false;
}

/** How much of the hidden island's top takes the pointer to bring it back, in px: `edge` over a full-screen app when
 * `revealInFullscreen` is on (else none), none with a hidden bar (that bar comes back first), else the bar's band, or
 * `edge` at a display's top. */
export function revealBand({mode, fullscreen, revealInFullscreen = false, barHeight, edge}) {
    if (fullscreen)
        return revealInFullscreen ? edge : 0;
    if (mode === 'top-bar')
        return 0;
    return Math.max(barHeight, edge);
}
