// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Integration with GNOME Shell itself: the top bar, the volume/brightness
// OSD and keyboard state. Everything here is undone in `destroy()`.

import GLib from 'gi://GLib';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {clutterBackend, uiScale} from './compat.js';
import {normalized, restyle} from './panelStyle.js';

// The bar's colour (glass 0% to black 100%) is a declaration in its inline style, which other extensions write
// too: Isle edits only its own (panelStyle.js) and puts it back if another extension takes it out.
/** More changes of the bar's style than this in a second are a fight with another extension. */
const MAX_RESTYLES_PER_SECOND = 5;
/** Below this opacity (%) the bar's text needs its shadow to read on the wallpaper. */
const SHADOW_BELOW = 50;
/** Style class keeping the bar's text white in GNOME's light style too. */
const BAR_CLASS = 'isle-panel';
/** Style class giving the glass bar's text a shadow to read on any wallpaper. */
const GLASS_BAR_CLASS = 'isle-glass-bar';
/** Style class making the top bar slimmer; see stylesheet.css. */
const COMPACT_BAR_CLASS = 'isle-compact-bar';
/** Style class making the top bar as tall as the closed island. */
const NOTCH_BAR_CLASS = 'isle-notch-bar';
/** Style class making it taller by GAP_PX, the space below the island (as in stylesheet.css). */
const GAP_CLASS = 'isle-notch-gap';
const GAP_PX = 4;

// Restyles the top bar around the island (black or glass) and hides the clock and its calendar menu.
// Signals: `height-changed`, `style-changed` (`blendsIn` may have changed), `calendar-requested` (Super+V).
export class TopBar extends Signals.EventEmitter {
    /** Hides the clock at once; Super+V comes to Isle unless Settings leaves it to GNOME. */
    constructor(settings) {
        super();
        this._settings = settings;
        /** Every declaration Isle has put in the bar's style, normalized: to tell them from another's. */
        this._own = new Set();
        this._toggle = () => this.emit('calendar-requested');
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._dateMenu.opacity = 0;
        this._dateMenu.reactive = false;

        this._settingsChanged = [
            ...['top-bar-style', 'top-bar-opacity', 'island-theme'].map(key => settings.connect(`changed::${key}`, () => {
                this._yielded = false;
                const blended = this._blended;
                this._applyStyle();
                // Only black all the way changes where the island sits; the shades between just restyle the bar.
                if (this.blendsIn !== blended)
                    this.emit('style-changed');
            })),
            settings.connect('changed::compact-top-bar', () => this._applyStyle()),
            settings.connect('changed::island-in-top-bar', () => this._applyStyle()),
            settings.connect('changed::notch-gap', () => this._applyStyle()),
        ];
        this._applyStyle();
        this._styleChanged = Main.panel.connect('notify::style', () => this._onPanelStyle());

        this._heightChanged = Main.panel.connect('notify::height', () => this.emit('height-changed'));

        // The calendar shortcut opens the island instead, and the hidden clock's menu is closed again
        // should anything else open it; unless Super+V is left to GNOME (Settings).
        this._superVChanged = settings.connect('changed::super-v', () => this._syncCalendar());
        this._pagesChanged = settings.connect('changed::hidden-pages', () => this._syncCalendar());
        this._syncCalendar();
        this._menuChanged = this._dateMenu.menu.connect('open-state-changed', (menu, open) => {
            if (open && !this._clockShown && this._superVIsIsle)
                menu.close();
        });
    }

    /** In stage pixels; it changes with the compact and notch styles. */
    get height() {
        return Main.panel.height;
    }

    /** The space below the closed island inside the bar, in stage pixels: part of `height`. */
    get gap() {
        return this._gap * uiScale();
    }

    /** Super+V opens Isle's clipboard, unless left to GNOME or the Shelf page is left out. */
    get _superVIsIsle() {
        return this._settings.get_string('super-v') === 'isle' && !this._settings.get_strv('hidden-pages').includes('shelf');
    }

    /** Takes the calendar shortcut over, or gives it back, as the settings now say. */
    _syncCalendar() {
        if (!this._superVIsIsle) {
            this._restoreToggle();
        } else if (Main.panel.toggleCalendar !== this._toggle) {
            // Another extension's own, put back when Isle stops (GNOME's is the prototype's).
            this._priorToggle = Object.hasOwn(Main.panel, 'toggleCalendar') ? Main.panel.toggleCalendar : null;
            Main.panel.toggleCalendar = this._toggle;
        }
    }

