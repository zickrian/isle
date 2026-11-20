// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// One line of text for the closed island: as wide as it is, up to a limit; past it, it scrolls round and round.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {uiScale} from './compat.js';
import {effectPoint, shaderEffect} from './shader.js';

/** How fast it scrolls, in CSS pixels a second. */
const SPEED = 38;
/** How long it waits at the start of each pass, so the beginning can be read. */
const PAUSE_MS = 1800;
/** The room between the end of the text and its repeat, in CSS pixels. */
const GAP = 36;
/** How wide the soft edges are where the scrolling text is cut off, in CSS pixels. */
const EDGE_FADE = 14;
/** The artist after the title is a little quieter. */
const ARTIST_ALPHA = '62%';

/** Fades what it paints out toward its left and right edges, `fade.x` and `fade.y` pixels wide, on an actor `size` big. */
const EdgeFade = shaderEffect('EdgeFade', {size: 2, fade: 2}, `
vec2 p = ${effectPoint('size')};
cogl_color_out *= smoothstep(0.0, fade.x, p.x) * smoothstep(0.0, fade.y, size.x - p.x);
`);

/** The width a text `natural` wide takes within `limit` (stage pixels; 0 or less is no limit), and whether it must
 * scroll to be read. */
export function fit(natural, limit) {
    const full = Math.ceil(natural);
    const width = limit > 0 ? Math.min(full, Math.floor(limit)) : full;
    return {width, scrolls: full > width + 0.5};
}

/** The title with its artist after it, as Pango markup. */
export function markupFor(title, artist) {
    const quoted = text => GLib.markup_escape_text(text, -1);
    return artist ? `${quoted(title)}<span alpha="${ARTIST_ALPHA}">  ·  ${quoted(artist)}</span>` : quoted(title);
}

// Places `actor` at the given rectangle. For `vfunc_allocate`, where setting position and size properties would
// queue another layout mid-layout.
function allocateAt(actor, x, y, width, height) {
    actor.allocate(Clutter.ActorBox.new(x, y, x + width, y + height));
}

/** Text in a line of its own: its natural width up to `limit`; then it scrolls (twice over, so that the end leads
 * back into the beginning), its edges fading out softly rather than cut, or, with animations off in GNOME, is cut with
 * an ellipsis. Its font and colour are its own style's, which its labels inherit. */
