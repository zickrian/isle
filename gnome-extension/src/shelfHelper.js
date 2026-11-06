// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Drives `isle-shelf`, the GTK window over the Files tab that does drag and drop
// (shell actors cannot); started as a drag begins, shown once the island covers it.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Signals from 'resource:///org/gnome/shell/misc/signals.js';

import {px, uiScale} from './compat.js';

const BUS_NAME = 'io.github.zickrian.isle.ShelfWindow';
const OBJECT_PATH = '/io/github/zickrian/isle/ShelfWindow';
const ShelfWindowProxy = Gio.DBusProxy.makeProxyWrapper(`
<node><interface name="io.github.zickrian.isle.ShelfWindow1">
  <method name="Show">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    <arg name="width" type="i" direction="in"/><arg name="height" type="i" direction="in"/>
  </method>
  <method name="ShowOver">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    <arg name="width" type="i" direction="in"/><arg name="height" type="i" direction="in"/>
    <arg name="ax" type="i" direction="in"/><arg name="ay" type="i" direction="in"/>
    <arg name="awidth" type="i" direction="in"/><arg name="aheight" type="i" direction="in"/>
  </method>
  <method name="Place">
    <arg name="x" type="i" direction="in"/><arg name="y" type="i" direction="in"/>
    <arg name="width" type="i" direction="in"/><arg name="height" type="i" direction="in"/>
    <arg name="ax" type="i" direction="in"/><arg name="ay" type="i" direction="in"/>
    <arg name="awidth" type="i" direction="in"/><arg name="aheight" type="i" direction="in"/>
  </method>
  <method name="Hide"/>
  <method name="SetSaves"><arg name="saves" type="b" direction="in"/></method>
  <method name="Scale"><arg name="scale" type="i" direction="out"/></method>
  <method name="SetScale"><arg name="scale" type="i" direction="in"/></method>
  <method name="SetDropping"><arg name="dropping" type="b" direction="in"/></method>
  <signal name="Dragging"><arg name="active" type="b"/></signal>
  <signal name="Hovering"><arg name="uris" type="as"/></signal>
  <signal name="Drawn"/>
  <signal name="Save"><arg name="uri" type="s"/></signal>
</interface></node>`);

/** Errors meaning the helper cannot be started at all. */
const CANNOT_START = [
    Gio.DBusError.SERVICE_UNKNOWN,
    Gio.DBusError.SPAWN_EXEC_FAILED,
    Gio.DBusError.SPAWN_FAILED,
    Gio.DBusError.SPAWN_CHILD_EXITED,
    Gio.DBusError.SPAWN_CHILD_SIGNALED,
];

/** How close (in CSS pixels) a drag must come to the island to open the shelf. */
const DRAG_PROXIMITY = 120;
/** How soon a new place for the window is looked at again; see `sync`. */
const RECHECK_MS = 24;
/** The helper's window fades in over the island's own tiles for this long (ms), then takes over from them. Shown at
 * once, a window that came up again could show its last, empty frame for one more before GTK's new one reached the
 * screen: the tiles beneath, already gone, left the tab blank for that frame. */
const FADE_IN_MS = 120;
/** A helper from before 1.5 never says it has drawn: its window shows this long (ms) after its first frame. */
const DRAWN_WAIT_MS = 300;
/** A `Drawn` this recent (µs) still counts for a window that comes up just after it. */
const DRAWN_RECENT_US = 500 * 1000;
/** How long the Files tab may take to settle before the window is placed without another change. */
const SETTLE_MS = 2000;
/** A drag that opened the shelf and then goes this far off closes it again. */
const DRAG_AWAY = 260;
/** What a drag of files offers; browsers' tabs and bookmarks carry a URI list too, and are left alone. */
const FILE_TYPES = ['text/uri-list', 'x-special/gnome-copied-files'];
const NOT_FILES = /tab|x-moz-place/;
/** A helper that quits this often while shown, within this long, is not started again until next login. */
const MAX_CRASHES = 3;
const CRASH_WINDOW_US = 10 * 60 * 1000 * 1000;
/** The helper's window, by its title or its program's name (in WM_CLASS). */
const WINDOW_NAMES = ['Isle shelf', 'isle-shelf'];
/** A window this much off the size asked for is drawn at another scale than the island's. */
const SCALE_SLACK = 0.1;
const MAX_CORRECTIONS = 2;

