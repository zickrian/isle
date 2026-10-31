// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// A small copy of the assistant (see bot.js) for alerts and the closed island, with a status badge on its
// corner. It holds still, moving only for a moment when told to (a hop, a shake), so it costs no frames.

import Cairo from 'cairo';
import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {Bot} from './bot.js';
import {onUiScale, px} from './compat.js';
import * as Theme from './theme.js';

/** How long (ms) a gesture plays; the icon is still again after it. */
const GESTURE_MS = 750;
/** It settles into its pose over this much (s) of its own time, drawn once. */
const SETTLE_S = 0.7;
/** While at work it blinks and glances this often (ms): alive, at a few frames every few seconds. */
const ALIVE_MS = 2600;

/** The bot drawn small, with an optional status badge. */
export const BotIcon = GObject.registerClass(
class BotIcon extends St.DrawingArea {
    /** `size` in CSS pixels; with `body` (CSS pixels) its body is that big, against the box's end. */
    _init(size, look = {}, {body = 0} = {}) {
        super._init();
        this._size = size;
        this._body = body;
        onUiScale(this, scale => this.set_size(this._size * scale, this._size * scale));
        this._bot = new Bot(look);
        this._bot.holdEyes();
        this._badge = null;
        this._settle();
        this._timeline = null;
        this.connect('repaint', area => this._paint(area));
        this._alive = 0;
        this._glance = {x: 0.12, y: 0.06};
        this.connect('destroy', () => {
            this._timeline?.stop();
            this.alive = false;
        });
    }

    /** {shape, palette} from Settings (see bot.js). */
    set look({shape, palette}) {
        this._bot.palette = palette;
        this._bot.setShape(shape);
        this._settle();
        this.queue_repaint();
    }

    /** attentive by default; also success, error, asking… (see Bot.setForm). */
    set form(form) {
        this._bot.setForm(form);
        this._settle();
        this.queue_repaint();
    }

    /** The corner badge: {color: [r, g, b], glyph: '!' | 'check' | 'cross'}, or null. */
    set badge(badge) {
        this._badge = badge;
        this.queue_repaint();
    }

    /** While true, it blinks and looks about every few seconds, holding still in between. */
    set alive(alive) {
        if (Boolean(this._alive) === alive)
            return;
        if (this._alive)
            GLib.source_remove(this._alive);
        this._alive = alive && St.Settings.get().enable_animations
            ? GLib.timeout_add(GLib.PRIORITY_DEFAULT, ALIVE_MS, () => {
                if (this.mapped) {
                    this._glance = {x: Math.random() * 1.2 - 0.6, y: Math.random() * 0.6 - 0.2};
                    this.play(null, 420);
                }
                return GLib.SOURCE_CONTINUE;
            })
            : 0;
    }

    /** Plays a hop, nod or shake once (or just a blink and a glance), then holds still again. */
    play(gesture, duration = GESTURE_MS) {
        if (!St.Settings.get().enable_animations)
            return;
        this._timeline?.stop();
        const from = this._bot.time;
        if (gesture)
            this._bot.gesture(gesture);
        else
            this._bot.blink();
        this._timeline = new Clutter.Timeline({actor: this, duration});
        this._timeline.connect('new-frame', (timeline, ms) => {
            this._bot.step(from + ms / 1000, this._look());
            this.queue_repaint();
        });
        this._timeline.connect('completed', () => {
            this._timeline = null;
        });
        this._timeline.start();
    }

    /** Where its eyes turn: a random glance, picked while it is alive. */
    _look() {
        return this._glance;
    }

    // Runs its own clock on, without drawing, until the new shape and expression have taken over.
    _settle() {
        const from = this._bot.time;
        for (let t = 1 / 30; t <= SETTLE_S; t += 1 / 30)
            this._bot.step(from + t, this._look());
    }

    /** Another size (and body size), in CSS pixels. */
    resize(size, body = this._body) {
        this._size = size;
        this._body = body;
        this.set_size(px(size), px(size));
    }

    /** Draws the bot, then the badge on top. */
    _paint(area) {
        const cr = area.get_context();
        const size = px(this._size);
        if (this._body) {
            // Its body's box scaled to `body`, against the end and centred, on whole pixels so its edges stay
            // sharp; a shape that is not round sits level too.
            const {x, y, width, height} = this._bot.bounds(size);
            const scale = px(this._body) / Math.max(width, height);
            cr.translate(size - width * scale, Math.round((size - height * scale) / 2));
            cr.scale(scale, scale);
            cr.translate(-x, -y);
        }
        this._bot.paint(cr, size);
        if (this._badge)
            this._paintBadge(cr, px(1));
        cr.$dispose();
    }

    // A small disc on the top left corner in the badge's colour, ringed in the island's colour so it stands off the body.
    _paintBadge(cr, scale) {
        const r = Math.max(4, this._size * 0.17) * scale;
        const x = r + 0.5 * scale, y = r + 0.5 * scale;
        cr.arc(x, y, r + 1.5 * scale, 0, 2 * Math.PI);
        // On glass the ring is cut out of the bot, so the glass itself shows through it.
        if (Theme.translucent())
            cr.setOperator(Cairo.Operator.CLEAR);
        cr.setSourceRGBA(...Theme.solid(), 1);
        cr.fill();
        cr.setOperator(Cairo.Operator.OVER);
        cr.arc(x, y, r, 0, 2 * Math.PI);
        cr.setSourceRGBA(...this._badge.color, 1);
        cr.fill();
        cr.setSourceRGBA(1, 1, 1, 1);
        cr.setLineWidth(Math.max(1.4 * scale, r * 0.32));
        cr.setLineCap(Cairo.LineCap.ROUND);
        const s = r * 0.42;
        switch (this._badge.glyph) {
        case '!':
            cr.moveTo(x, y - s * 1.1);
            cr.lineTo(x, y + s * 0.25);
            cr.stroke();
            cr.arc(x, y + s * 1.05, cr.getLineWidth() * 0.55, 0, 2 * Math.PI);
            cr.fill();
            break;
        case 'check':
            cr.moveTo(x - s, y + s * 0.05);
            cr.lineTo(x - s * 0.25, y + s * 0.8);
            cr.lineTo(x + s * 1.05, y - s * 0.7);
            cr.stroke();
            break;
        case 'cross':
            cr.moveTo(x - s * 0.8, y - s * 0.8);
            cr.lineTo(x + s * 0.8, y + s * 0.8);
            cr.moveTo(x + s * 0.8, y - s * 0.8);
            cr.lineTo(x - s * 0.8, y + s * 0.8);
            cr.stroke();
            break;
        }
    }
});
