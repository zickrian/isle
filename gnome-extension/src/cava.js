// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Cava's bars at the bottom of the lyrics. Cava (https://github.com/karlstav/cava) listens to what the computer plays
// and prints how high each bar should be; Isle runs it only while the lyrics are on show, reads its lines and moves
// the bars. Nothing of cava is installed or changed: it must be there already.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {px} from './compat.js';
import {cavaColors, gradient} from './barColors.js';
import {buildConfig, parseFrame} from './cavaCore.js';

/** The shortest a bar gets, in CSS pixels, so that silence still shows a row of dots. */
const MIN_BAR = 3;

/** Whether cava is installed (in the PATH of the shell). */
export function cavaInstalled() {
    return GLib.find_program_in_path('cava') !== null;
}

/** Runs cava and tells each frame as heights 0..1. States: 'idle', 'starting', 'live' (frames are coming), 'failed'
 * (cava ran, but gave nothing: no sound server it could use) and 'missing' (not installed). */
class CavaSource {
    constructor(settings, {onFrame, onState}) {
        this._settings = settings;
        this._onFrame = onFrame;
        this._onState = onState;
        this.state = 'idle';
        this._process = null;
        this._cancellable = null;
        /** Counts the starts, so that what a stopped cava still says is let go. */
        this._run = 0;
    }

    _setState(state) {
        if (state === this.state)
            return;
        this.state = state;
        this._onState(state);
    }

    get running() {
        return this._process !== null;
    }

    /** Starts cava if it is not running. */
    start() {
        if (this._process)
            return;
        this._launch(0);
    }

    /** Stops it, and everything it was going to say. */
    stop() {
        this._run++;
        this._cancellable?.cancel();
        this._cancellable = null;
        const process = this._process;
        this._process = null;
        if (process) {
            try {
                process.force_exit();
            } catch (e) {
                // Gone already.
            }
        }
        this._setState('idle');
    }

    /** Stops and starts again, for a change of bars, smoothness or source. */
    restart() {
        if (!this._process)
            return;
        this.stop();
        this.start();
    }

    /** The sound servers to try, one after the other. */
    _methods() {
        const source = this._settings.get_string('cava-source');
        return source === 'auto' ? ['pipewire', 'pulse'] : [source];
    }

    _configPath() {
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'isle']);
        GLib.mkdir_with_parents(dir, 0o700);
        return GLib.build_filenamev([dir, 'cava.conf']);
    }

    /** Starts cava on the `attempt`th sound server. */
    _launch(attempt) {
        const program = GLib.find_program_in_path('cava');
        if (!program) {
            this._setState('missing');
            return;
        }
        const method = this._methods()[attempt];
        if (!method) {
            this._setState('failed');
            return;
        }
        const bars = this._settings.get_int('cava-bars');
        let process;
        try {
            const path = this._configPath();
            const config = buildConfig({bars, smoothness: this._settings.get_int('cava-smoothness'), source: method});
            Gio.File.new_for_path(path).replace_contents(new TextEncoder().encode(config), null, false,
                Gio.FileCreateFlags.PRIVATE, null);
            process = Gio.Subprocess.new([program, '-p', path],
                Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_SILENCE);
        } catch (e) {
            console.warn(`Isle: could not start cava: ${e.message}`);
            this._setState('failed');
            return;
        }
        this._process = process;
        this._cancellable = new Gio.Cancellable();
        const run = ++this._run;
        let gotFrame = false;
        this._setState('starting');

        const stream = new Gio.DataInputStream({base_stream: process.get_stdout_pipe(), close_base_stream: true});
        const read = () => {
            stream.read_line_async(GLib.PRIORITY_DEFAULT, this._cancellable, (_stream, result) => {
                let line;
                try {
                    [line] = stream.read_line_finish_utf8(result);
                } catch (e) {
                    // Stopped, or cava went.
                    return;
                }
                if (run !== this._run || line === null)
                    return;
                const frame = parseFrame(line, bars);
                if (frame) {
                    if (!gotFrame) {
                        gotFrame = true;
                        this._setState('live');
                    }
                    this._onFrame(frame);
                }
                read();
            });
        };
        read();

        // It ended by itself: with no frame ever, the next sound server; with some, it is over.
        process.wait_async(null, () => {
            if (run !== this._run)
                return;
            this._process = null;
            this._cancellable?.cancel();
            this._cancellable = null;
            if (!gotFrame && this._methods()[attempt + 1])
                this._launch(attempt + 1);
            else
                this._setState(gotFrame ? 'idle' : 'failed');
        });
    }
}

/** Bars across the open island, behind its pages: they follow cava while `active` and on screen, and `live` says that
 * they are moving. They rise from the bottom as far as Settings give, show through as faintly as Settings give, and can
 * be zoomed and moved about (Settings). They take the width of the area they are in, and `bleed` more below it. */