    /** Undoes Isle's toggleCalendar, unless another extension has set its own since. */
    _restoreToggle() {
        if (Main.panel.toggleCalendar !== this._toggle)
            return;
        if (this._priorToggle)
            Main.panel.toggleCalendar = this._priorToggle;
        else
            delete Main.panel.toggleCalendar;
    }

    /** The bar's opacity in %: Settings' slider, else as the older Glass (0) or Black (100) choice says. */
    get opacity() {
        if (this._settings.get_user_value('top-bar-opacity'))
            return this._settings.get_int('top-bar-opacity');
        return this._settings.get_string('top-bar-style') === 'black' ? 100 : 0;
    }

    /** Whether the bar is as black as the island; otherwise the island hangs from the screen's top edge.
     * A glass island never is. */
    get blendsIn() {
        return this.opacity >= 100 && this._settings.get_string('island-theme') === 'black';
    }

    /** Keeps the top bar's centre clear for the island. */
    reserveWidth(width) {
        this._dateMenu.set_width(Math.ceil(width));
    }

    /** Shows GNOME's own clock in the top bar while the island is on another display. */
    set clockShown(shown) {
        this._clockShown = shown;
        this._dateMenu.opacity = shown ? 255 : 0;
        this._dateMenu.reactive = shown;
        if (shown)
            this._dateMenu.set_width(-1);
        else if (this._superVIsIsle)
            this._dateMenu.menu.close();
    }

    /** Colour and style classes from the settings; remembers `blendsIn` to spot a change. */
    _applyStyle() {
        this._blended = this.blendsIn;
        this._syncColor();
        const inBar = this._settings.get_boolean('island-in-top-bar');
        this._gap = inBar && this._settings.get_boolean('notch-gap') ? GAP_PX : 0;
        // The bar's height changes with these; `height-changed` re-lays out the island.
        setStyleClasses(Main.panel, {
            [BAR_CLASS]: true,
            [COMPACT_BAR_CLASS]: this._settings.get_boolean('compact-top-bar'),
            [NOTCH_BAR_CLASS]: inBar,
            [GLASS_BAR_CLASS]: this.opacity < SHADOW_BELOW,
            [GAP_CLASS]: this._gap > 0,
        });
    }

    // Another extension that sets the bar's style too would undo Isle's rule each time Isle set it, in a
    // loop that keeps the shell busy: past a few times a second, Isle gives way until the setting changes.
    _onPanelStyle() {
        // Isle's own write, or one that kept Isle's colour (however spelt or ordered): no fight.
        if (this._yielded || this._writing || this._wantedStyle() === Main.panel.get_style())
            return;
        const now = GLib.get_monotonic_time();
        this._restyles = (this._restyles ?? []).filter(at => now - at < 1e6);
        this._restyles.push(now);
        if (this._restyles.length > MAX_RESTYLES_PER_SECOND) {
            this._yielded = true;
            console.warn('Isle: another extension keeps changing the top bar\'s style; Isle stops setting its colour');
            return;
        }
        this._syncColor();
    }

    /** Black at `opacity` %, as a declaration; null for none (the theme's colour). */
    _barRule(opacity) {
        if (opacity === null)
            return null;
        if (opacity <= 0)
            return 'background-color: transparent';
        return opacity >= 100 ? 'background-color: #000000' : `background-color: rgba(0, 0, 0, ${opacity / 100})`;
    }

    /** The bar's style with Isle's colour at `opacity`, the rest of it left alone: the current one itself when
     * Isle's colour is already in effect there. */
    _wantedStyle(opacity = this.opacity) {
        const rule = this._barRule(opacity);
        if (rule)
            this._own.add(normalized(rule));
        return restyle(Main.panel.get_style(), rule ? [rule] : [], text => this._own.has(text));
    }

    /** Sets Isle's colour, leaving the rest of the style alone; writes nothing when it is in effect already. */
    _syncColor(opacity = this.opacity) {
        const wanted = this._wantedStyle(opacity);
        if (wanted === Main.panel.get_style())
            return;
        // It notifies at once: not counted as another extension's change (see `_onPanelStyle`).
        this._writing = true;
        try {
            Main.panel.set_style(wanted);
        } finally {
            this._writing = false;
        }
    }

