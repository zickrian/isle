// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// When the closed island auto-hides: no GNOME imports, so it can be tested without a shell.

/**
 * Whether the island should be on its way out: auto-hide on, resting closed, on screen, the pointer away,
 * and (with "only when an app fills the screen") the app in front filling the island's display.
 */
export function autoHideWanted({enabled, fullscreenOnly, appFillsScreen, presentation, hovered, visible}) {
    return Boolean(enabled && visible && presentation === 'compact' && !hovered &&
        (!fullscreenOnly || appFillsScreen));
}