export const CavaBars = GObject.registerClass({
    Signals: {'live-changed': {}},
}, class CavaBars extends St.BoxLayout {
    _init(settings) {
        super._init({
            style_class: 'isle-cava',
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.FILL,
            y_align: Clutter.ActorAlign.FILL,
            clip_to_allocation: true,
            visible: false,
        });
        this._settings = settings;
        this._active = false;
        this._bars = [];
        this._wash = null;
        /** How far below the area they are in they reach, in stage pixels (the room under the island's pages). */
        this._bleed = 0;
        this._colors = cavaColors(null);
        this._live = false;
        /** How much of the bars shows, 0..1: the island's edge uncovering them (see `MediaPage.uncover`). */
        this._fade = 1;
        this._source = new CavaSource(settings, {
            onFrame: frame => this._move(frame),
            onState: state => this._onState(state),
        });
        // Zoomed about the bottom middle, so that it grows up and out from the island's floor.
        this.set_pivot_point(0.5, 1);
        this._build();
        this._applyOpacity();
        this._applyPlace();
        this._ids = [
            settings.connect('changed::cava-zoom', () => this._applyPlace()),
            settings.connect('changed::cava-offset-x', () => this._applyPlace()),
            settings.connect('changed::cava-offset-y', () => this._applyPlace()),
            settings.connect('changed::cava-enabled', () => this._sync()),
            settings.connect('changed::cava-height-pct', () => this._rest()),
            settings.connect('changed::cava-opacity', () => this._applyOpacity()),
            settings.connect('changed::cava-bars', () => {
                this._build();
                this._source.restart();
            }),
            settings.connect('changed::cava-smoothness', () => this._source.restart()),
            settings.connect('changed::cava-source', () => this._source.restart()),
        ];
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => {
            this._ids.forEach(id => settings.disconnect(id));
            this._source.stop();
        });
    }

    /** How far below its area it reaches, in stage pixels. */
    set bleed(bleed) {
        if (bleed === this._bleed)
            return;
        this._bleed = bleed;
        this.queue_relayout();
        this._applyPlace();
    }

    vfunc_allocate(box) {
        box.y2 += this._bleed;
        super.vfunc_allocate(box);
    }

    /** Whether it moves: set while the player or the lyrics are open in the island. */
    set active(active) {
        this._active = active;
        this._sync();
    }

    /** Whether the bars are following the music right now (cava is running and sending frames). */
    get live() {
        return this._live;
    }

    /** Colours the bars from the island's wash (RGB 0..1, or null for none), see `cavaColors`. */
    set wash(wash) {
        // The same cover gives the same colour (and the same array: `vividColorOfFile` remembers it).
        if (wash === this._wash)
            return;
        this._wash = wash;
        this._colors = cavaColors(wash);
        this._paint();
    }

    /** How much of them shows, 0..1, on top of Settings' own opacity. */
    set fade(fade) {
        if (fade === this._fade)
            return;
        this._fade = fade;
        this._applyOpacity();
    }

    /** Whether the bars are wanted at all: Settings turn them on and cava is there. */
    get wanted() {
        return this._settings.get_boolean('cava-enabled') && cavaInstalled();
    }

    _sync() {
        const on = this._active && this.wanted;
        this.visible = on;
        if (on && this.mapped)
            this._source.start();
        else
            this._source.stop();
    }

    _onState(state) {
        const live = state === 'live';
        if (live !== this._live) {
            this._live = live;
            if (!live)
                this._rest();
            this.emit('live-changed');
        }
    }

    /** Zoom and position (Settings): a scale about the bottom middle, and a shift right and up. */
    _applyPlace() {
        const zoom = this._settings.get_int('cava-zoom') / 100;
        this.scale_x = zoom;
        this.scale_y = zoom;
        this.translation_x = px(this._settings.get_int('cava-offset-x'));
        this.translation_y = -px(this._settings.get_int('cava-offset-y'));
    }

    _applyOpacity() {
        this.opacity = Math.round(255 * (this._settings.get_int('cava-opacity') / 100) * this._fade);
    }

    _build() {
        this._bars.forEach(bar => bar.destroy());
        const count = this._settings.get_int('cava-bars');
        this._bars = Array.from({length: count}, () => {
            const bar = new St.Widget({style_class: 'isle-cava-bar', x_expand: true, y_expand: true});
            // Full height, scaled from the bottom: a scale lays nothing out again.
            bar.set_pivot_point(0.5, 1);
            this.add_child(bar);
            return bar;
        });
        this._paint();
        this._rest();
    }

    /** Each bar its colour on the way from the first colour to the last. */
    _paint() {
        const colors = gradient(this._colors[0], this._colors[1], this._bars.length);
        this._bars.forEach((bar, i) => (bar.style = `background-color: ${colors[i]};`));
    }

    /** The highest a bar gets, as a share of the page's height (Settings). */
    _ceiling() {
        return this._settings.get_int('cava-height-pct') / 100;
    }

    /** The lowest, so that silence still shows a row of dots. */
    _minimum() {
        const height = this.get_height();
        return Math.min(this._ceiling(), height > 0 ? px(MIN_BAR) / height : 0.02);
    }

    /** All bars at their lowest. */
    _rest() {
        const minimum = this._minimum();
        this._bars.forEach(bar => (bar.scale_y = minimum));
    }

    /** One frame: the bars as high as the music, times Settings' sensitivity, up to the ceiling. */
    _move(frame) {
        if (!this.mapped)
            return;
        const gain = this._settings.get_int('cava-sensitivity') / 100;
        const ceiling = this._ceiling();
        const minimum = this._minimum();
        for (let i = 0; i < this._bars.length; i++)
            this._bars[i].scale_y = Math.min(ceiling, Math.max(minimum, frame[i] * gain * ceiling));
    }
});
