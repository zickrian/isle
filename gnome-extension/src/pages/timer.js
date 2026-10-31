// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The Pomodoro timer, the Timer page. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from '../compact.js';
import {VERTICAL, onUiScale} from '../compat.js';
import * as Format from '../format.js';
import {typedMinutes} from '../timerRules.js';
import {Ring, icon, iconButton, label, setEnabled} from '../widgets.js';
import {Page} from './page.js';

/** The phase's name inside the ring, under the time. */
const PHASES = {
    idle: 'Focus',
    focus: 'Focus',
    short_break: 'Break',
    long_break: 'Long break',
};
const RING_SIZE = 104;
/** Reset and Start, at the right, in a slot as wide as both with "Resume" (CSS px): Reset appearing moves nothing;
 * the steppers sit midway between the ring and Start as it is before a session (`_centreSteppers`). */
const CONTROLS_WIDTH = 160;
/** Shown until isled reports the timer: a fresh 25-minute focus session. */
const DEFAULT_STATE = {phase: 'idle', running: false, remaining_ms: 25 * 60000, duration_ms: 25 * 60000, today_sessions: 0};
/** The lengths the steppers keep to, in minutes (as Settings). */
const STEPPERS = [
    {key: 'focus_minutes', label: 'Work', min: 1, max: 180},
    {key: 'short_break_minutes', label: 'Break', min: 1, max: 60},
];
/** ClutterText's room either side of an editable line (its TEXT_PADDING), in device pixels. */
const CARET_ROOM = 2;