export const Marquee = GObject.registerClass(class Marquee extends St.Widget {
    _init(props = {}) {
        super._init({clip_to_allocation: true, ...props});
        this._first = this._newLabel();
        this._second = this._newLabel();
        this._second.visible = false;
        this.add_child(this._first);
        this.add_child(this._second);
        /** The widest it grows, in stage pixels; 0 for no limit. */
        this._limit = 0;
        this._plain = '';
        this._markup = '';
        /** Whether it scrolls, and the width of the whole text, as laid out. */
        this._scrolls = false;
        this._natural = 0;
        /** The soft edges while it scrolls, and the size they were last set for. */
        this._edges = null;
        this._size = [0, 0];
        /** Counts the starts and stops of the scrolling, so that one that was stopped does not go on. */
        this._pass = 0;
        this._idle = 0;
        // Only on screen: nobody reads it, nor should it keep drawing, off it.
        this.connect('notify::mapped', () => this._sync());
        this.connect('destroy', () => {
            this._pass++;
            if (this._idle)
                GLib.source_remove(this._idle);
            this._idle = 0;
        });
    }

    _newLabel() {
        const label = new St.Label({y_align: Clutter.ActorAlign.START});
        label.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        return label;
    }

    /** What it says: a title and, after it, quieter, the artist. */
    setText(title, artist = '') {
        const plain = artist ? `${title}\u001f${artist}` : title;
        if (plain === this._plain)
            return;
        this._plain = plain;
        this._markup = markupFor(title, artist);
        for (const label of [this._first, this._second])
            label.clutter_text.set_markup(this._markup);
    }

    /** What it says, as set (the title and artist, joined). */
    get text() {
        return this._plain;
    }

    /** The widest it grows, in stage pixels, before it scrolls. */
    set limit(limit) {
        limit = Math.max(0, Math.round(limit));
        if (limit === this._limit)
            return;
        this._limit = limit;
        this.queue_relayout();
    }

    get limit() {
        return this._limit;
    }

    /** As wide as the text, or the limit. */
    vfunc_get_preferred_width(_forHeight) {
        const [, natural] = this._first.get_preferred_width(-1);
        const {width} = fit(natural, this._limit);
        return [width, width];
    }

    /** One line. */
    vfunc_get_preferred_height(_forWidth) {
        return this._first.get_preferred_height(-1);
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const [, natural] = this._first.get_preferred_width(-1);
        const [, line] = this._first.get_preferred_height(-1);
        const width = box.get_width();
        const whole = Math.ceil(natural);
        // With animations off in GNOME it is cut short instead, never moving.
        const scrolls = whole > width + 0.5 && St.Settings.get().enable_animations;
        const y = Math.max(0, Math.round((box.get_height() - line) / 2));
        // Scrolling, the text starts a fade's width in: at rest its first letter is clear of the soft left edge, and
        // moving it passes through it.
        const inset = scrolls ? this._fadeWidth(width) : 0;
        allocateAt(this._first, inset, y, scrolls ? whole : Math.min(whole, width), line);
        if (scrolls && this._second.visible)
            allocateAt(this._second, inset + whole + Math.round(GAP * uiScale()), y, whole, line);
        this._size = [width, box.get_height()];
        this._softenEdges();
        if (scrolls !== this._scrolls || whole !== this._natural) {
            this._scrolls = scrolls;
            this._natural = whole;
            // Not while being laid out: showing the repeat and starting the scroll lay it out again.
            this._later();
        }
    }

    /** The width of each soft edge, in stage pixels: never more than a third of the width. */
    _fadeWidth(width) {
        return Math.round(Math.min(EDGE_FADE * uiScale(), width / 3));
    }

    /** The edges' uniforms for the size it has (set again with each layout, as the size may change). */
    _softenEdges() {
        if (!this._edges)
            return;
        const fade = this._fadeWidth(this._size[0]);
        this._edges.setUniforms({size: this._size, fade: [fade, fade]});
    }

    _later() {
        if (this._idle)
            return;
        this._idle = GLib.idle_add(GLib.PRIORITY_DEFAULT, () => {
            this._idle = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Starts the scrolling, if it must scroll and is on screen; stops it otherwise. */
    _sync() {
        this._pass++;
        const labels = [this._first, this._second];
        for (const label of labels) {
            label.remove_all_transitions();
            label.translation_x = 0;
        }
        if (this._second.visible !== this._scrolls)
            this._second.visible = this._scrolls;
        // The soft edges only while it scrolls: text that fits has no cut to hide.
        if (this._scrolls && !this._edges) {
            this._edges = new EdgeFade();
            this.add_effect_with_name('isle-edge-fade', this._edges);
            this._softenEdges();
        } else if (!this._scrolls && this._edges) {
            this.remove_effect(this._edges);
            this._edges = null;
        }
        if (!this._scrolls || !this.mapped)
            return;
        const scale = uiScale();
        const distance = this._natural + Math.round(GAP * scale);
        const duration = Math.round(distance / (SPEED * scale) * 1000);
        const pass = this._pass;
        // One pass: both copies move by one text and its gap, which looks as the start did: put back unseen.
        const run = () => {
            if (pass !== this._pass)
                return;
            for (const label of labels)
                label.translation_x = 0;
            for (const label of labels) {
                label.ease({
                    translation_x: -distance,
                    delay: PAUSE_MS,
                    duration,
                    mode: Clutter.AnimationMode.LINEAR,
                    onComplete: label === this._first ? run : null,
                });
            }
        };
        run();
    }
});