    /** Gives the bar, clock and calendar shortcut back as GNOME had them. */
    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._settingsChanged.forEach(id => this._settings.disconnect(id));
        Main.panel.disconnect(this._heightChanged);
        Main.panel.disconnect(this._styleChanged);
        this._dateMenu.menu.disconnect(this._menuChanged);
        this._settings.disconnect(this._superVChanged);
        this._settings.disconnect(this._pagesChanged);
        this._restoreToggle();

        // No colour of Isle's: the theme's again.
        this._syncColor(null);
        setStyleClasses(Main.panel, {
            [BAR_CLASS]: false, [COMPACT_BAR_CLASS]: false, [NOTCH_BAR_CLASS]: false, [GLASS_BAR_CLASS]: false,
            [GAP_CLASS]: false,
        });
        this._dateMenu.set_width(-1);
        this._dateMenu.opacity = 255;
        this._dateMenu.reactive = true;
    }
}

// Adds or removes each of `classes` ({name: on}) in one change: each change restyles the whole bar at once.
function setStyleClasses(actor, classes) {
    const current = (actor.get_style_class_name() ?? '').split(/\s+/).filter(Boolean);
    const kept = current.filter(name => !(name in classes));
    const wanted = [...kept, ...Object.keys(classes).filter(name => classes[name])];
    if (wanted.length !== current.length || wanted.some(name => !current.includes(name)))
        actor.set_style_class_name(wanted.join(' ') || null);
}

// Routes GNOME's volume and brightness OSDs to `handler`; if it returns false, GNOME shows its own.
// GNOME 46–48: `show(monitorIndex, icon, label, level, maxLevel)`; 49: `show(icon, label, levels)`, plus `showAll()`.
export class OsdHook {
    /** Wraps whichever of `show` and `showAll` this GNOME has. */
    constructor(handler) {
        const manager = Main.osdWindowManager;
        this._manager = manager;
        const self = this;
        const perMonitor = typeof manager.showAll === 'function';
        const adapters = perMonitor
            ? {
                show: (icon, label, levels) => {
                    const {level, maxLevel} = levels?.[Main.layoutManager.primaryIndex] ??
                        Object.values(levels ?? {}).find(Boolean) ?? {};
                    return handler(icon, label, level, maxLevel);
                },
                showAll: (icon, label, level, maxLevel) => handler(icon, label, level, maxLevel),
            }
            : {
                show: (_monitorIndex, icon, label, level, maxLevel) => handler(icon, label, level, maxLevel),
            };
        this._hooks = Object.entries(adapters).map(([name, handled]) => {
            const original = manager[name];
            // Left in place under another extension's wrapper once Isle stops: then it only passes through.
            const hook = function (...args) {
                // Isle failing must not take GNOME's own OSD with it.
                try {
                    if (!self._destroyed && handled(...args))
                        return;
                } catch (e) {
                    console.warn(`Isle: could not show the OSD: ${e.message}`);
                }
                original.apply(this, args);
            };
            // Set when another extension wrapped it before us.
            const ownOriginal = Object.hasOwn(manager, name) ? original : null;
            manager[name] = hook;
            return {name, hook, ownOriginal};
        });
    }

    /** Stops handling; GNOME shows its own OSD again. */
    destroy() {
        this._destroyed = true;
        // Only undo our own overrides; another extension may have wrapped
        // them since. GNOME's methods live on the prototype.
        for (const {name, hook, ownOriginal} of this._hooks) {
            if (this._manager[name] !== hook)
                continue;
            if (ownOriginal)
                this._manager[name] = ownOriginal;
            else
                delete this._manager[name];
        }
    }
}

/** Emits `caps-lock` (on) when Caps Lock is turned on or off. */
export class KeyboardWatcher extends Signals.EventEmitter {
    /** Starts from the current state, so only a change is emitted. */
    constructor() {
        super();
        this._keymap = clutterBackend().get_default_seat().get_keymap();
        this._capsLock = this._keymap.get_caps_lock_state();
        this._keymapChanged = this._keymap.connect('state-changed', () => {
            const capsLock = this._keymap.get_caps_lock_state();
            if (capsLock !== this._capsLock) {
                this._capsLock = capsLock;
                this.emit('caps-lock', capsLock);
            }
        });
    }

    /** Stops watching the keymap. */
    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        this._keymap.disconnect(this._keymapChanged);
    }
}
