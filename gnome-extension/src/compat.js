// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The few places GNOME Shell 46 to 51 differ for Isle, so the rest of the
// code reads the same on all of them.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import St from 'gi://St';

import {PACKAGE_VERSION} from 'resource:///org/gnome/shell/misc/config.js';

const SHELL_MAJOR = parseInt(PACKAGE_VERSION, 10);

/** Vertical box params: GNOME 48 added `orientation`, GNOME 51 dropped `vertical`. */
export const VERTICAL = SHELL_MAJOR >= 48
    ? {orientation: Clutter.Orientation.VERTICAL}
    : {vertical: true};

/** Clutter's backend; GNOME 51 only reaches it through the stage's context. */
export function clutterBackend() {
    return Clutter.get_default_backend
        ? Clutter.get_default_backend()
        : global.stage.context.get_backend();
}

/** Whether `grab` (from `Main.pushModal`) holds the keyboard; GNOME 50 dropped `get_seat_state`. */
export function grabsKeyboard(grab) {
    if (grab.get_seat_state)
        return Boolean(grab.get_seat_state() & Clutter.GrabState.KEYBOARD);
    return !grab.is_revoked();
}

/** Maximizes `window`; GNOME 49 dropped the flags (its `Meta.MaximizeFlags` is still there, so test the version). */
export function maximize(window) {
    return SHELL_MAJOR >= 49 ? window.maximize() : window.maximize(Meta.MaximizeFlags.BOTH);
}

/** Unmaximizes `window`; see `maximize`. */
export function unmaximize(window) {
    return SHELL_MAJOR >= 49 ? window.unmaximize() : window.unmaximize(Meta.MaximizeFlags.BOTH);
}

/** Stops a window that covers a whole display going straight to the screen (scanout or X11 unredirection)
 * past what is drawn over it; `false` allows it again. Counted, so keep calls paired; GNOME 48 moved it. */
export function inhibitScanout(inhibit) {
    if (SHELL_MAJOR >= 48) {
        if (inhibit)
            global.compositor.disable_unredirect();
        else
            global.compositor.enable_unredirect();
    } else if (inhibit) {
        Meta.disable_unredirect_for_display(global.display);
    } else {
        Meta.enable_unredirect_for_display(global.display);
    }
}

/** The actor `event` is for: the stage says where it can, as `Clutter.Event.get_source` is going from Clutter. */
export function eventActor(event) {
    return global.stage.get_event_actor?.(event) ?? event.get_source?.() ?? null;
}

/** Whether the shell runs on Wayland; GNOME 50 dropped X11 and the check. */
export function isWayland() {
    return Meta.is_wayland_compositor?.() ?? true;
}

let interfaceSettings = null;

/** GNOME desktop interface settings (`org.gnome.desktop.interface`). */
export function getInterfaceSettings() {
    try {
        interfaceSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
        return interfaceSettings;
    } catch {
        return null;
    }
}

/** The text/font scaling factor from GNOME Tweaks or Accessibility (e.g. 0.7, 1.0, 1.25). */
export function textScale() {
    return getInterfaceSettings()?.get_double('text-scaling-factor') || 1.0;
}

/** Stage pixels per CSS pixel for St's CSS engine (1 on 100%, 2 on 200%). Used for CSS style conversions. */
export function stageScale() {
    return St.ThemeContext.get_for_stage(global.stage).scale_factor;
}

/** Stage pixels per CSS pixel: 2 on a 200% display GNOME 46 to 49 lay out in physical pixels, else 1.
 * St scales what CSS sizes, never what code sets: that takes `px`. */
export function uiScale() {
    return stageScale();
}

/** `n` CSS pixels in stage pixels, taking into account display scale. */
export function px(n) {
    return Math.round(n * uiScale());
}

/** An icon size (in CSS pixels for St.Icon.icon_size) scaled by GNOME's text/desktop scaling factor. */
export function iconSize(n) {
    return Math.max(1, Math.round(n * textScale()));
}

/** Calls `apply(scale)` now (unless `now` is false) and whenever `uiScale` changes, while `actor` lives:
 * before the next frame, once St restyled for the new scale, so what is measured then is right. */
export function onUiScale(actor, apply, {now = true} = {}) {
    const context = St.ThemeContext.get_for_stage(global.stage);
    const settings = getInterfaceSettings();
    if (now)
        apply(uiScale());
    const laters = global.compositor.get_laters();
    let later = 0;
    const notify = () => {
        later ||= laters.add(Meta.LaterType.BEFORE_REDRAW, () => {
            later = 0;
            apply(uiScale());
            return false;
        });
    };
    const contextId = context.connect('notify::scale-factor', notify);
    const settingsId = settings?.connect('changed::text-scaling-factor', notify);
    actor.connect('destroy', () => {
        context.disconnect(contextId);
        if (settingsId && settings)
            settings.disconnect(settingsId);
        if (later)
            laters.remove(later);
    });
}
