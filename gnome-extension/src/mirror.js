// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// With the island on every display (Settings: Display), each display has a copy of it: the closed island
// and the alerts, as the island shows them. Only the island itself opens; pointing at a copy brings it
// there, in the copy's place, so the copy only ever shows.

import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {isWayland} from './compat.js';
import {CompactView} from './compact.js';
import {Island} from './island.js';
import {PeekView} from './peek.js';

/** A copy of the island on one display: a closed view and two alert views (taking turns, as the island's do). */
export class MirrorIsland {
    /** `services` are what the closed view watches; `onHover` runs as the pointer comes onto the copy or leaves it,
     * `onRelease` as a click or a tap on it ends, `onResize` as its closed view changes width, `onShown` as it
     * shows again, and `onClose` for the × on an alert. */
    constructor(monitor, {daemon, settings, privacy, call}, {onHover, onRelease, onResize, onShown, onClose}) {
        this.monitor = monitor;
        this._settings = settings;
        this._onShown = onShown;
        /** Whether the island is elsewhere, so the copy shows; a fullscreen window may still hide it. */
        this._shown = false;
        /** Whether auto-hide has faded it away (see the controller's `_syncAutoHide`), and the name of its wait. */
        this.autoHidden = false;
        this.autoHideKey = `auto-hide-${monitor.index}`;
        /** The alert whose glow it shows (see the controller's `_tintMirror`). */
        this.glowAlert = null;
        this.island = new Island();
        this.compact = new CompactView(daemon, settings, privacy, call);
        this._peeks = [new PeekView(), new PeekView()];
        this.peek = this._peeks[0];
        for (const view of [this.compact, ...this._peeks])
            this.island.addView(view);
        this.island.monitor = monitor;
        this.island.visible = false;
        // Not tracking fullscreen windows as the island does: the copy is hidden by hand as well (see `shown`).
        Main.layoutManager.addChrome(this.island);

        this.island.connect('notify::hovered', () => onHover(this));
        // A click or tap without a hover first (a finger moves no pointer): the island comes for it as it ends.
        // Not as it starts: hiding the copy then would cancel a touch, its end never heard.
        this.island.connect('button-press-event', () => Clutter.EVENT_STOP);
        this.island.connect('button-release-event', (_actor, event) => onRelease(this, event));
        this.island.connect('touch-event', (_actor, event) =>
            event.type() === Clutter.EventType.TOUCH_END ? onRelease(this, event) : Clutter.EVENT_STOP);
        this.compact.connect('width-changed', () => onResize(this));
        for (const peek of this._peeks)
            peek.connect('close-requested', onClose);
        // GNOME's rule for chrome over a fullscreen window (layout.js `_updateActorVisibility`), here.
        this._fullscreenChanged = global.display.connect('in-fullscreen-changed', () => this._syncVisible());
        this._windowsShown = global.window_group.connect('notify::visible', () => this._syncVisible());
        this._overFullscreenChanged = settings.connect('changed::alerts-over-fullscreen', () => this._syncVisible());
        // Also when GNOME Shell shuts down, taking it with the stage before Isle is turned off.
        this.island.connect('destroy', () => this._onDestroy());
    }

    /** Its alert views, both. */
    get peeks() {
        return this._peeks;
    }

    /** Whether the copy shows: not on the island's own display. */
    get shown() {
        return this._shown;
    }

    set shown(shown) {
        this._shown = shown;
        this._syncVisible();
    }

    /** Fills the next alert view, or the one on show with `inPlace` (the volume moving), as the island's own. */
    setAlert(alert, onDone, {inPlace = false, turn = false} = {}) {
        if (turn)
            this.peek = this._peeks[1 - this._peeks.indexOf(this.peek)];
        this.peek.setAlert(alert, onDone, {fresh: !inPlace});
    }

    /** Fades it out or back as the island's auto-hide does (see Island.setAutoHidden); `onBar`, on the main display
     * in its top bar. Whether that changed. */
    setAutoHidden(hidden, band, onBar) {
        this.island.setAutoHidden(hidden, band);
        if (hidden === this.autoHidden)
            return false;
        this.autoHidden = hidden;
        // On X11, out of the input region in the bar, as the island (the controller's `_chromeParams`).
        if (!isWayland()) {
            Main.layoutManager.untrackChrome(this.island);
            Main.layoutManager.trackChrome(this.island, {affectsInputRegion: !hidden || !onBar});
        }
        return true;
    }

    /** Hidden over a fullscreen window, as the island is, unless Settings show alerts over it (auto-hide then hides
     * the closed copy). Shown again, it is measured afresh (out of sight, an alert's lines are not fitted) and takes
     * its shape at once: what it showed out of sight did not animate. */
    _syncVisible() {
        const overFullscreen = this._settings.get_boolean('alerts-over-fullscreen');
        const visible = this._shown && (overFullscreen || !(global.window_group.visible && this.monitor.inFullscreen));
        if (visible === this.island.visible)
            return;
        this.island.visible = visible;
        // Hidden under the pointer, it heard no leave: it was hovered no more.
        if (!visible) {
            this.island.syncHover();
            return;
        }
        this._onShown(this);
        this.island.settle({views: true});
    }

    destroy() {
        // Its views watch the services, and go with it.
        if (!this._destroyed)
            this.island.destroy();
    }

    _onDestroy() {
        this._destroyed = true;
        this._shown = false;
        global.display.disconnect(this._fullscreenChanged);
        global.window_group.disconnect(this._windowsShown);
        this._settings.disconnect(this._overFullscreenChanged);
    }
}
