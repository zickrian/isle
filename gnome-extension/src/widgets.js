// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Small building blocks shared by the island's views.

import Clutter from 'gi://Clutter';
import GdkPixbuf from 'gi://GdkPixbuf';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Gio from 'gi://Gio';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {iconSize, onUiScale, px, uiScale} from './compat.js';

let iconDir = null;
/** Icons by name, made once: a GIcon never changes, and looking for the file is a disk access. */
const icons = new Map();

/** Tells `icon()` where the extension's bundled icons live. */
export function setIconDir(dir) {
    iconDir = dir;
    icons.clear();
}

/** GNOME's icons that Isle draws itself (icons/), in SF Symbols' manner; a name or the start of one. */
const OWN_ICONS = {
    'audio-volume-muted': 'isle-speaker-off-symbolic',
    'audio-volume-low': 'isle-speaker-1-symbolic',
    'audio-volume-medium': 'isle-speaker-2-symbolic',
    'audio-volume-high': 'isle-speaker-3-symbolic',
    'audio-volume-overamplified': 'isle-speaker-3-symbolic',
    'audio-speakers': 'isle-speaker-2-symbolic',
    'audio-card': 'isle-speaker-2-symbolic',
    'audio-headphones': 'isle-headphones-symbolic',
    'audio-headset': 'isle-headphones-symbolic',
    'display-brightness': 'isle-sun-symbolic',
    'keyboard-brightness': 'isle-sun-min-symbolic',
    'microphone-sensitivity-muted': 'isle-mic-off-symbolic',
    'microphone-disabled': 'isle-mic-off-symbolic',
    'microphone-hardware-disabled': 'isle-mic-off-symbolic',
    'microphone-sensitivity': 'isle-mic-symbolic',
    'audio-input-microphone': 'isle-mic-symbolic',
    'touchpad-disabled': 'isle-touchpad-off-symbolic',
    'input-touchpad': 'isle-touchpad-symbolic',
    'airplane-mode': 'isle-airplane-symbolic',
    'camera-disabled': 'isle-video-off-symbolic',
    'camera-hardware-disabled': 'isle-video-off-symbolic',
    'camera': 'isle-video-symbolic',
    'bluetooth-disabled': 'isle-bluetooth-off-symbolic',
    'bluetooth-hardware-disabled': 'isle-bluetooth-off-symbolic',
    'bluetooth': 'isle-bluetooth-symbolic',
    'network-wireless-disabled': 'isle-wifi-off-symbolic',
    'network-wireless-offline': 'isle-wifi-off-symbolic',
    'network-wireless-hardware-disabled': 'isle-wifi-off-symbolic',
    'network-wireless': 'isle-wifi-symbolic',
    'video-display': 'isle-display-symbolic',
    'input-mouse': 'isle-mouse-symbolic',
    'input-keyboard': 'isle-keyboard-symbolic',
    'phone': 'isle-phone-symbolic',
    'dialog-warning': 'isle-warning-symbolic',
    'dialog-information': 'isle-info-symbolic',
    'software-update-available': 'isle-update-symbolic',
    'media-record': 'isle-record-symbolic',
};
const OWN_KEYS = Object.keys(OWN_ICONS).sort((a, b) => b.length - a.length);
// A state a key's glyph doesn't show ("bluetooth-disabled" isn't "bluetooth"): left to GNOME unless listed.
const OTHER_STATE = /(^|-)(disabled|muted|off|offline|disconnected|none|no-route|acquiring|error|blocked)(-|$)/;

/** Isle's own icon for GNOME's `name` ("audio-volume-high-symbolic"), or null. */
function ownName(name) {
    const base = name.replace(/-symbolic$/, '');
    const key = OWN_KEYS.find(k => base === k ||
        (base.startsWith(`${k}-`) && !OTHER_STATE.test(base.slice(k.length + 1))));
    return key ? OWN_ICONS[key] : null;
}

/** `gicon` in Isle's own style when Isle draws it (GNOME's OSD and device icons), else as it is. */
export function ownIcon(gicon) {
    const names = gicon instanceof Gio.ThemedIcon ? gicon.get_names() : [];
    const own = names.map(ownName).find(Boolean);
    return own ? icon(own) : gicon;
}

// A `Gio.Icon` for `name`: a bundled one (in `icons/`) if it exists, else a themed icon. A bundled
// `-symbolic` one has fills only: GNOME fills every shape, turning outlines into blobs.
export function icon(name) {
    name = ownName(name) ?? name;
    if (!icons.has(name)) {
        const file = iconDir?.get_child(`${name}.svg`);
        icons.set(name, file?.query_exists(null) ? new Gio.FileIcon({file}) : new Gio.ThemedIcon({name}));
    }
    return icons.get(name);
}

/** A label centred vertically in its row. */
export function label(text, styleClass, props = {}) {
    return new St.Label({text, style_class: styleClass, y_align: Clutter.ActorAlign.CENTER, ...props});
}

/** Wraps a label over lines, breaking a long word where it must, with no hyphen added ("example.co-m"). */
export function wrapLines(label, ellipsize = Pango.EllipsizeMode.NONE) {
    const text = wrapText(label, ellipsize);
    // St sets the text's attributes again from the style each time it changes; ours goes on top.
    let ours = null;
    const noHyphens = () => {
        const current = text.get_attributes();
        if (ours && current?.equal(ours))
            return;
        ours = current?.copy() ?? new Pango.AttrList();
        ours.insert(Pango.attr_insert_hyphens_new(false));
        text.set_attributes(ours);
    };
    label.connect_after('style-changed', noHyphens);
    noHyphens();
}

/** As `wrapLines`, for a label whose text never changes: in markup, the rule outlives restyles with no hook
 * run on each. Setting `text` again would drop it. */
