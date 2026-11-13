// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Integration with GNOME Shell itself: the top bar, the volume/brightness
// OSD and keyboard state. Everything here is undone in `destroy()`.

import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {clutterBackend, uiScale} from './compat.js';
import {normalized, restyle} from './panelStyle.js';
import {sendSuperV, watchRecorder} from './shortcutRecorder.js';

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
/** Style class making the top bar taller round a pill inside it, as tall as a notched display's (see stylesheet.css). */
const PILL_BAR_CLASS = 'isle-pill-bar';
/** The space left below the island inside the bar (Settings): the island is this much shorter, the bar
 * keeps its height, so its other buttons stay centred (#14). */
const GAP_PX = 4;
/** The primary (usually left) mouse button, as Clutter numbers it. */
const PRIMARY_BUTTON = 1;
/** A window whose top is this close below the bar (in px) reaches it: maximized, tiled or moved up there. */
export const REACH_PX = 5;
/** Looked again once a window's animation is over (minimizing, closing), as some signals come as it starts. */
const WINDOW_SETTLE_MS = 400;

// Restyles the top bar around the island (black or glass) and hides the clock and its calendar menu.
// Signals: `height-changed`, `style-changed` (`blendsIn` may have changed), `calendar-requested` (Super+V, with
// the island's page to open: 'clipboard', 'calendar', or null for its usual one).
export class TopBar extends Signals.EventEmitter {
    /** Hides the clock at once; Super+V comes to Isle, which opens what Settings say. */
    constructor(settings) {
        super();
        this._settings = settings;
        /** Every declaration Isle has put in the bar's style, normalized: to tell them from another's. */
        this._own = new Set();
        this._toggle = () => this._onToggle();
        this._dateMenu = Main.panel.statusArea.dateMenu;
        this._clockFocus = this._dateMenu.can_focus;
        this._clockShown = false;
        this._closeLater = 0;
        this._dateMenu.opacity = 0;
        this._dateMenu.reactive = false;
        this._syncClockMenu();

        this._settingsChanged = [
            ...['top-bar-style', 'top-bar-opacity', 'island-theme'].map(key => settings.connect(`changed::${key}`, () => {
                this._yielded = false;
                const blended = this._blended;
                this._syncWindowWatch(false);
                this._applyStyle();
                // Only black all the way changes where the island sits; the shades between just restyle the bar.
                if (this.blendsIn !== blended)
                    this.emit('style-changed');
            })),
            settings.connect('changed::compact-top-bar', () => this._applyStyle()),
            settings.connect('changed::top-bar-black-with-windows', () => this._syncWindowWatch()),
            settings.connect('changed::island-in-top-bar', () => this._applyStyle()),
            settings.connect('changed::island-shape', () => this._applyStyle()),
            // The bar keeps its height: the island is laid out again for its own.
            settings.connect('changed::notch-gap', () => {
                const gap = this._gap;
                this._applyStyle();
                if (this._gap !== gap)
                    this.emit('height-changed');
            }),
        ];
        // Another extension may move the bar off the top (to the bottom of the screen, say): the island then
        // hangs from the main display's top edge, as on any other display, and the bar is left as that one has it.
        this._atTop = this._isAtTop();
        this._applyStyle();
        this._styleChanged = Main.panel.connect('notify::style', () => this._onPanelStyle());
        this._windowWatch = [];
        this._syncWindowWatch();
        // GNOME 50 and later drag a maximized window from the bar with any button: after a right click on the bar
        // the window followed the pointer (#27). Only the primary button, as up to GNOME 49; given back on disable.
        this._dragGesture = Main.panel._clickGesture ?? null;
        this._dragButtonWas = this._dragGesture?.required_button ?? null;
        if (this._dragButtonWas === 0)
            this._dragGesture.required_button = PRIMARY_BUTTON;

        this._heightChanged = Main.panel.connect('notify::height', () => this.emit('height-changed'));
        const panelBox = Main.layoutManager.panelBox;
        this._barMoved = ['notify::x', 'notify::y'].map(signal => panelBox.connect(signal, () => this._onBarMoved()));

        // GNOME's calendar shortcut (Super+V, Super+M) always opens the island, on the page Settings say (`superV`);
        // it used to fall to GNOME's menu, which never opened for the hidden clock (#50). No shortcut of Isle's own,
        // nothing in GNOME's settings. The hidden clock's menu is closed again should anything else open it.
        this._takeToggle();
        // While Settings waits for a shortcut, Super+V goes to it (GNOME's grab keeps it from the window itself).
        this._recording = false;
        this._unwatchRecorder = watchRecorder(waiting => (this._recording = waiting));
        // Closed before the next frame, not at once: GNOME 51 tells of the opening before it shows the menu, which
        // a menu closed then still did, for good (#61).
        this._menuChanged = this._dateMenu.menu.connect('open-state-changed', (menu, open) => {
            if (!open || this._clockShown || this._closeLater)
                return;
            this._closeLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._closeLater = 0;
                if (!this._clockShown) {
                    menu.close();
                    // Given back to the bar's menus meanwhile (GNOME laying the bar out again): taken again.
                    this._syncClockMenu();
                }
                return GLib.SOURCE_REMOVE;
            });
        });
    }

    /** The hidden clock's menu is not among the bar's: with one of those open, ← → (Ctrl+Alt+arrows too) and the
     * pointer moving along the bar opened the next, the calendar's included (#61). Nor can the clock take the
     * keyboard. Both given back with the clock. */
    _syncClockMenu() {
        const manager = Main.panel.menuManager;
        const shown = this._clockShown;
        this._dateMenu.can_focus = shown ? this._clockFocus : false;
        if (shown)
            manager.addMenu(this._dateMenu.menu);
        else
            manager.removeMenu(this._dateMenu.menu);
    }

    /** Whether the bar runs along the top of `monitor`: the main display's, unless another extension moved it. */
    isOn(monitor) {
        return Boolean(monitor) && monitor === Main.layoutManager.primaryMonitor && this._isAtTop();
    }

    /** Where GNOME puts it, or above, slid out of sight (Hide Top Bar): in the main display's upper half. */
    _isAtTop() {
        const monitor = Main.layoutManager.primaryMonitor;
        const {x, y} = Main.layoutManager.panelBox;
        return !monitor || (y < monitor.y + monitor.height / 2 && x >= monitor.x && x < monitor.x + monitor.width);
    }

    /** Tells the island once the bar comes to the top or leaves it, not as it slides. */
    _onBarMoved() {
        const atTop = this._isAtTop();
        if (atTop === this._atTop)
            return;
        this._atTop = atTop;
        this._applyStyle();
        this.emit('moved');
    }

    /** In stage pixels; it changes with the compact and notch styles. */
    get height() {
        return Main.panel.height;
    }

    /** The space below the closed island inside the bar, in stage pixels: part of `height`. */
    get gap() {
        return this._gap * uiScale();
    }

    /** The island's page Super+V opens: 'clipboard' or 'calendar' (Settings; 'gnome', from before, reads as the
     * calendar), the other one if that page is left out of the island, null with both left out (its usual page), or
     * 'none' when Settings took Super+V off. */
    get superV() {
        const setting = this._settings.get_string('super-v');
        if (setting === 'none')
            return 'none';
        const hidden = this._settings.get_strv('hidden-pages');
        const pages = {clipboard: !hidden.includes('shelf'), calendar: !hidden.includes('calendar')};
        const wanted = setting === 'isle' ? 'clipboard' : 'calendar';
        const other = wanted === 'clipboard' ? 'calendar' : 'clipboard';
        return pages[wanted] ? wanted : pages[other] ? other : null;
    }

    /** Takes the calendar shortcut, once: what it opens is looked up as it is pressed (`superV`). */
    _takeToggle() {
        if (Main.panel.toggleCalendar === this._toggle)
            return;
        // Another extension's own, put back when Isle stops (GNOME's is the prototype's).
        this._priorToggle = Object.hasOwn(Main.panel, 'toggleCalendar') ? Main.panel.toggleCalendar : null;
        Main.panel.toggleCalendar = this._toggle;
    }

    /** Super+V: the island, on the page Settings say; nothing with Super+V taken off (Island → Shortcuts). */
    _onToggle() {
        if (this._recording) {
            sendSuperV();
            return;
        }
        const page = this.superV;
        if (page !== 'none')
            this.emit('calendar-requested', page);
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

    /** The bar's opacity in % as shown: black while a window reaches it, if Settings say so. */
    get _shownOpacity() {
        return this._windowAtBar ? 100 : this.opacity;
    }

    /** Follows the windows while Settings turn the bar black beside them (a see-through or grey bar), else
     * nothing; then shows the bar as they are, unless `show` is false. */
    _syncWindowWatch(show = true) {
        const wanted = this._settings.get_boolean('top-bar-black-with-windows') && this.opacity < 100;
        if (wanted && !this._windowWatch.length) {
            const sync = () => this._onWindowsChanged();
            this._windowWatch = [
                [global.display, ['restacked', 'grab-op-end', 'workareas-changed', 'window-entered-monitor',
                    'window-left-monitor']],
                [global.window_manager, ['size-changed', 'minimize', 'unminimize', 'map', 'destroy']],
                [global.workspace_manager, ['active-workspace-changed']],
                [Main.overview, ['showing', 'hidden']],
            ].flatMap(([source, signals]) => signals.map(signal => [source, source.connect(signal, sync)]));
        } else if (!wanted) {
            this._unwatchWindows();
        }
        this._windowAtBar = wanted && windowReachesBar();
        if (show)
            this._syncColor();
    }

    /** Lets go of the windows' signals. */
    _unwatchWindows() {
        this._windowWatch.forEach(([source, id]) => source.disconnect(id));
        this._windowWatch = [];
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = 0;
    }

    /** A window came, went, moved or changed size: the bar as they are now, and again once it has settled. */
    _onWindowsChanged() {
        this._showWindowAtBar();
        if (this._settleId)
            GLib.source_remove(this._settleId);
        this._settleId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, WINDOW_SETTLE_MS, () => {
            this._settleId = 0;
            this._showWindowAtBar();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Recolours the bar only when a window starts or stops reaching it. */
    _showWindowAtBar() {
        const atBar = windowReachesBar();
        if (atBar === this._windowAtBar)
            return;
        this._windowAtBar = atBar;
        this._syncColor();
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
        this._syncClockMenu();
        if (shown)
            this._dateMenu.set_width(-1);
        else
            this._dateMenu.menu.close();
    }

    /** Colour and style classes from the settings; remembers `blendsIn` to spot a change. Off the top, none:
     * the bar there is another extension's to style, and Isle's colour and height would set it apart from
     * that extension's bars on the other displays. */
    _applyStyle() {
        this._blended = this.blendsIn;
        this._syncColor();
        const inBar = this._settings.get_boolean('island-in-top-bar');
        this._gap = inBar && this._settings.get_boolean('notch-gap') ? GAP_PX : 0;
        const styled = this._atTop;
        // The bar's height changes with these; `height-changed` re-lays out the island.
        setStyleClasses(Main.panel, {
            [BAR_CLASS]: styled,
            [COMPACT_BAR_CLASS]: styled && this._settings.get_boolean('compact-top-bar'),
            [NOTCH_BAR_CLASS]: styled && inBar,
            [PILL_BAR_CLASS]: styled && inBar && this._settings.get_string('island-shape') === 'pill',
            [GLASS_BAR_CLASS]: styled && this.opacity < SHADOW_BELOW,
        });
    }

    /** The bar's opacity in % as Isle colours it; null off the top, where Isle leaves it the theme's. */
    get _color() {
        return this._atTop ? this._shownOpacity : null;
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
    _wantedStyle(opacity = this._color) {
        const rule = this._barRule(opacity);
        if (rule)
            this._own.add(normalized(rule));
        return restyle(Main.panel.get_style(), rule ? [rule] : [], text => this._own.has(text));
    }

    /** Sets Isle's colour, leaving the rest of the style alone; writes nothing when it is in effect already. */
    _syncColor(opacity = this._color) {
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
        this._unwatchWindows();
        this._barMoved.forEach(id => Main.layoutManager.panelBox.disconnect(id));
        if (this._dragButtonWas === 0 && this._dragGesture.required_button === PRIMARY_BUTTON)
            this._dragGesture.required_button = 0;
        this._dateMenu.menu.disconnect(this._menuChanged);
        if (this._closeLater)
            global.compositor.get_laters().remove(this._closeLater);
        this._closeLater = 0;
        this._clockShown = true;
        this._syncClockMenu();
        this._restoreToggle();
        this._unwatchRecorder();

        // No colour of Isle's: the theme's again.
        this._syncColor(null);
        setStyleClasses(Main.panel, {
            [BAR_CLASS]: false, [COMPACT_BAR_CLASS]: false, [NOTCH_BAR_CLASS]: false, [PILL_BAR_CLASS]: false,
            [GLASS_BAR_CLASS]: false,
        });
        this._dateMenu.set_width(-1);
        this._dateMenu.opacity = 255;
        this._dateMenu.reactive = true;
    }
}

/** Whether an app's window on the active workspace reaches the top bar on the main display; not in the overview,
 * nor with the bar hidden (under a fullscreen window). */
function windowReachesBar() {
    if (!Main.panel.mapped)
        return false;
    const bottom = Main.panel.get_transformed_position()[1] + Main.panel.height;
    return windowAtTop(Main.layoutManager.primaryMonitor, bottom + REACH_PX * uiScale());
}

/** Whether an app's window on the active workspace and `monitor` (across `[left, right]` if given) has its top above
 * `reach` (stage px); never in the overview, where the windows are not as they lie. */
export function windowAtTop(monitor, reach, [left, right] = [-Infinity, Infinity]) {
    if (!monitor || Main.overview.visible)
        return false;
    const workspace = global.workspace_manager.get_active_workspace();
    return global.get_window_actors().some(({meta_window: window}) => {
        const rect = window?.get_frame_rect();
        return rect && window.get_window_type() === Meta.WindowType.NORMAL && !window.minimized &&
            !window.is_skip_taskbar() && window.get_monitor() === monitor.index && window.located_on_workspace(workspace) &&
            window.showing_on_its_workspace() && rect.y < reach && rect.x < right && rect.x + rect.width > left;
    });
}

// Adds or removes each of `classes` ({name: on}) in one change: each change restyles the whole bar at once.
function setStyleClasses(actor, classes) {
    const current = (actor.get_style_class_name() ?? '').split(/\s+/).filter(Boolean);
    const kept = current.filter(name => !(name in classes));
    const wanted = [...kept, ...Object.keys(classes).filter(name => classes[name])];
    if (wanted.length !== current.length || wanted.some(name => !current.includes(name)))
        actor.set_style_class_name(wanted.join(' ') || null);
}

// Routes GNOME's volume and brightness OSDs to `handler` (icon, label, level, maxLevel, and for one about some displays
// only, their levels by display index). It returns true when it showed it, false for GNOME to show its own, or the
// indexes of the displays it showed it for: GNOME shows it on the others.
// GNOME 46–48: `show(monitorIndex, icon, label, level, maxLevel)` (-1: all); 49: `show(icon, label, levels)` for some
// displays (brightness), `showAll()` for all.
export class OsdHook {
    /** Wraps whichever of `show` and `showAll` this GNOME has. */
    constructor(handler) {
        const manager = Main.osdWindowManager;
        this._manager = manager;
        const self = this;
        const perMonitor = typeof manager.showAll === 'function';
        // What GNOME is left to show of a `show(icon, label, levels)` the handler took some displays of.
        const rest = (shown, [icon, label, levels]) => {
            if (!Array.isArray(shown))
                return shown;
            const others = Object.fromEntries(Object.entries(levels).filter(([index, value]) =>
                value && !shown.includes(Number(index))));
            return Object.keys(others).length ? [icon, label, others] : true;
        };
        const adapters = perMonitor
            ? {
                show: (icon, label, levels) => {
                    const {level, maxLevel} = levels?.[Main.layoutManager.primaryIndex] ??
                        Object.values(levels ?? {}).find(Boolean) ?? {};
                    return rest(handler(icon, label, level, maxLevel, levels ?? {}), [icon, label, levels ?? {}]);
                },
                showAll: (icon, label, level, maxLevel) => handler(icon, label, level, maxLevel, null),
            }
            : {
                show: (monitorIndex, icon, label, level, maxLevel) => {
                    const displays = monitorIndex >= 0 ? {[monitorIndex]: {level, maxLevel}} : null;
                    // One display only: the handler shows it there, or GNOME does.
                    const shown = handler(icon, label, level, maxLevel, displays);
                    return Array.isArray(shown) ? true : shown;
                },
            };
        this._hooks = Object.entries(adapters).map(([name, handled]) => {
            const original = manager[name];
            // Left in place under another extension's wrapper once Isle stops: then it only passes through.
            const hook = function (...args) {
                // Isle failing must not take GNOME's own OSD with it.
                let shown = false;
                try {
                    shown = !self._destroyed && handled(...args);
                } catch (e) {
                    console.warn(`Isle: could not show the OSD: ${e.message}`);
                }
                if (shown === true)
                    return;
                // All of it, or what the handler left to GNOME (other displays).
                original.apply(this, Array.isArray(shown) ? shown : args);
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
