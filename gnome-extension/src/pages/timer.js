// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Focus timer (Pomodoro), the Focus page. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {timerColor} from '../compact.js';
import {VERTICAL, iconSize, onUiScale} from '../compat.js';
import * as Format from '../format.js';
import {Ring, icon, iconButton, label} from '../widgets.js';
import {Page} from './page.js';

/** The phase's name inside the ring, under the time. */
const PHASES = {
    idle: 'Focus',
    focus: 'Focus',
    short_break: 'Break',
    long_break: 'Long break',
};
const RING_SIZE = 104;
/** Reset and Start, at the right, in a slot as wide as both (CSS px): Reset appearing moves nothing. */
const CONTROLS_WIDTH = 152;
/** Shown until isled reports the timer: a fresh 25-minute focus session. */
const DEFAULT_STATE = {phase: 'idle', running: false, remaining_ms: 25 * 60000, duration_ms: 25 * 60000, today_sessions: 0};
/** The lengths the steppers keep to, in minutes (as Settings). */
const STEPPERS = [
    {key: 'focus_minutes', label: 'Work', min: 1, max: 180},
    {key: 'short_break_minutes', label: 'Break', min: 1, max: 60},
];

// The Focus page: a ring with the time left, the lengths of work and break as steppers, and Start.
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
        for (const stepper of STEPPERS)
            steppers.add_child(this._buildStepper(stepper));
        this.add_child(steppers);
        this.add_child(new St.Widget({x_expand: true}));

        // Reset only once started; then Start, Pause or Resume.
        const controls = new St.BoxLayout({style_class: 'isle-timer-controls', x_expand: true,
            x_align: Clutter.ActorAlign.END, y_align: Clutter.ActorAlign.CENTER});
        this._reset = iconButton('isle-reset', 'isle-button-round',
            () => daemon.call('pomodoro', 'Stop'), {size: 14, accessibleName: 'Reset the timer'});
        this._reset.y_align = Clutter.ActorAlign.CENTER;
        controls.add_child(this._reset);
        const pill = new St.BoxLayout({style_class: 'isle-start-pill-box'});
        this._playIcon = new St.Icon({gicon: icon('isle-play-symbolic'), icon_size: iconSize(13), y_align: Clutter.ActorAlign.CENTER});
        this._playLabel = label('Start', 'isle-start-pill-label');
        pill.add_child(this._playIcon);
        pill.add_child(this._playLabel);
        this._play = new St.Button({style_class: 'isle-start-pill', child: pill, can_focus: true, accessible_name: 'Start or pause'});
        this._play.connect('clicked', () => this._toggle());
        controls.add_child(this._play);
        const slot = new St.Widget({layout_manager: new Clutter.BinLayout()});
        onUiScale(slot, scale => (slot.width = CONTROLS_WIDTH * scale));
        slot.add_child(controls);
        this.add_child(slot);

        this.watch(['pomodoro'], () => this._update());
        this.watch(['pomodoroConfig'], () => this._syncSteppers());
        this._update();
        this._syncSteppers();
    }

    /** "Work  25  −  +": a length, and buttons a minute down or up. */
    _buildStepper({key, label: name, min, max}) {
        const row = new St.BoxLayout({style_class: 'isle-stepper'});
        row.add_child(label(name, 'isle-stepper-name'));
        const value = label('', 'isle-stepper-value');
        this._values.set(key, value);
        row.add_child(value);
        for (const [glyph, step, accessibleName] of [['isle-minus-symbolic', -1, `Shorter ${name.toLowerCase()}`],
            ['isle-plus-symbolic', 1, `Longer ${name.toLowerCase()}`]]) {
            row.add_child(iconButton(glyph, 'isle-button-flat isle-stepper-button',
                () => this._step(key, step, min, max), {size: 12, accessibleName}));
        }
        return row;
    }

    /** One stepper click, kept within `min`..`max` minutes. */
    _step(key, step, min, max) {
        // From what was last asked for: clicks faster than isled answers each count.
        const config = this._asked ?? this.daemon.state.pomodoroConfig;
        if (!config)
            return;
        const minutes = Math.min(max, Math.max(min, (config[key] ?? min) + step));
        if (minutes === config[key])
            return;
        this._asked = {...config, [key]: minutes};
        // Shown at once; isled's answer brings the same.
        this._values.get(key).text = String(minutes);
        this.daemon.call('pomodoro', 'SetConfig', JSON.stringify(this._asked));
    }

    /** Steppers show isled's lengths, or the clicks it hasn't answered yet. */
    _syncSteppers() {
        const config = this.daemon.state.pomodoroConfig;
        // isled has caught up with the clicks (or another change came): its config holds again.
        if (this._asked && (!config || STEPPERS.every(({key}) => config[key] === this._asked[key])))
            this._asked = null;
        const shown = this._asked ?? config;
        for (const {key} of STEPPERS)
            this._values.get(key).text = shown?.[key] !== undefined ? String(shown[key]) : '–';
    }

    /** Only once a session has started. */
    get relevant() {
        const state = this.daemon.state.pomodoro;
        return Boolean(state && state.phase !== 'idle');
    }

    /** Start, Pause or Resume. */
    _toggle() {
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
    }

    /** Forgets unanswered clicks. */
    onDeactivate() {
        // A click isled refused, or a change from Settings meanwhile: what it holds shows next time.
        this._asked = null;
        this._syncSteppers();
    }
});
