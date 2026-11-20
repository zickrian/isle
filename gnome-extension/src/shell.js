// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Integration with GNOME Shell itself: the top bar, the volume/brightness
// OSD and keyboard state. Everything here is undone in `destroy()`.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {clutterBackend, uiScale} from './compat.js';
import * as Format from './format.js';
import {normalized, restyle} from './panelStyle.js';
import {sendSuperV, watchRecorder} from './shortcutRecorder.js';
import {watchClock} from './wallClock.js';

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
/** Isle's own clock in the bar (Settings → Clock in the top bar): its role among the bar's items, Isle's alone. */
const BAR_CLOCK_ROLE = 'isle-clock';
/** What the bar's clock shows (Settings → Top bar clock shows), before the time: nothing, the day, or the date. */
const BAR_CLOCK_DAY = {time: null, day: '%a', date: '%a %-d %b'};
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
        // Settings → Keep GNOME's clock: the clock stays in the bar, moved out from under the island (see `_syncKeptClock`).
        this._keepClock = settings.get_boolean('keep-gnome-clock');
        this._clockFocus = this._dateMenu.can_focus;
        this._clockShown = false;
        this._closeLater = 0;
        /** The width kept clear for the island in the bar's centre (see `reserveWidth`), in stage px. */
        this._reserved = -1;
        this._spacer = null;
        /** Where the clock sat before Isle moved it (Keep GNOME's clock): its box and place in it; null while it is there. */
        this._home = null;
        this._movedAway = this._clockMovedAway();
        this._syncKeptClock();
        this._syncDateMenu();
        // Another extension may move GNOME's clock to the bar's left or right (#62): it is then that extension's,
        // shown where it put it, and the island's room in the centre is kept by a spacer of Isle's instead.
        this._clockParentSet = this._dateMenu.container.connect('parent-set', () => this._onClockMoved());

        this._settingsChanged = [
            ...['top-bar-style', 'top-bar-opacity', 'top-bar-color', 'island-theme'].map(key => settings.connect(`changed::${key}`, () => {
                this._yielded = false;
                const blended = this._blended;
                this._syncWindowWatch(false);
                this._applyStyle();
                // Only black all the way changes where the island sits; the shades between just restyle the bar.
                if (this.blendsIn !== blended)
                    this.emit('style-changed');
            })),
            settings.connect('changed::keep-gnome-clock', () => {
                this._keepClock = this._settings.get_boolean('keep-gnome-clock');
                this._syncKeptClock();
            }),
            settings.connect('changed::compact-top-bar', () => this._applyStyle()),
            settings.connect('changed::top-bar-clock', () => this._syncBarClock({again: true})),
            // The 12/24-hour setting reaches it as every clock of Isle's (`refreshClocks`).
            settings.connect('changed::top-bar-clock-shows', () => this._tickBarClock()),
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
        this._barClock = null;
        this._syncBarClock();
        // While Settings waits for a shortcut, Super+V goes to it (GNOME's grab keeps it from the window itself).
        this._recording = false;
        this._unwatchRecorder = watchRecorder(waiting => (this._recording = waiting));
        // Closed before the next frame, not at once: GNOME 51 tells of the opening before it shows the menu, which
        // a menu closed then still did, for good (#61).
        this._menuChanged = this._dateMenu.menu.connect('open-state-changed', (menu, open) => {
            if (!open || this._dateMenuShown || this._closeLater)
                return;
            this._closeLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
                this._closeLater = 0;
                if (!this._dateMenuShown) {
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
        const shown = this._dateMenuShown;
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
        const wanted = this.colors && this._settings.get_boolean('top-bar-black-with-windows') && this.opacity < 100;
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
     * A glass island never is, nor one by a bar Isle doesn't colour (its colour isn't known). */
    get blendsIn() {
        return this.colors && this.opacity >= 100 && this._settings.get_string('island-theme') === 'black';
    }

    /** Keeps the top bar's centre clear for the island: GNOME's clock there takes its width, or Isle's spacer once
     * another extension moved the clock away. */
    reserveWidth(width, footprint = width) {
        this._reserved = Math.ceil(width);
        (this._spacer ?? this._dateMenu).set_width(this._reserved);
        // Its shoulders reach past the centre GNOME keeps for it: Isle's clock keeps clear of them too.
        const span = Math.ceil(footprint);
        if (span !== this._footprint) {
            this._footprint = span;
            this._fitLater();
        }
    }

    /** Shows GNOME's own clock in the top bar while the island is on another display. */
    set clockShown(shown) {
        this._clockShown = shown;
        this._syncKeptClock();
        this._syncDateMenu();
        // One clock in the bar: GNOME's, while it shows in the island's place.
        this._syncBarClock();
    }

    /** Whether GNOME's clock shows: while the island is on another display, or where another extension moved it. */
    get _dateMenuShown() {
        return this._clockShown || this._movedAway;
    }

    /** Whether another extension moved GNOME's clock from the centre to the bar's left or right box. Anywhere else
     * (a panel extension that remakes the whole bar), it is left hidden, as before. */
    _clockMovedAway() {
        const parent = this._dateMenu.container.get_parent();
        return parent === Main.panel._leftBox || parent === Main.panel._rightBox;
    }

    /** GNOME's clock moved: shown, or hidden again, once the move is over (not while the bar is being changed). */
    _onClockMoved() {
        if (this._movedLater)
            return;
        this._movedLater = global.compositor.get_laters().add(Meta.LaterType.BEFORE_REDRAW, () => {
            this._movedLater = 0;
            const moved = this._clockMovedAway();
            if (moved !== this._movedAway) {
                this._movedAway = moved;
                this._syncDateMenu();
            }
            return GLib.SOURCE_REMOVE;
        });
    }

    /** GNOME's clock shown or hidden as `_dateMenuShown` says; the island's room kept by it in the centre, or by a
     * spacer of Isle's while another extension has the clock elsewhere. */
    _syncDateMenu() {
        const shown = this._dateMenuShown;
        this._dateMenu.opacity = shown ? 255 : 0;
        this._dateMenu.reactive = shown;
        this._syncClockMenu();
        if (!shown)
            this._dateMenu.menu.close();
        if (this._movedAway && !this._spacer) {
            this._spacer = new St.Widget({name: 'isleCentreSpacer', reactive: false});
            Main.panel._centerBox.insert_child_at_index(this._spacer, 0);
        } else if (!this._movedAway && this._spacer) {
            this._spacer.destroy();
            this._spacer = null;
        }
        // Its own width where another extension has it, or while the island is elsewhere.
        if (shown)
            this._dateMenu.set_width(-1);
        if (this._reserved >= 0 && !this._clockShown)
            (this._spacer ?? this._dateMenu).set_width(this._reserved);
        // The island on another display: no room to keep in this bar's centre.
        else if (this._clockShown)
            this._spacer?.set_width(0);
    }

    /** Isle's own clock in the bar where Settings put it (#62), left or right, after what is there already: an item
     * of Isle's own, never another's moved. None while GNOME's own clock shows in the island's place. `again`: made
     * anew, in its new place. */
    _syncBarClock({again = false} = {}) {
        const side = this._settings.get_string('top-bar-clock');
        const wanted = side !== 'off' && !this._clockShown;
        if (this._barClock && (!wanted || again)) {
            this._barClock.destroy();
            this._barClock = null;
        }
        if (!wanted || this._barClock)
            return;
        const button = new PanelMenu.Button(0.5, 'Isle clock', true);
        button.add_style_class_name('isle-bar-clock');
        button.accessible_name = 'Calendar';
        this._barClockLabel = new St.Label({style_class: 'isle-bar-clock-label', y_align: Clutter.ActorAlign.CENTER});
        button.add_child(this._barClockLabel);
        // On the press: with the island open and holding the keyboard, the press goes to it and closes it (see the
        // controller's `_setKeyboard`), so a click here closes it rather than opening it again on the release.
        button.connect('button-press-event', (_actor, event) => {
            if (event.get_button() !== PRIMARY_BUTTON)
                return Clutter.EVENT_PROPAGATE;
            this._openCalendar();
            return Clutter.EVENT_STOP;
        });
        button.connect('touch-event', (_actor, event) => {
            if (event.type() !== Clutter.EventType.TOUCH_BEGIN)
                return Clutter.EVENT_PROPAGATE;
            this._openCalendar();
            return Clutter.EVENT_STOP;
        });
        const stop = watchClock(() => this._tickBarClock());
        // At the end of its side: right of the system menu, or of the left side's items.
        const box = side === 'left' ? Main.panel._leftBox : Main.panel._rightBox;
        // Its side's items laid out anew (one added, gone, wider): whether it still fits is looked at again.
        const fit = () => this._fitLater();
        const watched = [box.connect('notify::allocation', fit), Main.panel.connect('notify::width', fit)];
        button.connect('destroy', () => {
            stop();
            box.disconnect(watched[0]);
            Main.panel.disconnect(watched[1]);
            if (this._barClock === button)
                this._barClock = null;
        });
        this._barClock = button;
        Main.panel.addToStatusArea(BAR_CLOCK_ROLE, button, box.get_n_children(), side);
        this._tickBarClock();
        this._fitLater();
    }

    /** Looks at whether the bar's clock fits once the bar is laid out (not while it is being laid out). On idle,
     * not before the next frame: a hidden clock's new text draws none, and the screen may have nothing else to draw. */
    _fitLater() {
        if (this._fitting)
            return;
        this._fitting = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            this._fitting = 0;
            this._fitBarClock();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Isle's clock is the extra on its side: it shows only while that side has room for it beside what the other
     * items need, never pushing them (or itself) over the island. GNOME gives each side half the bar beside the
     * centre, and a side wider than that spills towards it. Judged on the others' width alone, so it never flickers. */
    _fitBarClock() {
        const clock = this._barClock?.container;
        const box = clock?.get_parent();
        if (!box)
            return;
        const [, centre] = Main.panel._centerBox.get_preferred_width(-1);
        // GNOME's half beside the centre, or what the island leaves beside it, centred on the display, whichever is less.
        const room = Math.max(0, Math.min(Main.panel.width - centre, Main.panel.width - (this._footprint ?? 0)) / 2);
        const [, all] = box.get_preferred_width(-1);
        const [, own] = clock.get_preferred_width(-1);
        const others = all - (clock.visible ? own : 0);
        const fits = others + own <= room;
        if (clock.visible !== fits)
            clock.visible = fits;
    }

    /** The bar's clock as Settings say: "14:05", "Wed 14:05" or "Wed 18 Nov 14:05", 12-hour as the island's. */
    _tickBarClock() {
        if (!this._barClock)
            return;
        const now = GLib.DateTime.new_now_local();
        const {time, meridiem} = Format.clockParts(now);
        const day = BAR_CLOCK_DAY[this._settings.get_string('top-bar-clock-shows')];
        const text = [day && now.format(day), time + (meridiem ? ` ${meridiem}` : '')].filter(Boolean).join('  ');
        if (text === this._barClockLabel.text)
            return;
        this._barClockLabel.text = text;
        // Hidden for want of room, its side isn't laid out again as its text changes: looked at here instead.
        this._fitLater();
    }

    /** The island's Calendar page, as Super+V opens it; its usual page with the Calendar left out. */
    _openCalendar() {
        const hidden = this._settings.get_strv('hidden-pages').includes('calendar');
        this.emit('calendar-requested', hidden ? null : 'calendar');
    }

    /** Keep GNOME's clock (Settings): Isle moves it itself from the bar's centre to the right box, just before the
     * system menu, and puts it back when the setting is turned off, or Isle is. The room under the island is then
     * held by the spacer of `_syncDateMenu`, as for a clock another extension moved. */
    _syncKeptClock() {
        if (this._keepClock && !this._clockShown)
            this._moveAside();
        else
            this._moveHome();
    }

    /** Moves the clock to the right box, before the system menu. Only from GNOME's own place: where another
     * extension has put the clock is its own business. */
    _moveAside() {
        const box = this._dateMenu.container;
        const right = Main.panel._rightBox;
        if (this._home || !box || !right)
            return;
        const parent = box.get_parent();
        if (!parent || parent !== Main.panel._centerBox)
            return;
        this._home = {parent, index: parent.get_children().indexOf(box)};
        parent.remove_child(box);
        const system = Main.panel.statusArea.quickSettings?.container;
        const before = system?.get_parent() === right ? right.get_children().indexOf(system) : -1;
        if (before >= 0)
            right.insert_child_at_index(box, before);
        else
            right.add_child(box);
        this._movedAway = this._clockMovedAway();
        this._syncDateMenu();
    }

    /** Puts the clock back in the middle, where GNOME had it, unless another extension has taken it elsewhere. */
    _moveHome() {
        if (!this._home)
            return;
        const box = this._dateMenu.container;
        const {parent, index} = this._home;
        this._home = null;
        if (!box || box.get_parent() !== Main.panel._rightBox)
            return;
        this._spacer?.destroy();
        this._spacer = null;
        box.get_parent().remove_child(box);
        parent.insert_child_at_index(box, Math.min(index, parent.get_n_children()));
        this._movedAway = this._clockMovedAway();
        this._syncDateMenu();
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
        // Its colour left to the theme or another extension (#63): nor its text's white and shadow, which go with
        // Isle's colours. Its height is still Isle's, round the island.
        const colored = styled && this.colors;
        setStyleClasses(Main.panel, {
            [BAR_CLASS]: colored,
            [COMPACT_BAR_CLASS]: styled && this._settings.get_boolean('compact-top-bar'),
            [NOTCH_BAR_CLASS]: styled && inBar,
            [PILL_BAR_CLASS]: styled && inBar && this._settings.get_string('island-shape') === 'pill',
            [GLASS_BAR_CLASS]: colored && this.opacity < SHADOW_BELOW,
        });
    }

    /** Whether Isle colours the bar (Settings), from glass to black; off, it keeps the colour the theme or another
     * extension gives it. */
    get colors() {
        return this._settings.get_boolean('top-bar-color');
    }

    /** The bar's opacity in % as Isle colours it; null off the top, or with its colour left to others (`colors`). */
    get _color() {
        return this._atTop && this.colors ? this._shownOpacity : null;
    }

    // Another extension that sets the bar's style too would undo Isle's rule each time Isle set it, in a
    // loop that keeps the shell busy: past a few times a second, Isle gives way until the setting changes.
    _onPanelStyle() {
        // No colour of Isle's now (left to others, or the bar off the top): what another extension writes is its own,
        // even a declaration spelt as one Isle wrote before.
        if (this._color === null)
            return;
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
        this._dateMenu.container.disconnect(this._clockParentSet);
        if (this._closeLater)
            global.compositor.get_laters().remove(this._closeLater);
        this._closeLater = 0;
        if (this._movedLater)
            global.compositor.get_laters().remove(this._movedLater);
        this._movedLater = 0;
        if (this._fitting)
            GLib.source_remove(this._fitting);
        this._fitting = 0;
        this._barClock?.destroy();
        this._barClock = null;
        this._spacer?.destroy();
        this._spacer = null;
        this._clockShown = true;
        this._syncClockMenu();
        this._moveHome();
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