// The Timer page: a ring with the time left, the lengths of work and break as steppers, and Start.
export const TimerPage = GObject.registerClass(
class TimerPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-timer',
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        this.name = 'focus';

        // A ring that fills clockwise as the phase runs; the time and the phase inside.
        const inside = new St.BoxLayout({...VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        this._time = label('25:00', 'isle-timer-time', {x_align: Clutter.ActorAlign.CENTER});
        this._phase = label('Focus', 'isle-timer-phase', {x_align: Clutter.ActorAlign.CENTER});
        inside.add_child(this._time);
        inside.add_child(this._phase);
        this._ring = new Ring({size: RING_SIZE, lineWidth: 5, trackOpacity: 0.14, child: inside});
        this._ring.y_align = Clutter.ActorAlign.CENTER;
        this.add_child(this._ring);
        this.add_child(new St.Widget({x_expand: true}));

        const steppers = new St.BoxLayout({...VERTICAL, style_class: 'isle-steppers', y_align: Clutter.ActorAlign.CENTER});
        this._values = new Map();
        // The fields and − / + buttons, locked while a session is under way (see `_syncLock`), and their pills.
        this._lockable = [];
        this._stepperRows = [];
        this._locked = false;
        for (const stepper of STEPPERS)
            steppers.add_child(this._buildStepper(stepper));
        this.add_child(steppers);
        this._steppers = steppers;
        this.add_child(new St.Widget({x_expand: true}));

        // Reset only once started; then Start, Pause or Resume.
        const controls = new St.BoxLayout({style_class: 'isle-timer-controls', x_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._reset = iconButton('isle-reset', 'isle-button-round',
            () => daemon.call('pomodoro', 'Stop'), {size: 14, accessibleName: 'Reset the timer'});
        this._reset.y_align = Clutter.ActorAlign.CENTER;
        controls.add_child(this._reset);
        const pill = new St.BoxLayout({style_class: 'isle-start-pill-box'});
        this._playIcon = new St.Icon({gicon: icon('isle-play-symbolic'), icon_size: 13, y_align: Clutter.ActorAlign.CENTER});
        this._playLabel = label('Start', 'isle-start-pill-label');
        pill.add_child(this._playIcon);
        pill.add_child(this._playLabel);
        this._play = new St.Button({style_class: 'isle-start-pill', child: pill, can_focus: true, accessible_name: 'Start or pause'});
        this._play.connect('clicked', () => this._toggle());
        controls.add_child(this._play);
        const slot = new St.Widget({layout_manager: new Clutter.BinLayout()});
        onUiScale(slot, scale => {
            slot.width = CONTROLS_WIDTH * scale;
            if (this.mapped)
                this._centreSteppers();
        });
        slot.add_child(controls);
        this.add_child(slot);
        this._slot = slot;

        this.watch(['pomodoro'], () => this._update());
        this.watch(['pomodoroConfig'], () => this._syncSteppers());
        this._update();
        this._syncSteppers();
    }

    /** "Work  25  −  +": a length to type, and buttons a minute down or up. */
    _buildStepper({key, label: name, min, max}) {
        const row = new St.BoxLayout({style_class: 'isle-stepper'});
        this._stepperRows.push(row);
        row.add_child(label(name, 'isle-stepper-name'));
        // The number is a field: click it, type a length, Enter or a click away keeps it. The
        // buttons still step a minute, which stays quicker for a small change.
        const value = new St.Entry({
            style_class: 'isle-stepper-value isle-stepper-entry',
            text: '',
            can_focus: true,
            y_align: Clutter.ActorAlign.CENTER,
            accessible_name: `Set ${name.toLowerCase()} minutes`,
        });
        this._values.set(key, value);
        const text = value.clutter_text;
        text.x_align = Clutter.ActorAlign.END;
        // Editable only while typed in: drawn editable with no input method on it, the caret ClutterText
        // places for one logs Clutter criticals. Shifted as editable lays it out (CARET_ROOM in from the end).
        const setEditable = editable => {
            text.editable = editable;
            text.translation_x = editable ? 0 : CARET_ROOM / text.get_resource_scale() - 2 * CARET_ROOM;
            // Its width changes with it (the room), which ClutterText leaves to the next layout.
            text.queue_relayout();
        };
        setEditable(false);
        text.connect('resource-scale-changed', () => setEditable(text.editable));
        // A click on it, beside the digits too, takes the keyboard (see the controller's `_onFieldPress`).
        // All of it, so typing replaces it: after the click, which puts the cursor where it lands.
        text.connect('key-focus-in', () => {
            setEditable(!this._locked);
            this.later('select-length', 0, () => {
                if (text.has_key_focus())
                    text.set_selection(0, -1);
            });
        });
        text.connect('activate', () => {
            this._saveValue(key, value, min, max);
            this._giveKeyboardBack();
        });
        // Clicking elsewhere keeps the typed length, as renaming a reminder does.
        text.connect('key-focus-out', () => {
            this._saveValue(key, value, min, max);
            setEditable(false);
        });
        text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._cancelValue(key, value);
            this._giveKeyboardBack();
            return Clutter.EVENT_STOP;
        });
        // Digits only, at most those of the largest length (three): letters never reach isled.
        text.connect('text-changed', () => {
            if (!text.has_key_focus())
                return;
            const digits = text.text.replace(/\D/g, '').slice(0, 3);
            if (digits !== text.text) {
                text.set_text(digits);
                text.set_cursor_position(-1);
            }
        });
        row.add_child(value);
        this._lockable.push(value);
        for (const [glyph, step, accessibleName] of [['isle-minus-symbolic', -1, `Shorter ${name.toLowerCase()}`],
            ['isle-plus-symbolic', 1, `Longer ${name.toLowerCase()}`]]) {
            const button = iconButton(glyph, 'isle-button-flat isle-stepper-button',
                () => this._step(key, step, min, max), {size: 12, accessibleName});
            row.add_child(button);
            this._lockable.push(button);
        }
        return row;
    }

    /** One stepper click, kept within `min`..`max` minutes. */
    _step(key, step, min, max) {
        if (this._locked)
            return;
        // From what was last asked for: clicks faster than isled answers each count.
        const config = this._asked ?? this.daemon.state.pomodoroConfig;
        if (!config)
            return;
        const minutes = Math.min(max, Math.max(min, (config[key] ?? min) + step));
        this._setMinutes(key, minutes);
    }

    /** Keeps a typed length, within the stepper's limits. */
    _saveValue(key, value, min, max) {
        const minutes = this._locked ? null : typedMinutes(value.text, min, max);
        if (minutes === null) {
            this._showValue(key, value);
            return;
        }
        this._setMinutes(key, minutes);
    }

    /** Puts back the length isled has on Esc. */
    _cancelValue(key, value) {
        this._showValue(key, value);
    }

    /** A length from this page, as isled will hold it; the field shows it at once. */
    _setMinutes(key, minutes) {
        const config = this._asked ?? this.daemon.state.pomodoroConfig;
        if (!config)
            return;
        this._values.get(key).text = String(minutes);
        if (minutes === config[key])
            return;
        this._asked = {...config, [key]: minutes};
        this.daemon.call('pomodoro', 'SetConfig', JSON.stringify(this._asked));
    }

    /** The length isled holds, or the clicks it hasn't answered yet. */
    _showValue(key, value) {
        const shown = this._asked ?? this.daemon.state.pomodoroConfig;
        value.text = shown?.[key] !== undefined ? String(shown[key]) : '–';
    }

    /** Ends typing: the keyboard goes back to the island, or to the page's next field. */
    _giveKeyboardBack() {
        global.stage.set_key_focus(null);
        this.emit('request-keyboard', false);
    }

    /** Ends any typing with isled's length back in the field. */
    _cancelTyping() {
        for (const {key} of STEPPERS) {
            const value = this._values.get(key);
            if (!value.clutter_text.has_key_focus())
                continue;
            this._showValue(key, value);
            this._giveKeyboardBack();
        }
    }

    /** From Start until Reset the lengths hold still and take no clicks, keys or focus: each length reads on in grey
     * (`.isle-stepper-locked`, not faded), its − / + dimmed. Only on a change: this runs every tick. */
    _syncLock(locked) {
        if (locked === this._locked)
            return;
        this._locked = locked;
        if (locked)
            this._cancelTyping();
        for (const row of this._stepperRows) {
            if (locked)
                row.add_style_class_name('isle-stepper-locked');
            else
                row.remove_style_class_name('isle-stepper-locked');
        }
        for (const actor of this._lockable) {
            if (actor instanceof St.Entry) {
                // The field's text takes clicks of its own; it is editable only while typed in.
                actor.reactive = actor.can_focus = actor.clutter_text.reactive = !locked;
            } else {
                setEnabled(actor, !locked);
            }
        }
    }

    /** Steppers show isled's lengths, or the clicks it hasn't answered yet. */
    _syncSteppers() {
        const config = this.daemon.state.pomodoroConfig;
        // isled has caught up with the clicks (or another change came): its config holds again.
        if (this._asked && (!config || STEPPERS.every(({key}) => config[key] === this._asked[key])))
            this._asked = null;
        for (const {key} of STEPPERS) {
            const value = this._values.get(key);
            // Not while a length is being typed: its field is the user's until they leave it.
            if (value.clutter_text.has_key_focus())
                continue;
            this._showValue(key, value);
        }
    }

    /** Only once a session has started. */
    get relevant() {
        const state = this.daemon.state.pomodoro;
        return Boolean(state && state.phase !== 'idle');
    }

    /** Start, Pause or Resume. */
    _toggle() {
        // A length half typed is dropped, not started with.
        this._cancelTyping();
        const state = this.daemon.state.pomodoro;
        this.daemon.call('pomodoro', state?.running ? 'Pause' : 'Start');
    }

    /** Ring, time, phase and buttons from isled's timer state. */
    _update() {
        const state = this.daemon.state.pomodoro ?? DEFAULT_STATE;
        const idle = state.phase === 'idle';
        const remaining = this._remaining(state);

        this._ring.color = timerColor(state.phase);
        this._ring.progress = idle ? 0 : 1 - remaining / state.duration_ms;
        this._time.text = Format.duration(remaining);
        this._phase.text = PHASES[state.phase] ?? 'Focus';
        this._playIcon.gicon = icon(state.running ? 'isle-pause-symbolic' : 'isle-play-symbolic');
        this._playLabel.text = state.running ? 'Pause' : idle ? 'Start' : 'Resume';
        this._reset.visible = !idle;
        this._syncLock(!idle);
        this._scheduleTick(state);
    }

    /** In ms; counted locally from `ends_at_ms` while running. */
    _remaining(state) {
        return state.running ? Math.max(0, state.ends_at_ms - Format.nowMs()) : state.remaining_ms;
    }

    /** Re-renders just after the displayed second changes. */
    _scheduleTick(state) {
        if (!this.active || !state.running)
            return;
        const remaining = this._remaining(state);
        // At zero, isled's PhaseFinished brings the next state.
        if (remaining <= 0)
            return;
        this.later('tick', (remaining % 1000) + 15, () => this._update());
    }

    /** The time may be stale after a while off screen. */
    onActivate() {
        this._update();
        this._syncSteppers();
        this._centreSteppers();
    }

    /** Midway between the ring and Start, measured as "Start" whatever the button says now: the same shift
     * idle, running or paused, so nothing moves as Reset and Pause take the room on the right. */
    _centreSteppers() {
        const text = this._playLabel.clutter_text;
        const [, button] = this._play.get_preferred_width(-1);
        const [shown] = text.create_pango_layout(text.text).get_pixel_size();
        const [start] = text.create_pango_layout('Start').get_pixel_size();
        const shift = Math.round((this._slot.width - (button - shown + start)) / 2);
        if (this._steppers.translation_x !== shift)
            this._steppers.translation_x = shift;
    }

    /** Forgets unanswered clicks, and settles a length still being typed. */
    onDeactivate() {
        let saved = false;
        for (const {key, min, max} of STEPPERS) {
            const value = this._values.get(key);
            if (!value.clutter_text.has_key_focus())
                continue;
            this._saveValue(key, value, min, max);
            this._giveKeyboardBack();
            saved = true;
        }
        // A click isled refused, or a change from Settings meanwhile: what it holds shows next time.
        // A length just typed stays shown until isled answers it.
        if (!saved)
            this._asked = null;
        this._syncSteppers();
    }
});
