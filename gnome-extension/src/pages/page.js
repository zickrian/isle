// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Base class for the pages of the expanded island.

import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {onUiScale} from '../compat.js';

/** Subclasses override the getters and hooks below; timeouts and daemon handlers end with the page. */
export const Page = GObject.registerClass({
    Signals: {
        // The page needs keyboard input (true) or is done with it (false).
        'request-keyboard': {param_types: [GObject.TYPE_BOOLEAN]},
        // `preferredWidth` changed.
        'width-changed': {},
        // `tint` changed.
        'tint-changed': {},
        // A 'aura' tint moved: time (s), level (0..1); see `Island.setTintMotion`.
        'tint-motion': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
        // The user did something that should close the island.
        'request-close': {},
        // `hasNews` changed.
        'news-changed': {},
        // `available` changed.
        'availability-changed': {},
        // Changed out of sight: worth laying out before it is next shown (see `markCold`).
        'cold': {},
    },
}, class Page extends St.Widget {
    /** `params.height` is in CSS pixels (see `px`). */
    _init(daemon, {height, ...params}) {
        super._init(params);
        if (height !== undefined)
            onUiScale(this, scale => (this.height = height * scale));
        this.daemon = daemon;
        this._active = false;
        this._timeouts = new Map();
        /** Timeouts that outlive the page going off screen (see `later`'s `keep`). */
        this._kept = new Set();
        this._daemonHandlers = [];
        /** Whether it changed since last laid out out of sight (see `Expanded.warmPage`). */
        this.cold = true;
        this.connect('destroy', () => this._onPageDestroy());
    }

    /** Pages only animate and poll while they are on screen. */
    setActive(active) {
        if (active === this._active)
            return;
        this._active = active;
        if (active) {
            this.onActivate();
        } else {
            this.onDeactivate();
            for (const name of [...this._timeouts.keys()]) {
                if (!this._kept.has(name))
                    this.cancel(name);
            }
        }
    }

    /** Whether the page is on screen now. */
    get active() {
        return this._active;
    }

    /** Whether the page has a tab now; the Call page only has one during a call. */
    get available() {
        return !this._hidden;
    }

    /** Left out of the island in Settings: no tab, so never shown. */
    get hidden() {
        return Boolean(this._hidden);
    }

    /** Emits `availability-changed`, so the tab comes or goes. */
    set hidden(hidden) {
        if (Boolean(this._hidden) === hidden)
            return;
        this._hidden = hidden;
        this.emit('availability-changed');
        // Changed while left out: laid out ahead now that it can be shown again.
        if (!hidden && this.cold)
            this.emit('cold');
    }

    /** Whether the page has something to show; used to pick a default page. */
    get relevant() {
        return false;
    }

    /** Whether something new waits here; its tab shows a dot. */
    get hasNews() {
        return false;
    }

    /** Island width this page needs, or null for the standard width. */
    get preferredWidth() {
        return null;
    }

    /** RGB colour to wash the island with, or null. */
    get tint() {
        return null;
    }

    /** How `tint` colours the island: 'wash', 'glow' or 'aura' (see `Island.setTint`). */
    get tintStyle() {
        return 'wash';
    }

    /** While the island widens to the page, `past` px of the page's right side are still past its edge; 0 once
     * it all fits. */
    uncover(_past) {}

    /** Called as the page comes on screen. */
    onActivate() {}

    /** Called as it goes; timeouts not kept are cancelled right after. */
    onDeactivate() {}

    /** Readies, while shown out of sight, what its showing would build (see `Expanded.warmPage`). */
    warmUp() {}

    /** Puts away what `warmUp` showed. */
    coolDown() {}

    /** Whether it is also built ahead while the island is open on another page (see `Expanded._openWarmStep`). */
    get warmsOpen() {
        return false;
    }

    /** Notes a change made out of sight: its next showing would style and lay it out in the frames it animates.
     * `force` for a change in a part of it not shown (lyrics behind the player), though the page is. */
    markCold({force = false} = {}) {
        if (this.cold || (this.mapped && !force))
            return;
        this.cold = true;
        // Left out, it is never shown: nothing to lay out until it is back.
        if (!this.hidden)
            this.emit('cold');
    }

    /** Calls `callback` whenever one of the daemon's `keys` changes. */
    watch(keys, callback) {
        this._daemonHandlers.push(this.daemon.connect('changed', (_daemon, key) => {
            if (keys.includes(key)) {
                callback();
                this.markCold();
            }
        }));
    }

    /** Runs `callback` after `ms`, replacing any pending timeout of the same name; with `keep`, also while
     * the page is off screen. */
    later(name, ms, callback, {keep = false} = {}) {
        this.cancel(name);
        if (keep)
            this._kept.add(name);
        else
            this._kept.delete(name);
        // An await that ends after the page went (the extension turned off) schedules nothing.
        if (this._destroyed)
            return;
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms)), () => {
            this._timeouts.delete(name);
            this._kept.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this._timeouts.set(name, id);
    }

    /** Drops the pending timeout of that name, if any. */
    cancel(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
        this._kept.delete(name);
    }

    /** Drops every pending timeout, kept ones too. */
    cancelAll() {
        for (const name of [...this._timeouts.keys()])
            this.cancel(name);
    }

    /** Stops timers and daemon handlers, and stops `later` from scheduling more. */
    _onPageDestroy() {
        this._destroyed = true;
        this.cancelAll();
        for (const id of this._daemonHandlers)
            this.daemon.disconnect(id);
        this._daemonHandlers = [];
    }
});