/** Whether the drag under way carries files; null while it offers nothing yet. */
function dragCarriesFiles() {
    const types = global.display.get_selection().get_mimetypes(Meta.SelectionType.SELECTION_DND);
    if (types.length === 0)
        return null;
    return types.some(type => FILE_TYPES.includes(type)) && !types.some(type => NOT_FILES.test(type));
}

/** Whether `window` is the helper's own, by title or WM_CLASS. */
function isHelperWindow(window) {
    return [window.get_title(), window.get_wm_class_instance(), window.get_wm_class()?.toLowerCase()]
        .some(name => WINDOW_NAMES.includes(name));
}

/** `rect` (stage pixels) as logical [x, y, width, height]: divided by `scale`, rounded inwards so the
 * window stays inside what the island covers. */
function logical({x, y, width, height}, scale) {
    const [left, top] = [Math.ceil(x / scale), Math.ceil(y / scale)];
    return [left, top, Math.floor((x + width) / scale) - left, Math.floor((y + height) / scale) - top];
}

// Signals: `drag-near`, `drag-over` (over the shelf or not), `drag-files` (the URIs over it), `drag-away` (went elsewhere),
// `drag-end` (a drag in or out ended; whether it ended over the shelf), `available-changed`, `save` (a URI, ↓ pressed).
export class ShelfHelper extends Signals.EventEmitter {
    /** Looks for the helper, watches drags, and catches its window as it maps. */
    constructor(island, page) {
        super();
        this._island = island;
        this._page = page;
        this._proxy = null;
        this._shownRect = null;
        /** Where the files sit in the shown window (the whole window but while a file is dragged in). */
        this._shownArea = null;
        /** A helper from before 1.0.1 has no ShowOver: the window then only ever covers the tab. */
        this._showsOver = true;
        /** One from before 1.0.7 has no Place: its window grows over the island only while a file comes in. */
        this._places = true;
        /** Waiting for the island's shape to cover the whole island before placing the window there. */
        this._awaitingBody = false;
        /** A file is being dragged out of the helper window. */
        this._dragging = false;
        /** Calls placing the window not answered yet, and the size the last one asked for (logical). */
        this._placing = 0;
        this._asked = null;
        /** The scale the helper was set to draw at (see `_checkScale`), for a new one to start at; null if never. */
        this._helperScale = null;
        this._scaledOwner = null;
        /** Stage pixels per logical one the helper takes, if not `uiScale` (one that can't be set to match). */
        this._unit = null;
        this._cancellable = new Gio.Cancellable();

        this._checkAvailable();
        this._watchDrags();
        // The overview covers windows, this one too: the tab shows its own tiles meanwhile.
        this._overviewIds = ['showing', 'hidden'].map(signal => Main.overview.connect(signal, () => this.sync()));
        // Its window comes up anew each time it shows (an X11 window that maps is a new one).
        this._windowAdded = global.top_window_group.connect('child-added', (_group, actor) => {
            if (actor instanceof Meta.WindowActor)
                this._watchWindow(actor.meta_window, {fresh: true});
        });
        /** Whether the window shows over the tab now (faded in), so the tab's own tiles can go. */
        this._windowShown = false;
        /** A window waiting to show (see `_watchWindow`), and when the helper last said it drew. */
        this._reveal = null;
        this._drawnAt = 0;
    }

    /** Whether the helper is installed, so files can be dropped on the shelf. */
    get available() {
        return this._proxy !== null;
    }