export function wrapFixedLines(label, ellipsize = Pango.EllipsizeMode.NONE) {
    wrapText(label, ellipsize).set_markup(`<span insert_hyphens="false">${GLib.markup_escape_text(label.text, -1)}</span>`);
}

/** Wraps by word, breaking inside one too long for a line; returns the label's ClutterText. */
function wrapText(label, ellipsize) {
    const text = label.clutter_text;
    text.line_wrap = true;
    text.line_wrap_mode = Pango.WrapMode.WORD_CHAR;
    text.ellipsize = ellipsize;
    return text;
}

/** Fences a bin's or fixed layout's children with two empty ends, so St never restyles a child's subtree as it
 * becomes or stops being the first or last shown. Returns the end to add further children before. */
export function fence(box) {
    box.insert_child_at_index(new Clutter.Actor(), 0);
    const end = new Clutter.Actor();
    box.add_child(end);
    return end;
}

/** A round icon button. */
export function iconButton(iconName, styleClass, onClick, {size = 16, accessibleName = ''} = {}) {
    const button = new St.Button({
        style_class: `isle-button ${styleClass}`,
        child: new St.Icon({gicon: icon(iconName), icon_size: iconSize(size)}),
        can_focus: true,
        accessible_name: accessibleName,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

/** A small × over the top-left corner of an alert's icon, shown under the pointer (see `revealClose`), taking
 * no room. `out` (CSS px) sets it further out from the corner, for a round icon whose corner is empty. */
export function cornerClose(onClick, {out = 8} = {}) {
    const button = iconButton('isle-close-symbolic', 'isle-corner-close', onClick, {size: 8, accessibleName: 'Close'});
    // Always there, only faded out and untouchable: showing and hiding it would restyle the icon beside it.
    button.set({x_align: Clutter.ActorAlign.START, y_align: Clutter.ActorAlign.START, opacity: 0, reactive: false,
        can_focus: false});
    onUiScale(button, scale => button.set_translation(-out * scale, -out * scale, 0));
    return button;
}

/** Fades a `cornerClose` × in or out. */
export function revealClose(button, shown) {
    if (shown === Boolean(button._shown))
        return;
    button._shown = shown;
    button.reactive = button.can_focus = shown;
    button.remove_transition('opacity');
    button.ease({opacity: shown ? 255 : 0, duration: shown ? 140 : 100, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
}

/** The music bars move about this often (ms), whatever the display: each step is too small to see more of,
 * and every frame of a 144 Hz display cost the shell twice the work (the island's other motion keeps its rate). */
const BARS_STEP_MS = 1000 / 60 - 4;

/** A pill-shaped text button. */
export function pillButton(text, styleClass, onClick) {
    const button = new St.Button({
        style_class: `isle-pill ${styleClass}`,
        label: text,
        can_focus: true,
        y_align: Clutter.ActorAlign.CENTER,
    });
    button.connect('clicked', () => onClick());
    return button;
}

/** Opacity of disabled controls: still visible, clearly not available. */
const DISABLED_OPACITY = 90;

// Enables or disables a button; disabled ones stay in place, dimmed, so the layout never jumps.
// Dimmed by opacity, not CSS colour: the bundled icons are white images that take no colour.
export function setEnabled(button, enabled) {
    button.reactive = enabled;
    button.can_focus = enabled;
    const opacity = enabled ? 255 : DISABLED_OPACITY;
    if (!restsAt(button, 'opacity', opacity))
        button.ease({opacity, duration: 150});
}

/** Whether `actor`'s `property` is `value`, with no ease under way: Clutter would still run one to it. */
export function restsAt(actor, property, value) {
    return actor[property] === value && !actor.get_transition(property);
}

/** Sets an icon button's icon. */
export function setButtonIcon(button, iconName) {
    button.child.gicon = icon(iconName);
}

/** A circular progress ring, optionally with a child centred inside; `progress` can be eased. */
export const Ring = GObject.registerClass({
    Properties: {
        'progress': GObject.ParamSpec.double('progress', null, null,
            GObject.ParamFlags.READWRITE, 0, 1, 0),
    },
}, class Ring extends St.Widget {
    /** `size` in CSS pixels; `child` (a badge) sits in the middle and pops in with a sweep. */
    _init({size, lineWidth = 2.5, color = [1, 1, 1], trackOpacity = 0.18, child = null}) {
        super._init({
            layout_manager: new Clutter.BinLayout(),
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._size = size;
        this._progress = 0;
        this._lineWidth = lineWidth;
        this._color = color;
        this._trackOpacity = trackOpacity;
        /** A sweep to run once on screen ({progress, delay}): off screen, ease() skips to the end. */
        this._pendingFill = null;
        this._sweeping = null;

        this._area = new St.DrawingArea({x_expand: true, y_expand: true});
        this._area.connect('repaint', area => this._repaint(area));
        this.add_child(this._area);
        this._child = child;
        if (child) {
            child.x_align = child.y_align = Clutter.ActorAlign.CENTER;
            child.set_pivot_point(0.5, 0.5);
            this.add_child(child);
        }
        // The innermost part that animates is mapped last: ease() skips actors not yet mapped.
        (child ?? this._area).connect('notify::mapped', () => this._onMapped());
        onUiScale(this, scale => this.set_size(this._size * scale, this._size * scale));
    }

    /** Makes the ring `size` CSS pixels wide. */
    resize(size) {
        this._size = size;
        this.set_size(px(size), px(size));
    }

    /** How much of the ring is drawn, 0..1. */
    get progress() {
        return this._progress;
    }

    /** Clamped; repaints only for a change that shows. */
    set progress(value) {
        const clamped = Math.min(1, Math.max(0, value));
        if (Math.abs(clamped - this._progress) < 0.001)
            return;
        this._progress = clamped;
        this.notify('progress');
        this._area.queue_repaint();
    }

    /** Sweeps from empty to `progress`, like the charging ring, as the badge inside pops in. */
    fillTo(progress, {delay = 0} = {}) {
        this._pendingFill = {progress, delay};
        this._restart();
    }

    /** Moves to `progress` at once, or there at the end of a sweep under way. */
    jumpTo(progress) {
        const sweeping = this._sweeping;
        this._pendingFill ??= sweeping;
        if (this._pendingFill) {
            this._pendingFill.progress = progress;
            // Still waiting out its delay, it only needs a new end; else it carries on from where it is.
            const transition = sweeping && this._progress === 0 && this.get_transition('progress');
            if (transition)
                transition.set_to(progress);
            else if (sweeping)
                this._restart(this._progress);
            return;
        }
        this.progress = progress;
    }

    // Hidden mid-sweep (an alert put away and back), it starts over when shown again.
    _onMapped() {
        const mapped = (this._child ?? this._area).mapped;
        if (!mapped && this._sweeping) {
            this._pendingFill = this._sweeping;
            this._restart();
        } else if (mapped && this._pendingFill) {
            this._sweep();
        }
    }

    /** Drops the sweep under way and starts again from `from`, the badge shrunk when starting empty. */
    _restart(from = 0) {
        this.remove_transition('progress');
        this._sweeping = null;
        this.progress = from;
        if (from === 0) {
            this._child?.remove_all_transitions();
            this._child?.set_scale(0.6, 0.6);
        }
        if ((this._child ?? this._area).mapped)
            this._sweep();
    }

    /** Runs the waiting sweep, and pops the badge in if it is still small. */
    _sweep() {
        const fill = this._pendingFill ?? this._sweeping;
        if (!fill)
            return;
        this._pendingFill = null;
        this._sweeping = fill;
        this.ease_property('progress', fill.progress, {
            delay: this._progress > 0 ? 0 : fill.delay,
            duration: this._progress > 0 ? 300 : 1000,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
            onStopped: () => {
                if (this._sweeping === fill)
                    this._sweeping = null;
            },
        });
        if (this._child?.scale_x < 1 && !this._child.get_transition('scale-x')) {
            this._child.ease({
                scale_x: 1,
                scale_y: 1,
                delay: this._progress > 0 ? 0 : fill.delay,
                duration: 450,
                mode: Clutter.AnimationMode.EASE_OUT_BACK,
            });
        }
    }

    /** [r, g, b], each 0..1. */
    set color(rgb) {
        const color = this._color;
        if (rgb[0] === color[0] && rgb[1] === color[1] && rgb[2] === color[2])
            return;
        this._color = rgb;
        this._area.queue_repaint();
    }

    /** The faint track, then the arc of progress from 12 o'clock. */
    _repaint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const lineWidth = px(this._lineWidth);
        const radius = Math.min(width, height) / 2 - lineWidth / 2;
        const [r, g, b] = this._color;
        cr.setLineWidth(lineWidth);
        cr.setLineCap(1); // round

        cr.setSourceRGBA(r, g, b, this._trackOpacity);
        cr.arc(width / 2, height / 2, radius, 0, 2 * Math.PI);
        cr.stroke();

        if (this._progress > 0) {
            const start = -Math.PI / 2;
            cr.setSourceRGBA(r, g, b, 1);
            cr.arc(width / 2, height / 2, radius, start, start + this._progress * 2 * Math.PI);
            cr.stroke();
        }
        cr.$dispose();
    }
});

/** Equaliser bars that dance while music plays. */
export const Bars = GObject.registerClass(
class Bars extends St.BoxLayout {
    /** `height` is the tallest bar, in CSS pixels. */
    _init({height = 14, count = 4} = {}) {
        super._init({style_class: 'isle-bars', y_align: Clutter.ActorAlign.CENTER});
        this._maxHeight = height;
        this._playing = false;
        this._bars = [];
        /** Each bar's bounce: its scale goes `from` → `to` over `duration` ms from `start` (-1: the next frame). */
        this._bounces = [];
        for (let i = 0; i < count; i++) {
            // Full height, scaled about its middle: a scale moves below a pixel and lays nothing out again.
            const bar = new St.Widget({style_class: 'isle-bar', y_align: Clutter.ActorAlign.CENTER});
            bar.set_pivot_point(0.5, 0.5);
            bar.scale_y = this._rest(i);
            // A bar's bounce pauses off screen. Each bar is watched itself: the box maps a moment before them.
            bar.connect('notify::mapped', () => this._bounce(i));
            this._bars.push(bar);
            this._bounces.push({on: false, from: 0, to: 0, start: -1, duration: 0});
            this.add_child(bar);
        }
        // One clock moves every bar: an ease per bounce made garbage many times a second.
        this._clock = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._clock.connect('new-frame', () => this._step());
        this._now = 0;
        this._steppedAt = -Infinity;
        this.connect('destroy', () => this._onDestroy());
        onUiScale(this, () => (this.maxHeight = this._maxHeight));
    }

    /** The tallest a bar gets, in CSS pixels. */
    set maxHeight(height) {
        this._maxHeight = height;
        const stageHeight = px(height);
        this.height = stageHeight;
        this._bars.forEach(bar => (bar.height = stageHeight));
    }

    /** Bar `index`'s height at rest, as a share of the tallest. */
    _rest(index) {
        // A fixed "|ılı" silhouette when not animating.
        return [0.45, 1, 0.7, 0.35, 0.8][index % 5];
    }

    /** Animates the bars. Costs a redraw per frame, so only use when visible. */
    set playing(playing) {
        if (playing === this._playing)
            return;
        this._playing = playing;
        if (!playing)
            this._stop();
        this._bars.forEach((bar, index) => {
            bar.remove_all_transitions();
            if (playing)
                this._bounce(index);
            else if (this.mapped)
                bar.ease({scale_y: this._rest(index), duration: 200});
            else
                bar.scale_y = this._rest(index);
        });
    }

    /** Starts bar `index` on a new bounce from where it is, or stops it. */
    _bounce(index) {
        const bounce = this._bounces[index];
        const bar = this._bars[index];
        const settings = St.Settings.get();
        // With animations off the bars rest where they are.
        bounce.on = this._playing && bar.mapped && settings.enable_animations;
        if (bounce.on) {
            bounce.from = bar.scale_y;
            bounce.to = 0.25 + Math.random() * 0.75;
            bounce.start = -1;
            // Slowed down as ease() is.
            bounce.duration = (180 + Math.random() * 220) * settings.slow_down_factor;
            if (!this._clock.is_playing()) {
                this._now = 0;
                this._steppedAt = -Infinity;
                this._clock.start();
            }
        } else if (!this._bounces.some(other => other.on)) {
            this._clock.stop();
        }
    }

    /** One tick of the shared clock: each bouncing bar moves along its curve. */
    _step() {
        this._now += this._clock.get_delta();
        // Frames in between change nothing, so the shell draws nothing new for them (see BARS_STEP_MS).
        if (this._now - this._steppedAt < BARS_STEP_MS)
            return;
        this._steppedAt = this._now;
        for (let i = 0; i < this._bounces.length; i++) {
            const bounce = this._bounces[i];
            if (!bounce.on)
                continue;
            // As an ease, it starts the frame after it is made.
            if (bounce.start < 0)
                bounce.start = this._now;
            const t = (this._now - bounce.start) / bounce.duration;
            if (t >= 1) {
                this._bars[i].scale_y = bounce.to;
                this._bounce(i);
            } else {
                // EASE_IN_OUT_SINE, as Clutter has it.
                this._bars[i].scale_y = bounce.from + (bounce.to - bounce.from) * -(Math.cos(Math.PI * t) - 1) / 2;
            }
        }
    }

    /** Stops every bounce and the clock. */
    _stop() {
        for (const bounce of this._bounces)
            bounce.on = false;
        this._clock.stop();
    }

    /** Leaves no clock running. */
    _onDestroy() {
        this._playing = false;
        this._stop();
    }
});

/** Whether `gicon` is a one-colour (symbolic) icon rather than an app's. */
export function isSymbolic(gicon) {
    if (gicon instanceof Gio.ThemedIcon)
        return gicon.get_names().some(name => name.endsWith('-symbolic'));
    if (gicon instanceof Gio.FileIcon)
        return Boolean(gicon.get_file().get_basename()?.includes('-symbolic'));
    return false;
}

/** A key for `path`'s current contents: a player may write new art under the same name. */
function fileKey(path) {
    try {
        const info = Gio.File.new_for_path(path).query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null);
        return `${path}\u001f${info.get_attribute_uint64('time::modified')}`;
    } catch {
        return null;
    }
}

/** What a cover at `path` shows, as `fileKey` tells it (the path while unreadable); '' for none. */
export function coverKey(path) {
    return path ? fileKey(path) ?? path : '';
}

/** Remembers the last few results of `compute(path)`, by `fileKey`, so a cover is decoded once. */
export function memoByFile(compute, size = 20) {
    const cache = new Map();
    return path => {
        const key = path ? fileKey(path) : null;
        if (key === null)
            return compute(path);
        if (!cache.has(key)) {
            if (cache.size >= size)
                cache.delete(cache.keys().next().value);
            cache.set(key, compute(path));
        }
        return cache.get(key);
    };
}

// Whether the image at `path` is an icon (a logo with transparent corners) rather than a cover.
const isIcon = memoByFile(path => {
    try {
        const pixbuf = GdkPixbuf.Pixbuf.new_from_file_at_size(path, 32, 32);
        if (!pixbuf.has_alpha)
            return false;
        const pixels = pixbuf.get_pixels();
        const {width, height, rowstride} = pixbuf;
        const alphaAt = (x, y) => pixels[y * rowstride + x * 4 + 3];
        return alphaAt(0, 0) === 0 && alphaAt(width - 1, height - 1) === 0;
    } catch {
        return false;
    }
});

/** Longest side of the copies covers are shown from: the biggest art, 104 px, at up to 2.5× scale. */
const COVER_SIZE = 256;
/** Copies kept; none on screen is that many songs old (see `memoByFile`). */
const COVERS_KEPT = 30;
const coversMade = [];
let oldCoversCleared = false;

/** Copies an earlier GNOME Shell left (this list starts empty with it) go on first use: they live in RAM. */
function clearOldCovers(dir) {
    if (oldCoversCleared)
        return;
    oldCoversCleared = true;
    // The listing may land after this shell's first copies are written: those stay.
    forEachChild(dir, child => {
        if (!coversMade.includes(child.get_path()))
            child.delete_async(GLib.PRIORITY_LOW, null, null);
    });
}

/** Calls `callback` with each file in the folder at `path`, read off the main loop's way; none if it is not there. */
export function forEachChild(path, callback, cancellable = null) {
    Gio.File.new_for_path(path).enumerate_children_async('standard::name', Gio.FileQueryInfoFlags.NONE,
        GLib.PRIORITY_LOW, cancellable, (folder, result) => {
            let children;
            try {
                children = folder.enumerate_children_finish(result);
            } catch {
                return; // not there
            }
            const next = () => children.next_files_async(32, GLib.PRIORITY_LOW, cancellable, (_children, batch) => {
                let infos = [];
                try {
                    infos = children.next_files_finish(batch);
                } catch {
                    // Cancelled, or unreadable: the rest is left.
                }
                if (infos.length === 0) {
                    children.close_async(GLib.PRIORITY_LOW, null, null);
                    return;
                }
                infos.forEach(info => callback(children.get_child(info), info));
                next();
            });
            next();
        });
}

/** A small copy of the cover at `path`, decoded and saved off the main thread, or null: St decodes a background
 * image whole in the frame that first paints it, tens of milliseconds for a big cover. */
export const smallCover = memoByFile(async path => {
    if (!path)
        return null;
    let copy = null;
    try {
        const stream = await new Promise((resolve, reject) => {
            Gio.File.new_for_path(path).read_async(GLib.PRIORITY_LOW, null, (file, result) => {
                try {
                    resolve(file.read_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
        const pixbuf = await new Promise((resolve, reject) => {
            GdkPixbuf.Pixbuf.new_from_stream_at_scale_async(stream, COVER_SIZE, COVER_SIZE, true, null, (_source, result) => {
                stream.close(null);
                try {
                    resolve(GdkPixbuf.Pixbuf.new_from_stream_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
        const dir = GLib.build_filenamev([GLib.get_user_runtime_dir(), 'isle-covers']);
        GLib.mkdir_with_parents(dir, 0o700);
        copy = GLib.build_filenamev([dir, `${GLib.uuid_string_random()}.png`]);
        coversMade.push(copy);
        clearOldCovers(dir);
        const out = await new Promise((resolve, reject) => {
            Gio.File.new_for_path(copy).replace_async(null, false, Gio.FileCreateFlags.PRIVATE, GLib.PRIORITY_LOW, null,
                (file, result) => {
                    try {
                        resolve(file.replace_finish(result));
                    } catch (e) {
                        reject(e);
                    }
                });
        });
        await new Promise((resolve, reject) => {
            pixbuf.save_to_streamv_async(out, 'png', [], [], null, (_source, result) => {
                out.close(null);
                try {
                    resolve(GdkPixbuf.Pixbuf.save_to_stream_finish(result));
                } catch (e) {
                    reject(e);
                }
            });
        });
        if (coversMade.length > COVERS_KEPT)
            GLib.unlink(coversMade.shift());
        return copy;
    } catch {
        // Nothing half written is left behind.
        if (copy) {
            const made = coversMade.indexOf(copy);
            if (made >= 0)
                coversMade.splice(made, 1);
            GLib.unlink(copy);
        }
        return null;
    }
});

/** Square cover art with rounded corners and a placeholder. */
export const Art = GObject.registerClass({
    // The image changed; `showsIcon` may have too.
    Signals: {'shown': {}},
}, class Art extends St.Bin {
    /** `size` and `radius` in CSS pixels. */
    _init({size, radius}) {
        super._init({
            style_class: 'isle-art',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._size = size;
        this._radius = radius;
        this._path = null;
        /** `coverKey` of the cover shown: a player may write the next song's under the same name. */
        this._key = null;
        this._showsIcon = false;
        this._placeholder = new St.Icon({
            gicon: icon('isle-music'),
            icon_size: iconSize(Math.round(size * 0.42)),
            style_class: 'isle-art-placeholder',
        });
        this.setPath('');
        onUiScale(this, scale => this.set_size(this._size * scale, this._size * scale));
        this.connect('destroy', () => {
            this._destroyed = true;
            // Not a child while a cover shows.
            if (!this._placeholder.get_parent())
                this._placeholder.destroy();
        });
    }

    /** Resizes the art to `size` CSS pixels; `radius` is its new corner radius. */
    resize(size, radius) {
        this._size = size;
        this.set_size(px(size), px(size));
        this._placeholder.icon_size = iconSize(Math.round(size * 0.42));
        this._radius = radius;
        this._key = null;
        this.setPath(this._path);
    }

    /** Shows the cover at `path`, once its small copy is ready (see `smallCover`); until then the last one. */
    setPath(path) {
        const key = coverKey(path);
        if (key === this._key)
            return;
        this._path = path;
        this._key = key;
        if (!path) {
            this._show(null);
            return;
        }
        smallCover(path).then(cover => {
            if (key === this._key && !this._destroyed)
                this._show(cover ?? path);
        });
    }

    /** The image at `path` as the background, or the placeholder for none; then emits `shown`. */
    _show(path) {
        const base = `border-radius: ${this._radius}px;`;
        if (path) {
            const uri = GLib.filename_to_uri(path, null).replace(/"/g, '%22');
            // An app's logo instead of a cover (Chrome sends its own when the
            // page has none) is shown whole, without the tile behind it.
            this._showsIcon = isIcon(path);
            const fit = this._showsIcon
                ? 'background-size: contain; background-color: transparent;'
                : 'background-size: cover;';
            this.style = `${base} background-image: url("${uri}"); ${fit}`;
            this.child = null;
        } else {
            this._showsIcon = false;
            this.style = base;
            this.child = this._placeholder;
        }
        this.emit('shown');
    }

    /** Whether the image is an app's logo rather than a cover. */
    get showsIcon() {
        return this._showsIcon;
    }
});

// Places `actor` inside its parent at the given rectangle. For `vfunc_allocate`, where setting
// position and size properties would queue another layout mid-layout.
function allocateAt(actor, x, y, width, height) {
    actor.allocate(Clutter.ActorBox.new(x, y, x + width, y + height));
}

/** Motions an alert's icon makes once as it appears, as SF Symbols' effects: steps of [values, ms, easing].
 * Transforms only, so nothing is laid out or restyled again. */
const MOTIONS = {
    // A small hop: notifications, an answer, a new version.
    bounce: [[{scale_x: 1.18, scale_y: 1.18}, 140, 'EASE_OUT_QUAD'], [{scale_x: 1, scale_y: 1}, 260, 'EASE_OUT_BACK']],
    // Once bigger and back: the charging bolt, recording.
    pulse: [[{scale_x: 1.24, scale_y: 1.24}, 170, 'EASE_OUT_SINE'], [{scale_x: 1, scale_y: 1}, 230, 'EASE_IN_OUT_SINE']],
    // A bell ringing: a sway, a little bigger at first. Side to side rather than turned, which costs the GPU a
    // slow first frame.
    ring: [[{translation_x: -1.6, scale_x: 1.08, scale_y: 1.08}, 90, 'EASE_OUT_SINE'],
        [{translation_x: 1.6}, 110, 'EASE_IN_OUT_SINE'], [{translation_x: -1.1}, 100, 'EASE_IN_OUT_SINE'],
        [{translation_x: 0.6}, 90, 'EASE_IN_OUT_SINE'], [{translation_x: 0, scale_x: 1, scale_y: 1}, 100, 'EASE_OUT_SINE']],
    // Coming up from below as it fades in, with the alert: Caps Lock turned on.
    rise: [[{translation_y: 0, opacity: 255}, 380, 'EASE_OUT_CUBIC']],
    // Side to side, as for a wrong password: something stopped.
    shake: [[{translation_x: -3}, 60, 'EASE_OUT_SINE'], [{translation_x: 3}, 80, 'EASE_IN_OUT_SINE'],
        [{translation_x: -2}, 70, 'EASE_IN_OUT_SINE'], [{translation_x: 0}, 60, 'EASE_OUT_SINE']],
};
const REST = {scale_x: 1, scale_y: 1, translation_x: 0, translation_y: 0, opacity: 255};
/** A rise starts as the alert fades in (see FADE_IN_DELAY in island.js): later, its badge showed empty first. */
const RISE_DELAY = 120;
/** Motions waiting for their actor to be on screen (GNOME skips eases on actors that are not). */
const pendingMotions = new WeakMap();

/** Slides `actor` along `axis` ('x' or 'y') from `from` to `to` px, in whole pixels: between two pixels a picture
 * or text is resampled and shivers. `onDone` runs on arrival; a later slide on the same axis takes over. */
export function slideBy(actor, axis, from, to, {delay = 0, duration = 0, onDone = null} = {}) {
    const key = `_isleSlide${axis}`;
    const property = `translation_${axis}`;
    actor[key]?.stop();
    actor[key] = null;
    actor[property] = from;
    if (!duration || from === to || !actor.mapped || !St.Settings.get().enable_animations) {
        actor[property] = to;
        onDone?.();
        return;
    }
    if (!actor._isleSlideWatched) {
        actor._isleSlideWatched = true;
        actor.connect('destroy', () => ['x', 'y'].forEach(each => actor[`_isleSlide${each}`]?.stop()));
    }
    const timeline = new Clutter.Timeline({actor, duration, delay, progress_mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    timeline.connect('new-frame', () => (actor[property] = Math.round(from + (to - from) * timeline.get_progress())));
    timeline.connect('completed', () => {
        actor[property] = to;
        onDone?.();
    });
    timeline.connect('stopped', () => {
        if (actor[key] === timeline)
            actor[key] = null;
    });
    actor[key] = timeline;
    timeline.start();
}

/** Plays `motion` (see `MOTIONS`) on `actor` once, `delay` ms after it is on screen; none with animations off. */
export function playMotion(actor, motion, {delay = 0} = {}) {
    const steps = MOTIONS[motion];
    actor.remove_all_transitions();
    actor.set(REST);
    const pending = pendingMotions.get(actor);
    if (pending)
        pending.run = null;
    if (!steps || !St.Settings.get().enable_animations)
        return;
    actor.set_pivot_point(0.5, 0.5);
    if (motion === 'rise') {
        actor.set({translation_y: px(5), opacity: 0});
        delay = Math.min(delay, RISE_DELAY);
    }
    const run = () => {
        const scale = uiScale();
        const next = i => {
            if (i >= steps.length)
                return;
            const [values, duration, mode] = steps[i];
            // Distances are in CSS pixels.
            const scaled = Object.fromEntries(Object.entries(values).map(([key, value]) =>
                [key, key.startsWith('translation_') ? value * scale : value]));
            actor.ease({...scaled, duration, delay: i === 0 ? delay : 0, mode: Clutter.AnimationMode[mode],
                onComplete: () => next(i + 1)});
        };
        next(0);
    };
    if (actor.mapped) {
        run();
        return;
    }
    // Once, when it shows; a newer motion replaces this one.
    if (!pending) {
        const waiting = {run};
        pendingMotions.set(actor, waiting);
        actor.connect('notify::mapped', () => {
            if (actor.mapped && waiting.run) {
                const later = waiting.run;
                waiting.run = null;
                later();
            }
        });
    } else {
        pending.run = run;
    }
}

/** How long a speaker's wave takes to come or go, and the gap between waves coming in turn. */
const WAVE_MS = 180;
const WAVE_STAGGER_MS = 70;

/** A speaker whose waves come one by one as the volume rises and go as it falls. */
export const VolumeGlyph = GObject.registerClass(
class VolumeGlyph extends St.Widget {
    /** The speaker, its slashed form and three waves, stacked; `size` in CSS pixels. */
    _init({size = 16} = {}) {
        super._init({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER});
        const part = name => new St.Icon({gicon: icon(name), icon_size: iconSize(size)});
        this._body = part('isle-speaker-0-symbolic');
        this._off = part('isle-speaker-off-symbolic');
        this._off.opacity = 0;
        // Each wave grows out from the speaker's cone.
        this._waves = [1, 2, 3].map(n => {
            const wave = part(`isle-speaker-wave-${n}-symbolic`);
            wave.opacity = 0;
            wave.set_pivot_point(0.45, 0.5);
            wave.set_scale(0.6, 0.6);
            wave.on = false;
            return wave;
        });
        for (const actor of [this._body, ...this._waves, this._off])
            this.add_child(actor);
        this._count = 0;
        this._muted = false;
        // Waves to bring in once on screen: ease() skips to the end before then. The last child is mapped last.
        this._pending = false;
        this._off.connect('notify::mapped', () => {
            if (this._off.mapped && this._pending) {
                this._pending = false;
                this._sync(true);
            }
        });
    }

    /** A wave per third of `level` (0..1), none at 0, the speaker slashed when `muted`; `fresh` brings
     * the waves in one after another, for an alert just shown. */
    setLevel(level, muted, {fresh = false} = {}) {
        this._count = Math.ceil(Math.min(1, Math.max(0, level)) * 3);
        this._muted = muted;
        if (fresh) {
            for (const wave of this._waves) {
                wave.remove_all_transitions();
                wave.opacity = 0;
                wave.set_scale(0.6, 0.6);
                wave.on = false;
            }
            this._body.remove_all_transitions();
            this._off.remove_all_transitions();
            this._body.opacity = muted ? 0 : 255;
            this._off.opacity = muted ? 255 : 0;
            this._pending = !this._off.mapped;
        }
        if (!this._pending)
            this._sync(fresh);
    }

    /** Eases the waves and speaker to the level and mute state; `stagger` brings waves in one by one. */
    _sync(stagger) {
        const shown = this._muted ? 0 : this._count;
        this._waves.forEach((wave, index) => {
            const on = index < shown;
            if (on === wave.on)
                return;
            wave.on = on;
            wave.ease({
                opacity: on ? 255 : 0,
                scale_x: on ? 1 : 0.6,
                scale_y: on ? 1 : 0.6,
                delay: on && stagger ? index * WAVE_STAGGER_MS : 0,
                duration: WAVE_MS,
                mode: on ? Clutter.AnimationMode.EASE_OUT_CUBIC : Clutter.AnimationMode.EASE_IN_QUAD,
            });
        });
        const [body, off] = this._muted ? [0, 255] : [255, 0];
        if (!restsAt(this._body, 'opacity', body))
            this._body.ease({opacity: body, duration: WAVE_MS});
        if (!restsAt(this._off, 'opacity', off))
            this._off.ease({opacity: off, duration: WAVE_MS});
    }
});

/** A thin horizontal level meter. */
export const LevelBar = GObject.registerClass(
class LevelBar extends St.Widget {
    /** As wide as `width` CSS pixels at any scale. */
    _init({width, styleClass = ''}) {
        super._init({
            style_class: `isle-level ${styleClass}`,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._fill = new St.Widget({style_class: 'isle-level-fill', width: 0});
        this.add_child(this._fill);
        /** Its width in stage pixels, from `width` in CSS pixels. */
        this._width = 0;
        this._level = 0;
        /** The delay of a grow waiting for the bar to be on screen; see `growTo`. */
        this._pendingGrow = null;
        // The fill is mapped after the bar, and ease() skips it until then.
        this._fill.connect('notify::mapped', () => {
            if (this._fill.mapped && this._pendingGrow !== null)
                this._grow();
        });
        onUiScale(this, scale => {
            this._width = width * scale;
            this.width = this._width;
            if (this._pendingGrow === null) {
                this._fill.remove_transition('width');
                this._fill.width = Math.round(this._width * this._level);
            }
        });
    }

    // Sized by its `width`; the fill inside never widens it.
    vfunc_get_preferred_width(_forHeight) {
        return [this._width, this._width];
    }

    /** Sets the level; on screen, the fill glides to it. */
    set level(value) {
        this._level = Math.min(1, Math.max(0, value));
        if (this._pendingGrow !== null)
            return;
        const fill = Math.round(this._width * this._level);
        if (restsAt(this._fill, 'width', fill))
            return;
        this._fill.remove_transition('width');
        if (this.mapped)
            this._fill.ease({width: fill, duration: 160, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        else
            this._fill.width = fill;
    }

    /** 0..1. */
    get level() {
        return this._level;
    }

    /** Grows from empty to `value`, for an alert just shown; off screen, once shown. */
    growTo(value, {delay = 0} = {}) {
        this._fill.remove_transition('width');
        this._fill.width = 0;
        this._pendingGrow = delay;
        this.level = value;
        if (this._fill.mapped)
            this._grow();
    }

    /** Eases the fill out from empty after the waiting delay. */
    _grow() {
        const delay = this._pendingGrow;
        this._pendingGrow = null;
        this._fill.ease({
            width: Math.round(this._width * this._level),
            delay,
            duration: 500,
            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
        });
    }

    /** CSS colour of the filled part. */
    set fillColor(color) {
        this._fill.style = `background-color: ${color};`;
    }

    /** The fill from the left edge, at its current width. */
    vfunc_allocate(box) {
        this.set_allocation(box);
        // The fill's width is the (possibly easing) value set in `level`.
        allocateAt(this._fill, 0, 0, this._fill.width, box.get_height());
    }
});

/** A horizontal slider. Emits `value-changed` while it moves and `released` with the final value. */
export const Slider = GObject.registerClass({
    Signals: {
        'value-changed': {param_types: [GObject.TYPE_DOUBLE]},
        'released': {param_types: [GObject.TYPE_DOUBLE]},
    },
}, class Slider extends St.Widget {
    /** `scrollStep` is how far one scroll moves it; 0 leaves scrolling to the parent. */
    _init({scrollStep = 0} = {}) {
        super._init({
            style_class: 'isle-slider',
            reactive: true,
            track_hover: true,
            x_expand: true,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._scrollStep = scrollStep;
        this._track = new St.Widget({style_class: 'isle-slider-track'});
        this._fill = new St.Widget({style_class: 'isle-slider-fill'});
        this._knob = new St.Widget({style_class: 'isle-slider-knob', opacity: 0});
        this.add_child(this._track);
        this.add_child(this._fill);
        this.add_child(this._knob);
        this._value = 0;
        /** The fill's width last laid out, in whole pixels, and the width it was out of. */
        this._filled = null;
        this._width = 0;
        this._grab = null;
        this.connect('notify::hover', () => this._syncKnob());
        // Gone mid-drag (the screen locked): the pointer is let go.
        this.connect('destroy', () => {
            this._grab?.dismiss();
            this._grab = null;
        });
    }

    /** Where it is, 0..1. */
    get value() {
        return this._value;
    }

    // The track is sized from this allocation, so the slider only takes the space its parent gives it.
    vfunc_get_preferred_width(_forHeight) {
        return [0, 0];
    }

    /** Sets the value from outside; ignored while the user is dragging. */
    set value(value) {
        if (this._grab)
            return;
        this._value = Math.min(1, Math.max(0, value || 0));
        // Laid out again only when the fill moves a pixel, not on each tick of a playing song.
        if (Math.round(this._width * this._value) !== this._filled)
            this.queue_relayout();
    }

    /** The knob shows while hovered or dragged. */
    _syncKnob() {
        this._knob.ease({opacity: this.hover || this._grab ? 255 : 0, duration: 120});
    }

    /** Track, fill and knob laid out by hand, the knob centred on the value. */
    vfunc_allocate(box) {
        this.set_allocation(box);
        const [width, height] = [box.get_width(), box.get_height()];
        const trackHeight = px(4);
        const y = Math.round((height - trackHeight) / 2);
        this._width = width;
        this._filled = Math.round(width * this._value);
        allocateAt(this._track, 0, y, width, trackHeight);
        allocateAt(this._fill, 0, y, this._filled, trackHeight);
        const knob = px(12);
        allocateAt(this._knob, Math.round(width * this._value - knob / 2), Math.round((height - knob) / 2), knob, knob);
    }

    /** Sets the value under the pointer and emits `value-changed`. */
    _moveTo(event) {
        const [x] = event.get_coords();
        const [ok, localX] = this.transform_stage_point(x, 0);
        if (ok)
            this._value = Math.min(1, Math.max(0, localX / this.width));
        this.queue_relayout();
        this.emit('value-changed', this._value);
    }

    /** Grabs the pointer, so a drag carries on outside the slider. */
    vfunc_button_press_event(event) {
        // A second button pressed mid-drag keeps the one grab.
        this._grab ??= global.stage.grab(this);
        this._moveTo(event);
        return Clutter.EVENT_STOP;
    }

    /** Follows the pointer while dragging. */
    vfunc_motion_event(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._moveTo(event);
        return Clutter.EVENT_STOP;
    }

    /** Lets go and emits `released` with the final value. */
    vfunc_button_release_event(event) {
        if (!this._grab)
            return Clutter.EVENT_PROPAGATE;
        this._grab.dismiss();
        this._grab = null;
        this._moveTo(event);
        this._syncKnob();
        this.emit('released', this._value);
        return Clutter.EVENT_STOP;
    }

    /** Moves by `scrollStep` and emits both signals, as a scroll has no release. */
    vfunc_scroll_event(event) {
        if (!this._scrollStep)
            return Clutter.EVENT_PROPAGATE;
        const direction = event.get_scroll_direction();
        let delta = 0;
        if (direction === Clutter.ScrollDirection.UP || direction === Clutter.ScrollDirection.RIGHT)
            delta = this._scrollStep;
        else if (direction === Clutter.ScrollDirection.DOWN || direction === Clutter.ScrollDirection.LEFT)
            delta = -this._scrollStep;
        else if (direction === Clutter.ScrollDirection.SMOOTH)
            delta = -event.get_scroll_delta()[1] * this._scrollStep;
        if (!delta)
            return Clutter.EVENT_STOP;
        this._value = Math.min(1, Math.max(0, this._value + delta));
        this.queue_relayout();
        this.emit('value-changed', this._value);
        this.emit('released', this._value);
        return Clutter.EVENT_STOP;
    }
});

/** Coloured dots for what is in use: green camera, orange microphone, blue screen sharing. */
export const PrivacyDots = GObject.registerClass(
class PrivacyDots extends St.BoxLayout {
    /** A hidden dot per kind, always in the same order. */
    _init() {
        super._init({style_class: 'isle-privacy-dots', y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._dots = {};
        for (const kind of ['camera', 'microphone', 'screenShare']) {
            const dot = new St.Widget({style_class: `isle-privacy-dot ${kind}`, visible: false, y_align: Clutter.ActorAlign.CENTER});
            dot.set_pivot_point(0.5, 0.5);
            this._dots[kind] = dot;
            this.add_child(dot);
        }
    }

    /** Shows a dot for each of `privacy`'s camera, microphone and screenShare. */
    update(privacy) {
        for (const [kind, dot] of Object.entries(this._dots)) {
            const on = Boolean(privacy[kind]);
            if (on === dot.visible)
                continue;
            if (on) {
                dot.set_scale(0.4, 0.4);
                dot.opacity = 0;
                dot.show();
                dot.ease({scale_x: 1, scale_y: 1, opacity: 255, duration: 250, mode: Clutter.AnimationMode.EASE_OUT_BACK});
            } else {
                dot.hide();
            }
        }
        this.visible = Object.values(this._dots).some(dot => dot.visible);
    }
});

/** A red dot that breathes slowly while a screen recording runs. */
export const RecordingDot = GObject.registerClass(
class RecordingDot extends St.Widget {
    /** Breathes again each time it is shown. */
    _init() {
        super._init({style_class: 'isle-recording-dot', y_align: Clutter.ActorAlign.CENTER});
        this.connect('notify::mapped', () => this._breathe());
    }

    /** Starts the slow fade in and out; off screen it rests fully lit. */
    _breathe() {
        this.remove_transition('opacity');
        this.opacity = 255;
        if (!this.mapped)
            return;
        // Only animates while on screen; stops by itself when hidden.
        this.ease({
            opacity: 110,
            duration: 900,
            mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
            autoReverse: true,
            repeatCount: -1,
        });
    }
});
