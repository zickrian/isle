// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The resting island: the clock between live activities (recording, call, music or timer on the left, privacy
// dots far right), a moon before it in Do Not Disturb. A second activity takes the right side.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {paletteFor} from './bot.js';
import {BotIcon} from './botIcon.js';
import {iconSize, onUiScale, px, stageScale, textScale, uiScale} from './compat.js';
import * as Format from './format.js';
import * as Palette from './palette.js';
import * as Playback from './playback.js';
import {watchClock} from './wallClock.js';
import {Art, Bars, PrivacyDots, RecordingDot, Ring, icon, restsAt} from './widgets.js';

/** The assistant at work, in the right slot. */
const ASSISTANT_SIZE = 18;

/** Sizes hanging below the top bar, and inside it with smaller text, in CSS pixels. */
const SIZES = {
    hanging: {clock: 164, activities: 256, art: 24, artRadius: 6, ring: 20, bars: 16, moon: 14, call: 15},
    inBar: {clock: 144, activities: 232, art: 22, artRadius: 6, ring: 18, bars: 14, moon: 13, call: 14},
};
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

        this._left = new St.Bin({style_class: 'isle-compact-slot', x_expand: false, y_align: Clutter.ActorAlign.CENTER});
        this._ring = new Ring({size: 20, lineWidth: 3});
        this._art = new Art({size: 24, radius: 6});
        this._dot = new St.Widget({style_class: 'isle-unseen-dot', y_align: Clutter.ActorAlign.CENTER});
        this._recordingDot = new RecordingDot();
        // A call: a green phone, and on the right a red microphone while it is muted.
        this._phone = new St.Icon({gicon: icon('isle-phone-symbolic'), icon_size: iconSize(15), style_class: 'isle-call-icon', y_align: Clutter.ActorAlign.CENTER});
        this._micOff = new St.Icon({gicon: icon('isle-mic-off-symbolic'), icon_size: iconSize(15), style_class: 'isle-call-muted', y_align: Clutter.ActorAlign.CENTER});
        // isled is not running: what needs it cannot work (see the controller's service watch).
        this._serviceDown = new St.Icon({gicon: icon('dialog-warning-symbolic'), icon_size: iconSize(15), style_class: 'isle-compact-warning', y_align: Clutter.ActorAlign.CENTER});
        // The assistant at work with the island closed: still, but for a blink and a glance every few seconds.
        this._assistant = new BotIcon(ASSISTANT_SIZE, this._botLook());
        this._assistant.y_align = Clutter.ActorAlign.CENTER;
        this._botLookChanged = ['bot-shape', 'bot-color', 'bot-glow'].map(key =>
            settings.connect(`changed::${key}`, () => (this._assistant.look = this._botLook())));

        const center = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true});
        const times = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._clock = new St.Label({style_class: 'isle-compact-clock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        // How long the screen has been recording, in place of the clock.
        this._elapsed = new St.Label({style_class: 'isle-compact-clock', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false});
        // How long the call has lasted, in green.
        this._callTime = new St.Label({style_class: 'isle-compact-clock isle-compact-call-time', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, visible: false});
        times.add_child(this._clock);
        times.add_child(this._elapsed);
        times.add_child(this._callTime);
        // Do Not Disturb: a moon before the time (or what takes its place), as iOS shows a Focus, whatever the sides hold.
        this._moon = new St.Icon({gicon: icon('isle-moon'), icon_size: iconSize(14), style_class: 'isle-dnd-moon', y_align: Clutter.ActorAlign.CENTER, visible: false});
        const centerRow = new St.BoxLayout({style_class: 'isle-compact-clock-box', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        centerRow.add_child(this._moon);
        centerRow.add_child(times);
        center.add_child(centerRow);

        this._right = new St.Bin({style_class: 'isle-compact-slot', x_expand: false, y_align: Clutter.ActorAlign.CENTER});
        this._bars = new Bars({height: 16});
        // A second activity on the right, its time as large as the clock and level with it: the timer's
        // time left (beside the song's bars while one plays), or a call's phone and length.
        this._secondBars = new Bars({height: 16});
        this._secondTimer = this._secondPart(this._secondBars, 'isle-compact-second');
        this._secondPhone = new St.Icon({gicon: icon('isle-phone-symbolic'), icon_size: iconSize(15), y_align: Clutter.ActorAlign.CENTER});
        this._secondCall = this._secondPart(this._secondPhone, 'isle-compact-second isle-compact-second-call');
        /** How much wider the right side is than a slot, while it holds a second time (balanced on the left). */
        this._secondExtra = 0;

        this._privacyDots = new PrivacyDots();
        // Each side's sign keeps to its edge, so all sit as far in from the island's ends. The slots are
        // told not to expand, or their children's x_expand (which the alignment needs) would widen them.
        const align = (actors, x_align) => actors.forEach(actor => actor.set({x_align, x_expand: true}));
        align([this._ring, this._art, this._dot, this._recordingDot, this._phone], Clutter.ActorAlign.START);
        align([this._bars, this._micOff, this._serviceDown, this._assistant, this._secondTimer, this._secondCall], Clutter.ActorAlign.END);

        // As wide as the privacy dots at the far right, so the clock stays centred.
        this._privacyBalance = new St.Widget({visible: false});
        row.add_child(this._privacyBalance);
        row.add_child(this._left);
        // As much wider than a slot as the second activity on the right, so the clock stays centred.
        this._secondBalance = new St.Widget({visible: false});
        row.add_child(this._secondBalance);
        row.add_child(center);
        row.add_child(this._right);
        row.add_child(this._privacyDots);

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
            this._tickCall();
            this._tickRecording();
            this._refreshRing();
            this._tickSecond();
            // Measure what could not be off screen: the privacy dots' balance, a second time's width.
            const second = this._right.child === this._secondTimer || this._right.child === this._secondCall;
            if (this.mapped && ((this._privacyBalance.visible && !this._privacyBalance.width) || second))
                this._refresh();
        });
        this._tickClock();
        this._stopClock = watchClock(() => this._tickClock());
        this._refresh();
        // Another scale: the sides and icons are resized and measured again.
        onUiScale(this, () => {
            this._syncSizes();
            this._refresh();
        }, {now: false});
        this.connect('destroy', () => this._onDestroy());
    }

    /** The width the island should have to fit what is shown. */
    get preferredWidth() {
        const size = SIZES[this._inBar ? 'inBar' : 'hanging'];
        const fontScale = this._inBar ? textScale() : 1.0;
        const privacy = this._privacyWidth();
        // With nothing beside the clock, the island widens for the moon; beside an activity there is room.
        const moon = this._moon.visible ? (size.moon + MOON_GAP) * fontScale : 0;
        const base = this._left.child || this._right.child ? size.activities : size.clock;
        return px(Math.round(base * fontScale + moon)) + privacy + 2 * this._secondExtra;
    }

    /** A sign with a time label beside it, for the right side's second activity. */
    _secondPart(sign, styleClass) {
        const box = new St.BoxLayout({style_class: styleClass, y_align: Clutter.ActorAlign.CENTER});
        box.add_child(sign);
        box._time = new St.Label({style_class: 'isle-compact-second-time', y_align: Clutter.ActorAlign.CENTER});
        box.add_child(box._time);
        return box;
    }

    /** Room for the privacy dots and their balance on the other side (none inside a slot). */
    _privacyWidth() {
        // Off the stage (as when Isle starts mid-call) nothing can be measured yet.
        if (!this._privacyDots.visible || this._privacyDots.get_parent() !== this._row || !this.get_stage())
            return 0;
        const [, dots] = this._privacyDots.get_preferred_width(-1);
        const spacing = this._row.get_theme_node().get_length('spacing');
        return 2 * Math.ceil(dots + spacing);
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

    /** Sizes widgets according to whether the island is in the top bar and the current scale. */
    _syncSizes() {
        const size = SIZES[this._inBar ? 'inBar' : 'hanging'];
        this._art.resize(size.art, size.artRadius);
        this._ring.resize(size.ring);
        this._bars.maxHeight = this._secondBars.maxHeight = size.bars;
        this._moon.icon_size = iconSize(size.moon);
        this._phone.icon_size = this._micOff.icon_size = this._secondPhone.icon_size = iconSize(size.call);
        this._serviceDown.icon_size = iconSize(size.call);
    }

    /** Fits the view inside the top bar, like a notch, or below it. */
    set inBar(inBar) {
        if (inBar === this._inBar)
            return;
        this._inBar = inBar;
        this._syncSizes();
        if (inBar)
            this.add_style_class_name('isle-compact-in-bar');
        else
            this.remove_style_class_name('isle-compact-in-bar');
        this._refresh();
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

        // The first activity that applies keeps the island: recording, a call, the music, the timer. The
        // next takes the right side.
        const activities = [recording && 'recording', onCall && 'call', hasTrack && 'music', timerActive && 'timer']
            .filter(Boolean);
        const [primary, second] = activities;
        // Left: the activity's sign, else the unread dot. Both slots keep their width when empty, so the centre
        // stays centred.
        let left = {recording: this._recordingDot, call: this._phone, music: this._art, timer: this._ring}[primary] ?? null;
        if (!left && this._unseen)
            left = this._dot;
        if (this._left.child !== left)
            this._left.child = left;
        let right = primary === 'music' ? this._bars : null;
        if (second)
            right = {music: this._bars, timer: this._secondTimer, call: this._secondCall}[second];
        if (onCall && this._call.muted)
            right = this._micOff;
        if (this._assistantBusy)
            right = this._assistant;
        this._assistant.alive = right === this._assistant;
        if (this._isServiceDown)
            right = this._serviceDown;
        // On a call the green phone already says the microphone is on, unless another app records too.
        const privacy = this._showingPrivacy() ? this._privacy : {};
        const microphone = privacy.microphone && (!onCall || this._call.othersRecording);
        const dots = {camera: privacy.camera, microphone, screenShare: privacy.screenShare};
        this._privacyDots.update(dots);
        // Beside an activity, up to two dots take the empty right slot, so the island grows no wider.
        const shown = Object.values(dots).filter(Boolean).length;
        const inSlot = shown > 0 && shown <= 2 && Boolean(left) && !right;
        if (inSlot) {
            right = this._privacyDots;
            if (this._privacyDots.get_parent() === this._row)
                this._row.remove_child(this._privacyDots);
        }
        if (this._right.child !== right)
            this._right.child = right;
        // The song's bars beside the timer's time, while the song is the first activity; set before
        // the right side is measured.
        this._secondBars.visible = primary === 'music' && second === 'timer';
        this._tickSecond();
        this._balanceSecond(right);
        if (!inSlot && !this._privacyDots.get_parent())
            this._row.add_child(this._privacyDots);
        if (inSlot)
            this._privacyDots.add_style_class_name('isle-privacy-dots-in-slot');
        else
            this._privacyDots.remove_style_class_name('isle-privacy-dots-in-slot');
        // Paused: the bars rest, dimmed. Eased only to a change: each refresh ran two 200 ms eases to nothing.
        for (const bars of [this._bars, this._secondBars]) {
            const opacity = playing ? 255 : PAUSED_OPACITY;
            if (!restsAt(bars, 'opacity', opacity))
                bars.ease({opacity, duration: 200});
        }
        this._syncBars();
        const outside = this._privacyDots.visible && !inSlot;
        this._privacyBalance.visible = outside;
        // Measured only when shown: hidden, it may not be on the stage yet.
        this._privacyBalance.width = outside && this.get_stage() ? this._privacyDots.get_preferred_width(-1)[1] : 0;

        if (timerActive) {
            this._ring.color = timerColor(pomodoro.phase);
            this._refreshRing();
        } else {
            this._cancel('ring');
        }
        if (hasTrack)
            this._art.setPath(nowPlaying.art_path);

        if (recording) {
            this._crossfade(this._elapsed);
            this._tickRecording();
        } else {
            this._cancel('recording');
            this._crossfade(onCall ? this._callTime : this._clock);
        }
        this._tickCall();

        if (this.preferredWidth !== widthBefore)
            this.emit('width-changed');
    }

    /** Fades `actor` in and the other centre actors out. */
    _crossfade(actor) {
        for (const other of [this._clock, this._elapsed, this._callTime]) {
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

    /** Widens the right slot to the second time it holds, and the left side by as much. */
    _balanceSecond(right) {
        const time = right === this._secondTimer || right === this._secondCall;
        // Measured only on the stage; off it, the next refresh there does it.
        const width = time && this.get_stage() ? Math.ceil(right.get_preferred_width(-1)[1]) : 0;
        const slot = px(SIZES[this._inBar ? 'inBar' : 'hanging'].art);
        const spacing = width ? this._row.get_theme_node().get_length('spacing') : 0;
        this._secondExtra = width ? Math.max(0, width - slot) : 0;
        // CSS, which St scales: measured in stage pixels, it is set in CSS ones.
        this._right.style = width ? `width: ${width / stageScale()}px;` : null;
        this._secondBalance.visible = this._secondExtra > spacing;
        this._secondBalance.width = Math.max(0, this._secondExtra - spacing);
    }

    /** The second activity's time, each second while on screen. */
    _tickSecond() {
        const part = this._right.child;
        // Set off screen too, so its width can be measured; it ticks only on screen.
        if (part !== this._secondTimer && part !== this._secondCall) {
            this._cancel('second');
            return;
        }
        let next;
        const length = part._time.text.length;
        if (part === this._secondTimer) {
            const {pomodoro} = this._daemon.state;
            if (!pomodoro || pomodoro.phase === 'idle')
                return;
            const remaining = pomodoro.running ? Math.max(0, pomodoro.ends_at_ms - Format.nowMs()) : pomodoro.remaining_ms;
            const [r, g, b] = timerColor(pomodoro.phase);
            part._time.text = Format.duration(remaining);
            // Restyled only when the phase changes, not each second.
            const style = `color: rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)});`;
            if (part._time.style !== style)
                part._time.style = style;
            next = pomodoro.running ? remaining % 1000 || 1000 : 0;
        } else {
            const elapsedMs = (GLib.get_monotonic_time() - this._call.since) / 1000;
            part._time.text = Format.duration(elapsedMs);
            next = 1000 - (elapsedMs % 1000);
        }
        // Longer or shorter (59:59 to 1:00:00): the side is measured again, or the time would be cut.
        if (part._time.text.length !== length && this.mapped) {
            const widthBefore = this.preferredWidth;
            this._balanceSecond(part);
            if (this.preferredWidth !== widthBefore)
                this.emit('width-changed');
        }
        if (next && this.mapped)
            this._later('second', next + 10, () => this._tickSecond());
        else
            this._cancel('second');
    }

    /** The timer ring's progress, redrawn every few seconds while it shows. */
    _refreshRing() {
        const {pomodoro} = this._daemon.state;
        // Only while it shows: the timer may be on the right instead.
        if (!pomodoro || pomodoro.phase === 'idle' || !this.mapped || this._left.child !== this._ring) {
            this._cancel('ring');
            return;
        }
        const remaining = pomodoro.running
            ? Math.max(0, pomodoro.ends_at_ms - Format.nowMs())
            : pomodoro.remaining_ms;
        this._ring.progress = 1 - remaining / pomodoro.duration_ms;
        if (pomodoro.running)
            this._later('ring', RING_REFRESH_S * 1000, () => this._refreshRing());
    }

    /** Bars dance only when on screen, the user is here and the song plays. */
    _syncBars() {
        const playing = this.mapped && !this._idle && Playback.isPlaying(this._daemon.state.nowPlaying);
        this._bars.playing = playing;
        this._secondBars.playing = playing && this._secondBars.visible && this._right.child === this._secondTimer;
    }

    /** Shows how long the screen has been recording, once a second while on screen. */
    _tickRecording() {
        if (!this._privacy.recording || !this.mapped) {
            this._cancel('recording');
            return;
        }
        const elapsedMs = (GLib.get_monotonic_time() - this._privacy.recordingSince) / 1000;
        this._elapsed.text = Format.duration(elapsedMs);
        this._later('recording', 1000 - (elapsedMs % 1000) + 10, () => this._tickRecording());
    }

    /** Shows how long the call has lasted, once a second while on screen. */
    _tickCall() {
        if (!this._call.active || !this.mapped) {
            this._cancel('call');
            return;
        }
        const elapsedMs = (GLib.get_monotonic_time() - this._call.since) / 1000;
        this._callTime.text = Format.duration(elapsedMs);
        this._later('call', 1000 - (elapsedMs % 1000) + 10, () => this._tickCall());
    }

    /** Sets the clock's text; `watchClock` calls it again as the minute changes. */
    _tickClock() {
        this._clock.text = Format.clockTime();
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
        for (const actor of [this._ring, this._art, this._dot, this._recordingDot, this._bars, this._phone, this._micOff, this._assistant, this._serviceDown,
            this._secondTimer, this._secondCall]) {
            if (!actor.get_parent())
                actor.destroy();
        }
    }
});
