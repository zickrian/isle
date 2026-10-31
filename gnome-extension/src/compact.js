// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The resting island: the clock, a moon before it in Do Not Disturb, between one sign on each side. Left: the first
// live activity (recording, call, music, timer). Right: a warning, a call's muted microphone, the next activity's
// sign, or what goes with the first (the song's bars, the timer's time left); then the privacy dots. It is as wide
// as what it shows: both sides as wide as the wider, each sign as far in from its end as from the top and bottom.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {paletteFor} from './bot.js';
import {BotIcon} from './botIcon.js';
import {onUiScale, px, uiScale} from './compat.js';
import * as Format from './format.js';
import * as Palette from './palette.js';
import * as Playback from './playback.js';
import * as Theme from './theme.js';
import {watchClock} from './wallClock.js';
import {Art, Bars, PrivacyDots, RecordingDot, Ring, icon, restsAt} from './widgets.js';

/** Sizes hanging below the top bar, and inside it with smaller text, in CSS pixels. `clock` is the
 * island with nothing beside the clock, and the least it gets beside an activity. */
const SIZES = {
    hanging: {clock: 164, art: 24, artRadius: 6, ring: 20, bars: 16, moon: 14, call: 15, bot: 19.5},
    inBar: {clock: 144, art: 22, artRadius: 6, ring: 18, bars: 14, moon: 13, call: 14, bot: 17.5},
};
/** The island's height below the top bar, or in it, until it is laid out (see `vfunc_allocate`); and its
 * corners' radius (COMPACT_RADIUS and IN_BAR_RADIUS in controller.js). */
const PILL_HEIGHT = {hanging: 30, inBar: 32};
const CORNER_RADIUS = {hanging: 16, inBar: 10};
/** How far in from the island's end text on the right sits, in CSS pixels: as far as the round sign's ink on the
 * left looks, where the inset that suits a round sign would crowd text. */
const TEXT_INSET = {hanging: 13, inBar: 10};
/** Between the Do Not Disturb moon and the time, in CSS pixels (as .isle-compact-clock-box's spacing). */
const MOON_GAP = 6;
/** The music bars' opacity while the song is paused. */
const PAUSED_OPACITY = 110;
/** How often the focus ring is redrawn; it moves too slowly to need more. */
const RING_REFRESH_S = 5;
/** The focus timer's colour: white while focusing, green on a break. */
export function timerColor(phase) {
    return phase === 'focus' || phase === 'idle' ? Palette.WHITE : Palette.GREEN;
}

/** Lays each child at its own size, centred, even past its box: a time fading out as a narrower one fades in
 * (the clock giving way to a recording's length) keeps its place, centred, rather than being pushed aside. */
const CentreLayout = GObject.registerClass(
class CentreLayout extends Clutter.LayoutManager {
    vfunc_get_preferred_width(container, _forHeight) {
        // No least width: given less (a wider time still fading out), it lets its child run past its edges.
        const widths = container.get_children().filter(child => child.visible).map(child => child.get_preferred_width(-1));
        return [0, Math.max(0, ...widths.map(([, natural]) => natural))];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        const heights = container.get_children().filter(child => child.visible).map(child => child.get_preferred_height(-1));
        return [Math.max(0, ...heights.map(([min]) => min)), Math.max(0, ...heights.map(([, natural]) => natural))];
    }

    vfunc_allocate(container, box) {
        for (const child of container.get_children().filter(each => each.visible)) {
            const [, width] = child.get_preferred_width(-1);
            const [, height] = child.get_preferred_height(width);
            const x = Math.round(box.x1 + (box.get_width() - width) / 2), y = Math.round(box.y1 + (box.get_height() - height) / 2);
            child.allocate(new Clutter.ActorBox({x1: x, y1: y, x2: x + width, y2: y + height}));
        }
    }
});