    /** Starts the helper without showing it (pinging its bus name activates it). */
    prepare() {
        if (!this._proxy || this._proxy.g_name_owner || this._preparing)
            return;
        this._preparing = true;
        Gio.DBus.session.call(BUS_NAME, OBJECT_PATH, 'org.freedesktop.DBus.Peer', 'Ping',
            null, null, Gio.DBusCallFlags.NONE, -1, this._cancellable, (connection, result) => {
                this._preparing = false;
                try {
                    connection.call_finish(result);
                } catch (e) {
                    if (!e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
                        console.warn(`Isle: could not start the shelf helper: ${e.message}`);
                }
            });
    }

    // Whether the pointer is over the helper or carrying a file out of it: either
    // way the island stays open, since hiding the window would end the drag.
    containsPointer() {
        if (this._dragging)
            return true;
        if (!this._shownRect)
            return false;
        const [x, y] = global.get_pointer();
        const {x: left, y: top, width, height} = this._shownRect;
        return x >= left && x < left + width && y >= top && y < top + height;
    }

    /** Shows or hides the helper to match the island. Cheap to call often. */
    sync() {
        if (!this._proxy)
            return;
        const wanted = this._wantedRect();
        if (!wanted) {
            this._candidate = null;
            // Mid-drag a passing layout change must not take the window from under the file: it would leave
            // and come back, and the light would blink. Nor while a file is carried out of it: the drag would end.
            if (Main.overview.visible || !(this._dragging || (this._dragNear && this._shownRect && this._page.active && this._page.visible && this._island.mapped)))
                this._hide();
            // Waiting for the shape to cover the island, or for the Files tab to settle (a fade cut short ends
            // with no event): looked at again for a while, as no other change may come.
            const settling = !this._shownRect && !Main.overview.visible && this._page.active && this._page.visible &&
                Boolean(this._page.helperArea?.mapped);
            if (!settling && !this._awaitingBody)
                this._settlingSince = 0;
            else if (!this._settlingSince)
                this._settlingSince = Date.now();
            if ((this._awaitingBody || (settling && Date.now() - this._settlingSince < SETTLE_MS)) && !this._recheck) {
                this._recheck = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECHECK_MS, () => {
                    this._recheck = 0;
                    this.sync();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        this._settlingSince = 0;
        const {rect, area} = wanted;
        const same = (a, b) => a && ['x', 'y', 'width', 'height'].every(key => a[key] === b[key]);
        if (same(this._shownRect, rect) && same(this._shownArea, area) && !this._resend)
            return;
        // Layout can be off for a frame while opening: a place counts only once the
        // recheck a frame later agrees, never a second call in the same frame.
        if (!same(this._candidate, rect) || !same(this._candidateArea, area) || this._recheck) {
            this._candidate = rect;
            this._candidateArea = area;
            if (!this._recheck) {
                this._recheck = GLib.timeout_add(GLib.PRIORITY_DEFAULT, RECHECK_MS, () => {
                    this._recheck = 0;
                    this.sync();
                    return GLib.SOURCE_REMOVE;
                });
            }
            return;
        }
        this._shownRect = rect;
        this._shownArea = area;
        this._resend = false;
        const shown = (_result, error) => {
            this._placing--;
            if (!this._proxy) // destroyed meanwhile
                return;
            if (error?.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD) && this._places) {
                this._places = false;
                this._shownRect = this._shownArea = null;
                this.sync();
                return;
            }
            if (error?.matches(Gio.DBusError, Gio.DBusError.UNKNOWN_METHOD) && this._showsOver) {
                this._showsOver = false;
                this._shownRect = this._shownArea = null;
                this.sync();
                return;
            }
            if (!error) {
                // The island's own tiles stay until the window has faded in over them (see `_watchWindow`),
                // so the tab is never blank in between, nor do the two tell apart.
                if (this._shownRect && this._windowShown)
                    this._page.helperActive = true;
                if (!this._window)
                    global.get_window_actors().forEach(actor => this._watchWindow(actor.meta_window));
                this._checkScale();
                return;
            }
            console.warn(`Isle: shelf helper failed to show: ${error.message}`);
            // A helper that cannot start (broken install) or hangs (no display) is not
            // retried; the page keeps its own tiles until next login.
            if (error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.TIMED_OUT)) {
                // It may still get to the Show later; a Hide queued behind
                // it keeps the window from staying up for good.
                this._proxy.HideRemote(() => {});
                this._proxy = null;
            } else if (CANNOT_START.some(code => error.matches(Gio.DBusError, code))) {
                this._proxy = null;
            }
            if (!this._proxy)
                this.emit('available-changed');
            // Forget the placement so the next sync tries again.
            this._shownRect = this._shownArea = null;
            this._page.helperActive = false;
        };
        // The helper takes GTK's logical pixels, which it multiplies by its own scale.
        const unit = this._unit ?? uiScale();
        const [x, y, width, height] = logical(rect, unit);
        const [ax, ay, awidth, aheight] = logical(area, unit);
        this._asked = {x, y, width, height};
        this._placing++;
        // A new helper starts at the scale an earlier one had to be set to.
        const owner = this._proxy.g_name_owner;
        if (this._helperScale && (!owner || owner !== this._scaledOwner)) {
            this._scaledOwner = owner;
            this._proxy.SetScaleRemote(this._helperScale, () => {});
        }
        if (this._places)
            this._proxy.PlaceRemote(x, y, width, height, ax, ay, awidth, aheight, shown);
        else if (same(rect, area))
            this._proxy.ShowRemote(x, y, width, height, shown);
        else
            this._proxy.ShowOverRemote(x, y, width, height, ax, ay, awidth, aheight, shown);
    }

    /** Where the window goes ({rect, area}: the tab inside it) once the island's shape covers both, else null.
     * The whole island, so a drop lands anywhere; an older helper covers it only while a file comes in. */
    _wantedRect() {
        const page = this._page;
        const area = page.helperArea;
        // Fully shown, the island's fade in over too: the window, which doesn't fade with it, would come
        // ahead of the rest.
        if (!area || Main.overview.visible || !page.active || !page.visible || !area.mapped ||
            page.translation_x !== 0 || area.get_paint_opacity() !== 255)
            return null;
        // First shown once the shape covers it; after that its last bounces (a moment smaller than it
        // settles) must not take the window down and up again, so it is held while the shape will cover it.
        const held = Boolean(this._shownRect);
        const covers = rect => this._island.covers(rect) || (held && this._island.willCover(rect));
        const tab = this._island.restingRect(area);
        if (!tab?.width || !tab.height || !covers(tab))
            return null;
        // A pixel in from the sides and bottom: the shape's edges can fall between pixels.
        const whole = this._showsOver && (this._places || this._dragNear) ? this._island.restingRect() : null;
        const body = whole && {x: whole.x + 1, y: whole.y, width: whole.width - 2, height: whole.height - 1};
        const inside = body?.width && body.height && covers(body) &&
            tab.x >= body.x && tab.y >= body.y && tab.x + tab.width <= body.x + body.width &&
            tab.y + tab.height <= body.y + body.height;
        // Placed once, where it will stay: not over the tab first and the whole island a frame later. Only while
        // the shape still moves; settled short of it (rounding), it goes over the tab.
        this._awaitingBody = Boolean(this._places && body && !inside && !held && this._island.morphing &&
            this._island.willCover(body));
        if (this._awaitingBody)
            return null;
        return {rect: inside ? body : tab, area: tab};
    }

    /** Follows the helper's window while it is up, to check its size (see `_checkScale`). One just mapped
     * (`fresh`) shows over the tab's own tiles, which go once it is in. */
    _watchWindow(window, {fresh = false} = {}) {
        if (!window || window === this._window || !isHelperWindow(window))
            return;
        this._forgetWindow();
        this._window = window;
        this._windowIds = [
            window.connect('size-changed', () => this._checkScale()),
            window.connect('unmanaged', () => this._forgetWindow()),
        ];
        const actor = window.get_compositor_private();
        if (fresh && actor) {
            // Hidden until it has both a frame on screen and GTK's drawing in it: a window just mapped can show
            // what X had before GTK drew (black). A helper that never says it drew is waited for a moment.
            actor.opacity = 0;
            // A `Drawn` just before this window came up is this window's, used once.
            const early = Boolean(this._drawnAt) && GLib.get_monotonic_time() - this._drawnAt < DRAWN_RECENT_US;
            this._drawnAt = 0;
            const reveal = this._reveal = {
                framed: false,
                drawn: early,
                timer: 0,
                actor,
                frameId: 0,
                show: () => {
                    if (this._reveal !== reveal || !reveal.framed || !reveal.drawn)
                        return;
                    this._cancelReveal();
                    // Over the tab's own tiles, the same to the pixel: they stay, whole, until it is in (`helperActive`).
                    actor.ease({
                        opacity: 255,
                        duration: FADE_IN_MS,
                        mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                        onStopped: () => this._windowIn(window),
                    });
                },
            };
            reveal.frameId = actor.connect('first-frame', () => {
                actor.disconnect(reveal.frameId);
                reveal.frameId = 0;
                if (this._reveal !== reveal)
                    return;
                reveal.framed = true;
                if (!reveal.drawn) {
                    reveal.timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, DRAWN_WAIT_MS, () => {
                        reveal.timer = 0;
                        reveal.drawn = true;
                        reveal.show();
                        return GLib.SOURCE_REMOVE;
                    });
                }
                reveal.show();
            });
        } else {
            this._windowIn(window);
        }
        this._checkScale();
    }

    /** The window is in over the tab: the tab's own tiles can go. */
    _windowIn(window) {
        if (window !== this._window)
            return;
        this._windowShown = true;
        if (this._shownRect && this._placing === 0)
            this._page.helperActive = true;
    }

    /** Stops waiting to fade a window in. */
    _cancelReveal() {
        const reveal = this._reveal;
        if (reveal?.timer)
            GLib.source_remove(reveal.timer);
        if (reveal?.frameId)
            reveal.actor.disconnect(reveal.frameId);
        this._reveal = null;
    }

    /** Lets go of the helper's window once it is gone. */
    _forgetWindow() {
        this._cancelReveal();
        this._windowIds?.forEach(id => this._window.disconnect(id));
        this._windowIds = null;
        this._window = null;
        this._windowShown = false;
    }

    // GTK in the helper may start before GNOME tells X11 apps the scale, and draw the window at another size
    // than the island's: then (only) it is set to the scale that matches, and placed again.
    _checkScale() {
        const window = this._window, asked = this._asked;
        if (!window || !asked?.width || !asked.height || !this._proxy || !this._shownRect || this._placing > 0 ||
            this._scaling)
            return;
        const frame = window.get_frame_rect();
        const across = frame.width / asked.width;
        const off = value => Math.abs(value - across) > SCALE_SLACK * across;
        // Still at an earlier place's size or spot (its sides disagree): its next size tells.
        if (!across || off(frame.height / asked.height) || (asked.x > 0 && off(frame.x / asked.x)))
            return;
        const unit = this._unit ?? uiScale();
        if (Math.abs(across / unit - 1) <= SCALE_SLACK)
            return;
        // Twice at most for each helper: one that can't be set right is left be, not placed again and again.
        const owner = this._proxy.g_name_owner;
        if (owner !== this._checkedOwner)
            [this._checkedOwner, this._corrections] = [owner, 0];
        if (this._corrections >= MAX_CORRECTIONS)
            return;
        this._corrections++;
        this._scaling = true;
        const done = () => {
            this._scaling = false;
            this._resend = true;
            this.sync();
        };
        this._proxy.ScaleRemote((result, error) => {
            if (!this._proxy) {
                this._scaling = false;
                return;
            }
            const wanted = error ? 0 : result[0] * uiScale() / across;
            const whole = Math.round(wanted);
            if (whole < 1 || whole > 4 || Math.abs(wanted - whole) > SCALE_SLACK * whole) {
                // An older helper, or a scale GTK can't draw at: the window at least goes where it belongs.
                console.warn(`Isle: the shelf helper's window is ${across} stage pixels to its one; placing it by that`);
                this._unit = across;
                done();
                return;
            }
            this._unit = null;
            this._proxy.SetScaleRemote(whole, (_result, setError) => {
                if (setError)
                    this._unit = across;
                else
                    [this._helperScale, this._scaledOwner] = [whole, this._proxy?.g_name_owner ?? null];
                done();
            });
        });
    }

    /** Takes the window down and gives the tab its own tiles back. */
    _hide() {
        this._resend = false;
        if (!this._shownRect)
            return;
        this._shownRect = this._shownArea = null;
        this._windowShown = false;
        this._page.helperActive = false;
        this._proxy?.HideRemote(() => {});
    }

    /** Makes the proxy only if the helper is installed (its bus name can be activated). */
    _checkAvailable() {
        Gio.DBus.session.call(
            'org.freedesktop.DBus', '/org/freedesktop/DBus', 'org.freedesktop.DBus',
            'ListActivatableNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this._cancellable,
            (connection, result) => {
                let names;
                try {
                    [names] = connection.call_finish(result).deep_unpack();
                } catch {
                    return;
                }
                if (!names.includes(BUS_NAME))
                    return;
                // The helper starts on the first call rather than right away.
                new ShelfWindowProxy(Gio.DBus.session, BUS_NAME, OBJECT_PATH, (proxy, error) => {
                    if (error)
                        return;
                    this._proxy = proxy;
                    this.emit('available-changed');
                    this._draggingId = proxy.connectSignal('Dragging', (_proxy, _sender, [active]) => {
                        this._dragging = active;
                        // Dropped somewhere, or nowhere: the island may close now.
                        if (!active)
                            this.emit('drag-end');
                    });
                    // Before 1.0 the helper never says; the light keeps its own colours then.
                    this._hoveringId = proxy.connectSignal('Hovering', (_proxy, _sender, [uris]) =>
                        this.emit('drag-files', uris));
                    // 1.5: the window drew since it came up; it shows on that (see `_watchWindow`).
                    this._drawnId = proxy.connectSignal('Drawn', () => {
                        if (this._reveal) {
                            this._reveal.drawn = true;
                            this._reveal.show();
                        } else if (!this._window) {
                            // Before its window is seen: kept for it (see `_watchWindow`).
                            this._drawnAt = GLib.get_monotonic_time();
                        }
                    });
                    // 1.5.4: ↓ on a file the Shelf keeps itself, saved by the extension as from its own tile; the
                    // helper shows ↓ only once told this extension does (an older helper has no SetSaves).
                    this._saveId = proxy.connectSignal('Save', (_proxy, _sender, [uri]) => this.emit('save', uri));
                    this._signalProxy = proxy;
                    this._ownerId = proxy.connect('notify::g-name-owner', () => this._onOwnerChanged(proxy));
                    this._saySaves(proxy);
                    this.sync();
                }, this._cancellable, Gio.DBusProxyFlags.DO_NOT_AUTO_START_AT_CONSTRUCTION);
            });
    }

    /** Tells a running helper this extension saves files on its Save, so it shows ↓; an older helper (no
     * SetSaves) shows none anyway. Never starts one. */
    _saySaves(proxy) {
        if (proxy.g_name_owner)
            proxy.call('SetSaves', new GLib.Variant('(b)', [true]), Gio.DBusCallFlags.NO_AUTO_START, -1, null, () => {});
    }

    /** The helper started or quit; too many quits while shown and it is given up. */
    _onOwnerChanged(proxy) {
        if (proxy.g_name_owner) {
            this._saySaves(proxy);
            // Started again (after a crash, or quitting as the drag began): it must hear of the drag too.
            if (this._dragNear)
                this._setDropping(true);
            return;
        }
        // A helper that quits mid-drag never says the drag ended.
        if (this._dragging) {
            this._dragging = false;
            this.emit('drag-end');
        }
        if (!this._shownRect)
            return;
        // Gone while shown (it crashed): the tab shows its own tiles again, and the next place starts a new one.
        this._shownRect = this._shownArea = null;
        this._page.helperActive = false;
        const now = GLib.get_monotonic_time();
        this._crashes = [...(this._crashes ?? []).filter(at => now - at < CRASH_WINDOW_US), now];
        if (this._crashes.length >= MAX_CRASHES) {
            console.warn('Isle: the shelf helper keeps quitting; dropping files is off until next login');
            this._proxy = null;
            this.emit('available-changed');
            return;
        }
        this.sync();
    }

    /** Opens the shelf when a drag nears the island; closes it if the drag goes elsewhere. */
    _watchDrags() {
        this._dnd = global.backend.get_dnd();
        this._dragNear = false;
        this._dragSeen = false;
        this._dragOver = false;
        /** Whether the drag under way carries files; null until it is known. */
        this._dragFiles = null;
        this._dndPosition = this._dnd.connect('dnd-position-change', (_dnd, x, y) => {
            // Not for a file carried out of the shelf itself, nor with the Shelf left out (a drag already near ends as it was).
            if (this._dragging || !this._proxy || (this._page.hidden && !this._dragNear))
                return;
            // Only files (or links): a browser tab or text moved about near the island is left alone.
            this._dragFiles ??= dragCarriesFiles();
            if (!this._dragFiles)
                return;
            this._setDragOver(this._dragNear && this._over(x, y));
            if (!this._dragSeen) {
                this._dragSeen = true;
                this.prepare();
            }
            const distance = this._distanceToIsland(x, y);
            if (!this._dragNear && distance < px(DRAG_PROXIMITY)) {
                this._dragNear = true;
                this._setDropping(true);
                this.emit('drag-near');
                this.sync();
            } else if (this._dragNear && distance > px(DRAG_AWAY)) {
                this._dragNear = false;
                this._setDragOver(false);
                this._setDropping(false);
                this.emit('drag-away');
                this.sync();
            }
        });
        this._dndLeave = this._dnd.connect('dnd-leave', () => {
            this._dragSeen = false;
            this._dragFiles = null;
            if (this._dragNear) {
                // Quietly: the drop's end says where it was let go.
                const over = this._dragOver;
                this._dragNear = this._dragOver = false;
                this._setDropping(false);
                this.emit('drag-end', over);
                // Back to the tab alone, so the island's tabs take clicks again.
                this.sync();
            }
        });
    }

    /** Whether (x, y) is on the shown window, where a drop lands. */
    _over(x, y) {
        const rect = this._shownRect;
        return Boolean(rect) && x >= rect.x && x < rect.x + rect.width && y >= rect.y && y < rect.y + rect.height;
    }

    /** Emits `drag-over` when the drag crosses the window's edge. */
    _setDragOver(over) {
        if (over === this._dragOver)
            return;
        this._dragOver = over;
        this.emit('drag-over', over);
    }

    /** How far (x, y) is from the island; 0 on it, or above it in the top bar. */
    _distanceToIsland(x, y) {
        const [left, top] = this._island.get_transformed_position();
        const [width, height] = this._island.get_transformed_size();
        const dx = Math.max(left - x, 0, x - (left + width));
        const dy = Math.max(top - y, 0, y - (top + height));
        return Math.hypot(dx, dy);
    }

    /** Tells the helper a file is on its way, so it shows where it will land. */
    _setDropping(dropping) {
        // A helper from before 0.2 has no such method; it just does without.
        this._proxy?.SetDroppingRemote(dropping, () => {});
    }

    /** Disconnects everything and hides the window. */
    destroy() {
        // Tell no one about changes made while tearing down.
        this.disconnectAll();
        if (this._recheck)
            GLib.source_remove(this._recheck);
        this._cancellable.cancel();
        this._overviewIds.forEach(id => Main.overview.disconnect(id));
        global.top_window_group.disconnect(this._windowAdded);
        this._forgetWindow();
        this._dnd.disconnect(this._dndPosition);
        this._dnd.disconnect(this._dndLeave);
        this._hide();
        if (this._draggingId) {
            this._signalProxy.disconnectSignal(this._draggingId);
            this._signalProxy.disconnectSignal(this._hoveringId);
            this._signalProxy.disconnectSignal(this._drawnId);
            this._signalProxy.disconnectSignal(this._saveId);
            this._signalProxy.disconnect(this._ownerId);
        }
        this._proxy = null;
    }
}