/** The closed island's contents; emits `width-changed` when it needs another width. */
export const CompactView = GObject.registerClass({
    Signals: {'width-changed': {}},
}, class CompactView extends St.Widget {
    /** `privacy` and `call` are the shell's recording and call watchers. */
    _init(daemon, settings, privacy, call) {
        super._init({
            style_class: 'isle-compact',
            layout_manager: new Clutter.BinLayout(),
        });
        this._daemon = daemon;
        this._settings = settings;
        this._privacy = privacy;
        this._call = call;
        this._idle = false;
        this._inBar = false;
        this._timeouts = {};

        const row = new St.BoxLayout({style_class: 'isle-compact-row', x_expand: true, y_expand: true});
        this._row = row;
        this.add_child(row);

        // Each side's padding is its gap to the centre; `_fit` makes both as wide as the wider side. A sign sits
        // centred in a square as big as the cover at the island's end, so a round one is concentric with it.
        this._left = new St.Bin({style_class: 'isle-compact-slot isle-compact-start', x_expand: false, y_align: Clutter.ActorAlign.CENTER});
        this._lead = new St.Bin({x_expand: true, x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.CENTER});
        this._left.child = this._lead;
        // The timer alone: a still timer glyph, its time left on the right (no ring: the time says it). With the
        // privacy dots on the right, its ring instead, so neither side runs long.
        this._timerIcon = new St.Icon({gicon: icon('isle-timer-symbolic'), icon_size: 15, y_align: Clutter.ActorAlign.CENTER});
        this._ring = new Ring({size: 20, lineWidth: 3});
        this._art = new Art({size: 24, radius: 6});
        this._dot = new St.Widget({style_class: 'isle-unseen-dot', y_align: Clutter.ActorAlign.CENTER});
        this._recordingDot = new RecordingDot();
        // A call: a green phone, and on the right a red microphone while it is muted.
        this._phone = new St.Icon({gicon: icon('isle-phone-symbolic'), icon_size: 15, style_class: 'isle-call-icon', y_align: Clutter.ActorAlign.CENTER});
        this._micOff = new St.Icon({gicon: icon('isle-mic-off-symbolic'), icon_size: 15, style_class: 'isle-call-muted', y_align: Clutter.ActorAlign.CENTER});
        // isled is not running: what needs it cannot work (see the controller's service watch).
        this._serviceDown = new St.Icon({gicon: icon('dialog-warning-symbolic'), icon_size: 15, style_class: 'isle-compact-warning', y_align: Clutter.ActorAlign.CENTER});
        // The assistant at work with the island closed: still, but for a blink and a glance every few seconds.
        // In a slot as big as the cover's, as far in from the edge; a little smaller, as a solid shape looks bigger.
        this._assistant = new BotIcon(SIZES.hanging.art, this._botLook(), {body: SIZES.hanging.bot});
        this._assistant.y_align = Clutter.ActorAlign.CENTER;
        this._botLookChanged = ['bot-shape', 'bot-color', 'bot-glow'].map(key =>
            settings.connect(`changed::${key}`, () => (this._assistant.look = this._botLook())));

        const center = new St.Widget({layout_manager: new CentreLayout(), x_expand: true});
        const times = new St.Widget({layout_manager: new CentreLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._clock = new St.Label({style_class: 'isle-compact-clock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        // How long the screen has been recording, in place of the clock. A call keeps the clock.
        this._elapsed = new St.Label({style_class: 'isle-compact-clock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false});
        // Never "1:0…": the one fading out may be wider than the room left for the one fading in.
        for (const time of [this._clock, this._elapsed])
            time.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        times.add_child(this._clock);
        times.add_child(this._elapsed);
        // Do Not Disturb: a moon before the time (or what takes its place), whatever the sides hold.
        this._moon = new St.Icon({gicon: icon('isle-moon'), icon_size: 14, style_class: 'isle-dnd-moon', y_align: Clutter.ActorAlign.CENTER, visible: false});
        // As wide as the moon after the time, so the time itself is centred and the moon hangs before it.
        this._moonBalance = new St.Widget({visible: false});
        this._centerRow = new St.BoxLayout({style_class: 'isle-compact-clock-box', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        this._centerRow.add_child(this._moon);
        this._centerRow.add_child(times);
        this._centerRow.add_child(this._moonBalance);
        center.add_child(this._centerRow);

        // The right side: its sign in a square as the left's (or the timer's time), then the privacy dots, at the
        // island's end; its x_expand only aligns it in the side, which is told not to expand.
        this._rightSide = new St.Bin({style_class: 'isle-compact-slot isle-compact-end', x_expand: false, y_align: Clutter.ActorAlign.CENTER});
        this._trail = new St.BoxLayout({style_class: 'isle-compact-trail', x_expand: true, x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.CENTER});
        this._rightSide.child = this._trail;
        this._right = new St.Bin({x_expand: false, y_align: Clutter.ActorAlign.CENTER});
        this._trail.add_child(this._right);
        this._privacyDots = new PrivacyDots();
        this._trail.add_child(this._privacyDots);
        this._bars = new Bars({height: 16});
        // The timer's time left, right of its ring, as large as the clock and level with it.
        this._timerTime = new St.Label({style_class: 'isle-compact-second-time', y_align: Clutter.ActorAlign.CENTER});
        this._timerTime.clutter_text.ellipsize = Pango.EllipsizeMode.NONE;
        // The next activity's sign: the timer's ring, a song's cover, a call's green phone (its length is on the open
        // island's pages).
        this._secondRing = new Ring({size: 20, lineWidth: 3});
        this._secondArt = new Art({size: 24, radius: 6});
        this._secondPhone = new St.Icon({gicon: icon('isle-phone-symbolic'), icon_size: 15, style_class: 'isle-call-icon', y_align: Clutter.ActorAlign.CENTER});
        /** The width the island needs for both sides around the centre, in stage pixels (0: no activity). */
        this._contentWidth = 0;
        /** The island's height where the signs sit, in stage pixels, once laid out; and the inset it gives. */
        this._pillHeight = 0;
        this._inset = -1;
        // The sides are told not to expand, or their children's x_expand (which the alignment needs) would widen them.
        for (const actor of [this._timerIcon, this._ring, this._art, this._dot, this._recordingDot, this._phone, this._bars, this._micOff,
            this._serviceDown, this._assistant, this._secondRing, this._secondArt, this._secondPhone])
            actor.set({x_align: Clutter.ActorAlign.CENTER, x_expand: true});
        // From its square's start: the room `_fit` leaves after it keeps it off the island's end.
        this._timerTime.set({x_align: Clutter.ActorAlign.START, x_expand: true});

        row.add_child(this._left);
        row.add_child(center);
        row.add_child(this._rightSide);

        this._daemonChanged = daemon.connect('changed', (_daemon, key) => {
            if (['nowPlaying', 'pomodoro'].includes(key))
                this._refresh();
        });
        this._settingsChanged = settings.connect('changed::privacy-indicators', () => this._refresh());
        this._pagesChanged = settings.connect('changed::hidden-pages', () => this._refresh());
        this._privacyChanged = privacy.connect('changed', () => this._refresh());
        this._callChanged = call.connect('changed', () => this._refresh());
        // Music bars only dance, and the times and the timer's ring only tick, while this view is on screen.
        this.connect('notify::mapped', () => {
            this._syncBars();
            this._tickRecording();
            this._refreshRing();
            this._tickSecond();
            // Measure what could not be off the stage: the sides and the centre.
            if (this.mapped)
                this._refit();
        });
        this._tickClock();
        this._stopClock = watchClock(() => this._tickClock());
        this._refresh();
        // Another scale: the signs sized for it first (their own updates may come after this one), then measured.
        onUiScale(this, () => {
            this._sizeSigns();
            this._refresh();
        }, {now: false});
        this.connect('destroy', () => this._onDestroy());
    }

    /** The theme changed (the island asks, see its `refreshTheme`): the timer's colours follow it. */
    syncTheme() {
        this._refresh();
    }

    /** Its clock stays where it is as the island widens or narrows (see island.js `_onViewWidth`). */
    get keepsMiddle() {
        return true;
    }

    /** The width the island should have to fit what is shown. */
    get preferredWidth() {
        const size = SIZES[this._inBar ? 'inBar' : 'hanging'];
        // The clock alone (the island widens for the moon), and no narrower beside an activity.
        const moon = this._moon.visible ? size.moon + MOON_GAP : 0;
        return Math.max(px(size.clock + moon), this._contentWidth);
    }

    /** Sizes both sides as wide as the wider (its sign, and its gap to the centre), and finds the width
     * that holds them around the centre. The privacy dots count in the right side. */
    _fit() {
        // Measured only on the stage; off it, the next refresh or showing does it.
        const stage = Boolean(this.get_stage());
        const widthOf = actor => (actor && stage ? Math.ceil(actor.get_preferred_width(-1)[1]) : 0);
        const size = SIZES[this._inBar ? 'inBar' : 'hanging'];
        // Set only when it changes: each refresh (a song's every update) would lay the row out again.
        const setWidth = (actor, width) => {
            if (!actor.natural_width_set || actor.natural_width !== width)
                actor.width = width;
        };
        // Each end's square as far in as it is from the top and bottom, and the cover's corner no nearer the
        // island's than that (a hanging island's are wider), in CSS pixels (St scales the style).
        const place = this._inBar ? 'inBar' : 'hanging';
        const pill = this._pillHeight / uiScale() || PILL_HEIGHT[place];
        const inset = Math.max(0, Math.round((pill - size.art) / 2), CORNER_RADIUS[place] - size.artRadius);
        if (inset !== this._inset) {
            this._inset = inset;
            this._row.style = `padding: 0 ${inset}px;`;
        }
        const square = Math.round(px(size.art));
        setWidth(this._lead, square);
        // Each part measured itself, never a box round one just resized: Clutter may still hand back the box's
        // size from before (a paused timer's time ran past the island's end so).
        const dots = this._privacyDots.visible ? widthOf(this._privacyDots) : 0;
        // Text last on the right keeps further in than a round sign.
        const text = this._right.child === this._timerTime && !dots ? Math.round(px(Math.max(0, TEXT_INSET[place] - inset))) : 0;
        const right = this._right.visible ? Math.max(square, widthOf(this._right.child) + text) : 0;
        setWidth(this._right, right || square);
        const spacing = right && dots && stage ? this._trail.get_theme_node().get_length('spacing') : 0;
        // The dots alone sit in the end's square, as a sign would.
        this._trail.x_align = right ? Clutter.ActorAlign.END : Clutter.ActorAlign.CENTER;
        const side = Math.max(this._lead.visible ? square : 0, right + spacing + dots, dots && square);
        // Off the stage (Isle starting mid-song) there is no style to read: St complains and returns a blank one.
        const gap = side && stage ? this._left.get_theme_node().get_padding(St.Side.RIGHT) : 0;
        for (const slot of [this._left, this._rightSide])
            setWidth(slot, side && side + gap);
        const moon = this._moon.visible ? widthOf(this._moon) : 0;
        setWidth(this._moonBalance, moon);
        this._moonBalance.visible = this._moon.visible;
        if (!side) {
            this._contentWidth = 0;
            return;
        }
        // The time shown, not both while one fades into the other; the moon's room on both sides of it.
        const time = this._privacy.recording ? this._elapsed : this._clock;
        const center = widthOf(time) + (moon ? 2 * (moon + this._centerRow.get_theme_node().get_length('spacing')) : 0);
        const width = 2 * px(inset) + 2 * (side + gap) + center;
        // Even, so the centre sits on whole pixels.
        this._contentWidth = 2 * Math.ceil(width / 2);
    }

    /** The island's height sets how far in the signs sit: measured again when it changes. */
    vfunc_allocate(box) {
        super.vfunc_allocate(box);
        const height = box.get_height() - this.get_theme_node().get_padding(St.Side.TOP);
        if (height > 0 && Math.abs(height - this._pillHeight) >= 0.5) {
            this._pillHeight = height;
            // Not while being laid out: the island takes another width from it.
            this._later('inset', 0, () => this._refit());
        }
    }

    /** Measures again after a time changed its length, asking for another width if it needs one. */
    _refit() {
        const widthBefore = this.preferredWidth;
        this._fit();
        if (this.preferredWidth !== widthBefore)
            this.emit('width-changed');
    }

    /** Privacy dots are on in Settings and something is using the camera, microphone or screen. */
    _showingPrivacy() {
        return this._settings.get_boolean('privacy-indicators') && this._privacy.any;
    }

    /** Shows a dot for unseen notifications when nothing else is on the left. */
    set unseenNotifications(unseen) {
        if (unseen === this._unseen)
            return;
        this._unseen = unseen;
        this._refresh();
    }

    /** Shows a moon before the time while Do Not Disturb is on. */
    set doNotDisturb(on) {
        if (on === this._moon.visible)
            return;
        // Measured before it shows: the clock alone makes room for it (see `preferredWidth`).
        const widthBefore = this.preferredWidth;
        this._moon.visible = on;
        this._fit();
        if (this.preferredWidth !== widthBefore)
            this.emit('width-changed');
    }

    /** Shows that isled is not running, on the right before anything else. */
    get serviceDown() {
        return Boolean(this._isServiceDown);
    }

    /** Set by the controller's service watch. */
    set serviceDown(down) {
        if (down === Boolean(this._isServiceDown))
            return;
        this._isServiceDown = down;
        this._refresh();
    }

    /** Shows that the assistant works on a request, on the right, first of all. */
    set assistantBusy(busy) {
        if (busy === Boolean(this._assistantBusy))
            return;
        this._assistantBusy = busy;
        this._refresh();
    }

    /** Fits the view inside the top bar, like a notch, or below it. */
    set inBar(inBar) {
        if (inBar === this._inBar)
            return;
        this._inBar = inBar;
        // Its height there is known once laid out; till then, the usual one.
        this._pillHeight = 0;
        const size = SIZES[inBar ? 'inBar' : 'hanging'];
        this._sizeSigns();
        this._bars.maxHeight = size.bars;
        this._moon.icon_size = size.moon;
        this._phone.icon_size = this._micOff.icon_size = this._secondPhone.icon_size = this._timerIcon.icon_size = size.call;
        if (inBar)
            this.add_style_class_name('isle-compact-in-bar');
        else
            this.remove_style_class_name('isle-compact-in-bar');
        this._refresh();
    }

    /** Sizes the signs set in stage pixels (cover, assistant, ring) for the place and the scale. */
    _sizeSigns() {
        const size = SIZES[this._inBar ? 'inBar' : 'hanging'];
        this._art.resize(size.art, size.artRadius);
        this._secondArt.resize(size.art, size.artRadius);
        this._assistant.resize(size.art, size.bot);
        this._ring.resize(size.ring);
        this._secondRing.resize(size.ring);
    }

    /** Whether the user is away (no input for a while); the bars rest meanwhile, nobody is watching. */
    get idle() {
        return this._idle;
    }

    /** Starts or rests the bars. */
    set idle(idle) {
        this._idle = idle;
        this._syncBars();
    }

    /** Picks what each side shows, and emits `width-changed` when the island needs another width. */
    _refresh() {
        const {nowPlaying, pomodoro} = this._daemon.state;
        const playing = Playback.isPlaying(nowPlaying);
        // A paused song stays until its player closes; none with the Music page left out.
        const hasTrack = Playback.hasTrack(nowPlaying) && !this._settings.get_strv('hidden-pages').includes('music');
        const timerActive = pomodoro && pomodoro.phase !== 'idle';
        const recording = this._privacy.recording;
        const onCall = this._call.active;
        const widthBefore = this.preferredWidth;

        // The first activity that applies takes the left: recording, a call, the music, the timer. The next, if any,
        // shows its sign on the right; the rest only on the open island.
        const activities = [recording && 'recording', onCall && 'call', hasTrack && 'music', timerActive && 'timer']
            .filter(Boolean);
        const [primary, second] = activities;
        // On a call the green phone already says the microphone is on, unless another app records too.
        const privacy = this._showingPrivacy() ? this._privacy : {};
        const microphone = privacy.microphone && (!onCall || this._call.othersRecording);
        const dots = {camera: privacy.camera, microphone, screenShare: privacy.screenShare};
        const anyDot = Object.values(dots).some(Boolean);
        // Left: the activity's sign, else the unread dot.
        const timerSign = anyDot ? this._ring : this._timerIcon;
        let left = {recording: this._recordingDot, call: this._phone, music: this._art, timer: timerSign}[primary] ?? null;
        if (!left && this._unseen)
            left = this._dot;
        if (this._lead.child !== left)
            this._swap(this._lead, left);
        this._lead.visible = Boolean(left);
        // Right, the first that applies: isled down, the assistant at work, a call's muted microphone, the next
        // activity's sign, what goes with the first (the song's bars, the timer's time left).
        let right = second ? {music: this._secondArt, timer: this._secondRing, call: this._secondPhone}[second]
            : {music: this._bars, timer: anyDot ? null : this._timerTime}[primary] ?? null;
        if (onCall && this._call.muted)
            right = this._micOff;
        if (this._assistantBusy)
            right = this._assistant;
        this._assistant.alive = right === this._assistant;
        if (this._isServiceDown)
            right = this._serviceDown;
        this._privacyDots.update(dots);
        if (this._right.child !== right)
            this._swap(this._right, right);
        // Hidden when empty: then nothing on the right is measured (see `_fit`).
        this._right.visible = Boolean(right);
        this._tickSecond();
        // Paused: the bars rest, dimmed. Eased only to a change: each refresh ran two 200 ms eases to nothing.
        // A paused timer's glyph, time or ring, the same.
        for (const [actor, on] of [[this._bars, playing], [this._timerIcon, pomodoro?.running], [this._timerTime, pomodoro?.running],
            [this._ring, pomodoro?.running], [this._secondRing, pomodoro?.running]]) {
            const opacity = on ? 255 : PAUSED_OPACITY;
            if (!restsAt(actor, 'opacity', opacity))
                actor.ease({opacity, duration: 200});
        }
        this._syncBars();

        if (timerActive) {
            const color = Theme.semantic(timerColor(pomodoro.phase));
            this._ring.color = this._secondRing.color = color;
            // Restyled only when the phase changes.
            const style = `color: rgb(${color.map(c => Math.round(c * 255)).join(', ')});`;
            if (this._timerIcon.style !== style)
                this._timerIcon.style = style;
            this._refreshRing();
        } else {
            this._cancel('ring');
        }
        if (hasTrack)
            (primary === 'music' ? this._art : this._secondArt).setPath(nowPlaying.art_path);

        if (recording) {
            this._crossfade(this._elapsed);
            this._tickRecording();
        } else {
            this._cancel('recording');
            this._crossfade(this._clock);
        }

        this._fit();
        if (this.preferredWidth !== widthBefore)
            this.emit('width-changed');
    }

    /** Puts `sign` in `side`, fading in once on screen: one sign giving way to another reads as a change. */
    _swap(side, sign) {
        side.child = sign;
        if (!sign || !this.mapped || !St.Settings.get().enable_animations)
            return;
        // To full: a paused song's bars or timer's time are dimmed after (see `_refresh`).
        sign.remove_transition('opacity');
        sign.opacity = 0;
        sign.ease({opacity: 255, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    /** Fades `actor` in and the other centre actors out. */
    _crossfade(actor) {
        for (const other of [this._clock, this._elapsed]) {
            if (other === actor) {
                if (!other.visible) {
                    other.opacity = 0;
                    other.show();
                }
                if (!restsAt(other, 'opacity', 255))
                    other.ease({opacity: 255, duration: 200});
            } else if (other.visible) {
                other.ease({opacity: 0, duration: 150, onComplete: () => other.hide()});
            }
        }
    }

    /** The timer's time left on the right, each second while on screen. */
    _tickSecond() {
        const time = this._timerTime;
        // Set off screen too, so its width can be measured; it ticks only on screen.
        if (this._right.child !== time) {
            this._cancel('second');
            return;
        }
        const {pomodoro} = this._daemon.state;
        if (!pomodoro || pomodoro.phase === 'idle')
            return;
        const length = time.text.length;
        const remaining = pomodoro.running ? Math.max(0, pomodoro.ends_at_ms - Format.nowMs()) : pomodoro.remaining_ms;
        const [r, g, b] = Theme.semantic(timerColor(pomodoro.phase));
        time.text = Format.duration(remaining);
        // Restyled only when the phase changes, not each second.
        const style = `color: rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)});`;
        if (time.style !== style)
            time.style = style;
        const next = pomodoro.running ? remaining % 1000 || 1000 : 0;
        // Shorter (10:00 to 9:59): the sides are measured again, or the time would be cut.
        if (time.text.length !== length && this.mapped)
            this._refit();
        if (next && this.mapped)
            this._later('second', next + 10, () => this._tickSecond());
        else
            this._cancel('second');
    }

    /** The timer ring's progress, redrawn every few seconds while it shows. */
    _refreshRing() {
        const {pomodoro} = this._daemon.state;
        // Only while one shows: on the left (beside the privacy dots), or the timer second, on the right.
        const ring = this._lead.child === this._ring ? this._ring : this._right.child === this._secondRing ? this._secondRing : null;
        if (!pomodoro || pomodoro.phase === 'idle' || !this.mapped || !ring) {
            this._cancel('ring');
            return;
        }
        const remaining = pomodoro.running
            ? Math.max(0, pomodoro.ends_at_ms - Format.nowMs())
            : pomodoro.remaining_ms;
        ring.progress = 1 - remaining / pomodoro.duration_ms;
        if (pomodoro.running)
            this._later('ring', RING_REFRESH_S * 1000, () => this._refreshRing());
    }

    /** Bars dance only when on screen, the user is here and the song plays. */
    _syncBars() {
        const playing = this.mapped && !this._idle && Playback.isPlaying(this._daemon.state.nowPlaying);
        this._bars.playing = playing;
    }

    /** Shows how long the screen has been recording, once a second while on screen. */
    _tickRecording() {
        if (!this._privacy.recording || !this.mapped) {
            this._cancel('recording');
            return;
        }
        const elapsedMs = (GLib.get_monotonic_time() - this._privacy.recordingSince) / 1000;
        const length = this._elapsed.text.length;
        this._elapsed.text = Format.duration(elapsedMs);
        // Longer (9:59 to 10:00): the centre is measured again.
        if (this._elapsed.text.length !== length)
            this._refit();
        this._later('recording', 1000 - (elapsedMs % 1000) + 10, () => this._tickRecording());
    }

    /** Sets the clock's text; `watchClock` calls it again as the minute changes. */
    _tickClock() {
        const length = this._clock.text.length;
        this._clock.text = Format.clockTime();
        // Longer or shorter (12:59 to 1:00): the centre is measured again; not while being built.
        if (this._clock.text.length !== length && this._contentWidth)
            this._refit();
    }

    /** Runs `callback` once after `ms`, replacing any timeout of the same name. */
    _later(name, ms, callback) {
        this._cancel(name);
        this._timeouts[name] = GLib.timeout_add(GLib.PRIORITY_DEFAULT, Math.max(0, Math.round(ms)), () => {
            delete this._timeouts[name];
            callback();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Drops the timeout of that name, if any. */
    _cancel(name) {
        if (this._timeouts[name]) {
            GLib.source_remove(this._timeouts[name]);
            delete this._timeouts[name];
        }
    }

    /** The assistant's shape and colours, from Settings (see bot.js). */
    _botLook() {
        return {shape: this._settings.get_string('bot-shape'),
            palette: paletteFor(this._settings.get_string('bot-color'), this._settings.get_string('bot-glow'))};
    }

    /** Stops timers and signals, and destroys the signs not in a slot right now. */
    _onDestroy() {
        this._stopClock();
        for (const name of Object.keys(this._timeouts))
            this._cancel(name);
        this._daemon.disconnect(this._daemonChanged);
        this._settings.disconnect(this._settingsChanged);
        this._settings.disconnect(this._pagesChanged);
        for (const id of this._botLookChanged)
            this._settings.disconnect(id);
        this._privacy.disconnect(this._privacyChanged);
        this._call.disconnect(this._callChanged);
        // Slots may hold actors that are not currently children.
        for (const actor of [this._timerIcon, this._ring, this._art, this._dot, this._recordingDot, this._bars, this._phone, this._micOff, this._assistant, this._serviceDown,
            this._timerTime, this._secondRing, this._secondArt, this._secondPhone]) {
            if (!actor.get_parent())
                actor.destroy();
        }
    }
});
