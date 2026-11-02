// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Usage: how much of each AI plan's limits is used (Claude, ChatGPT as Codex saw it, Grok, Antigravity), a bar
// per limit. One provider at a time, scrolled through like a widget stack; no tab without any.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import * as Format from '../format.js';
import * as Palette from '../palette.js';
import {icon, label, slideBy} from '../widgets.js';
import {Page} from './page.js';

/** A limit warns (an alert) and then turns red at these shares; Settings may move them (see `setMarks`). */
const MARKS = {warn: 80, critical: 95};
/** Each provider's colour, for its bars. */
const ACCENTS = {claude: [0.85, 0.47, 0.34], codex: [0.06, 0.64, 0.5], grok: [0.93, 0.94, 0.96],
    agy: [0.3, 0.55, 1], 'agy-claude-gpt': [0.3, 0.55, 1], 'agy-argon': [0.3, 0.55, 1]};
const FALLBACK = Palette.BLUE;
/** How far a scroll goes before it moves to the next provider. */
const WHEEL_STEP = 1;
const SWIPE_STEP = 1.5;
const GESTURE_GAP_MS = 180;
/** How long the move between providers, and the bars filling, take. */
const SLIDE_MS = 220;
const FILL_MS = 500;

/** RGB 0..1 as a CSS colour. */
const css = ([r, g, b], alpha = 1) => `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;

/** Each provider's logo (icons/), shown by its name. */
const LOGOS = {claude: 'isle-claude', codex: 'isle-openai', grok: 'isle-grok',
    agy: 'isle-agy', 'agy-claude-gpt': 'isle-agy', 'agy-argon': 'isle-agy'};

/** The provider's logo, or a dot of its colour for one without. */
function mark(id) {
    if (LOGOS[id])
        return new St.Icon({gicon: icon(LOGOS[id]), icon_size: 18, style_class: 'isle-usage-logo', y_align: Clutter.ActorAlign.CENTER});
    const dot = new St.Widget({style_class: 'isle-usage-mark', y_align: Clutter.ActorAlign.CENTER});
    dot.style = `background-color: ${css(ACCENTS[id] ?? FALLBACK)};`;
    return dot;
}

// A limit's bar: the fill is `share` (0..1) of the width, times `sweep` as it grows in.
const Bar = GObject.registerClass({
    Properties: {
        'sweep': GObject.ParamSpec.double('sweep', null, null, GObject.ParamFlags.READWRITE, 0, 1, 1),
    },
}, class Bar extends St.Widget {
    /** `level` is 'normal', 'warn' or 'critical'. */
    _init(share, level, accent) {
        super._init({style_class: 'isle-usage-track', x_expand: true});
        this._share = share;
        this._sweep = 1;
        this._fill = new St.Widget({style_class: `isle-usage-fill ${level}`});
        // In the plan's colour until nearly used up, then red.
        if (level !== 'critical')
            this._fill.style = `background-color: ${css(accent)};`;
        this.add_child(this._fill);
    }

    /** 0..1, eased by `_fill`. */
    get sweep() {
        return this._sweep;
    }

    /** Lays the fill out again on every step. */
    set sweep(value) {
        this._sweep = value;
        this.notify('sweep');
        this.queue_relayout();
    }

    /** Fill width from share and sweep, never less than a round sliver. */
    vfunc_allocate(box) {
        this.set_allocation(box);
        const [width, height] = box.get_size();
        // A sliver shows even at 1%.
        const filled = this._share > 0 ? Math.max(height, width * this._share * this._sweep) : 0;
        const fill = new Clutter.ActorBox();
        fill.set_origin(0, 0);
        fill.set_size(Math.round(filled), height);
        this._fill.allocate(fill);
    }
});

// The Usage page, a card per provider.
export const UsagePage = GObject.registerClass(
class UsagePage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-usage',
            layout_manager: new Clutter.BinLayout(),
            height,
            reactive: true,
        });
        this.name = 'usage';
        this._marks = {...MARKS};
        /** The provider shown, by id, so a refresh keeps it. */
        this._shown = null;
        this._bars = [];
        this._gesture = {dy: 0, at: 0, moved: false};

        const row = new St.BoxLayout({x_expand: true, y_expand: true});
        this._card = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true, clip_to_allocation: true});
        row.add_child(this._card);
        // A dot per provider on the right, the shown one lit; only with more than one.
        this._dots = new St.BoxLayout({...VERTICAL, style_class: 'isle-usage-dots', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(this._dots);
        this.add_child(row);

        this.connect('scroll-event', (_actor, event) => this._onScroll(event));
        this.watch(['usage'], () => this._update());
        this._update();
    }

    /** As isled last read them. */
    _providers() {
        return this.daemon.state.usage?.providers ?? [];
    }

    /** Only with a provider found (Claude Code or Codex signed in) and usage turned on. */
    get available() {
        return this._providers().length > 0;
    }

    /** The shares at which a bar warns, from Settings. */
    setMarks(warn, critical) {
        this._marks = {warn, critical};
        this._update();
    }

    /** Asks for fresh numbers and grows the bars in. */
    onActivate() {
        // Fresh numbers when looked at; isled asks Claude at most every two minutes.
        this.daemon.call('usage', 'Refresh');
        this._update();
        this._fill();
    }

    /** Where the shown provider sits now; the first if it is gone. */
    _index() {
        const index = this._providers().findIndex(provider => provider.id === this._shown);
        return Math.max(0, index);
    }

    /** Isle's 12/24-hour setting changed: "Updated 20:40" as it says now, while on show. */
    clockChanged() {
        if (this.active)
            this._update();
    }

    /** Rebuilds the card if its content changed, else just its times. */
    _update() {
        const available = this.available;
        if (available !== this._wasAvailable) {
            this._wasAvailable = available;
            this.emit('availability-changed');
        }
        const providers = this._providers();
        const index = this._index();
        this._shown = providers[index]?.id ?? null;
        // Built anew only when what it shows changed; else its times move on in place.
        const key = JSON.stringify([providers.map(({updated_ms: _at, ...rest}) => rest), this._marks, index]);
        if (key !== this._key) {
            this._key = key;
            this._card.destroy_all_children();
            this._bars = [];
            this._resetLabels = [];
            if (providers[index])
                this._card.add_child(this._content(providers[index]));
            this._updateDots(providers.length, index);
        } else if (providers[index]) {
            this._retime(providers[index]);
        }
        // Fresh numbers arriving as the bars grow in: the new bars carry on growing, never jump to full.
        const filled = this._filled();
        if (filled < 1)
            this._fill(filled);
        // "resets in 12m" counts down while it is on screen.
        if (this.active)
            this.later('minute', 60000, () => this._update());
    }

    /** Each dot jumps to its provider. */
    _updateDots(count, index) {
        this._dots.destroy_all_children();
        this._dots.visible = count > 1;
        if (count < 2)
            return;
        for (let i = 0; i < count; i++) {
            // Three Antigravity cards share a name: the plan says which one the dot goes to.
            const provider = this._providers()[i];
            const name = provider.plan ? `${provider.name} ${provider.plan}` : provider.name;
            const dot = new St.Button({style_class: `isle-usage-dot${i === index ? ' shown' : ''}`, can_focus: true,
                accessible_name: name});
            dot.connect('clicked', () => this._show(i));
            this._dots.add_child(dot);
        }
    }

    /** Moves to provider `index`, sliding in from the side it comes from. */
    _show(index) {
        const providers = this._providers();
        const from = this._index();
        if (index === from || !providers[index])
            return;
        this._shown = providers[index].id;
        this._update();
        const content = this._card.get_first_child();
        if (!content)
            return;
        const direction = index > from ? 1 : -1;
        content.opacity = 0;
        slideBy(content, 'y', direction * px(24), 0, {duration: SLIDE_MS});
        content.ease({opacity: 255, duration: SLIDE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        this._fill();
    }

    // Up and down move between providers, one a swipe or a wheel click.
    _onScroll(event) {
        const count = this._providers().length;
        if (count < 2)
            return Clutter.EVENT_PROPAGATE;
        // Compatibility copies must not count as another scroll.
        if (event.get_flags() & Clutter.EventFlags.FLAG_POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        const now = GLib.get_monotonic_time() / 1000;
        const gesture = this._gesture;
        if (now - gesture.at > GESTURE_GAP_MS)
            Object.assign(gesture, {dy: 0, moved: false});
        gesture.at = now;
        let step = 0;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            step = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
            step = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const [dx, dy] = event.get_scroll_delta();
            gesture.dy += dy;
            const wheel = event.get_scroll_source() === Clutter.ScrollSource.WHEEL;
            if (!gesture.moved && Math.abs(gesture.dy) >= (wheel ? WHEEL_STEP : SWIPE_STEP)) {
                step = Math.sign(gesture.dy);
                // A wheel counts afresh; a swipe moves once, however far it goes.
                if (wheel)
                    gesture.dy = 0;
                else
                    gesture.moved = true;
            }
            if (event.get_scroll_finish_flags() !== Clutter.ScrollFinishFlags.NONE || (dx === 0 && dy === 0))
                gesture.at = 0;
            break;
        }
        default:
            // Sideways moves nothing here.
            return Clutter.EVENT_PROPAGATE;
        }
        if (step)
            this._show(Math.max(0, Math.min(count - 1, this._index() + step)));
        return Clutter.EVENT_STOP;
    }

    /** The bars grow in from `from` (0..1 of the way) over what is left of the fill. */
    _fill(from = 0) {
        this._fillStart = GLib.get_monotonic_time() - from * FILL_MS * 1000;
        for (const bar of this._bars) {
            bar.sweep = from;
            bar.ease_property('sweep', 1, {duration: FILL_MS * (1 - from), mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
        }
    }

    /** How far the fill in progress has come (0..1), or 1 with none. */
    _filled() {
        const elapsed = (GLib.get_monotonic_time() - (this._fillStart ?? 0)) / 1000;
        return Math.min(1, elapsed / FILL_MS);
    }

    /** Brings "Updated 14:32" and "resets in 12m" up to date. */
    _retime(provider) {
        const fromCodex = provider.note?.startsWith('As of');
        if (!provider.note || fromCodex)
            this._stamp.text = updated(provider.updated_ms, fromCodex);
        this._resetLabels.forEach(([reset, ms]) => (reset.text = resets(ms)));
    }

    /** One provider's card: logo, name, plan and freshness, then up to three limits. */
    _content(provider) {
        const accent = ACCENTS[provider.id] ?? FALLBACK;
        const content = new St.BoxLayout({...VERTICAL, style_class: 'isle-usage-content', x_expand: true, y_align: Clutter.ActorAlign.CENTER});

        // The provider, its plan, and how fresh the numbers are (or what is wrong).
        const head = new St.BoxLayout({style_class: 'isle-usage-head'});
        head.add_child(mark(provider.id));
        head.add_child(label(provider.name, 'isle-usage-name'));
        if (provider.plan)
            head.add_child(label(provider.plan, 'isle-usage-plan'));
        const fromCodex = provider.note?.startsWith('As of');
        const warning = provider.note && !fromCodex;
        const stamp = label(warning ? provider.note : updated(provider.updated_ms, fromCodex),
            `isle-usage-stamp${warning ? ' warning' : ''}`, {x_expand: true, x_align: Clutter.ActorAlign.END});
        stamp.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._stamp = stamp;
        head.add_child(stamp);
        content.add_child(head);

        const limits = new St.BoxLayout({...VERTICAL, style_class: 'isle-usage-limits'});
        for (const window of provider.windows.slice(0, 3))
            limits.add_child(this._limit(window, accent));
        if (provider.windows.length === 0)
            limits.add_child(label(provider.empty || 'No limits reported yet', 'isle-usage-empty'));
        content.add_child(limits);
        return content;
    }

    // A limit: its name, then when it resets and its share; the bar below.
    _limit({label: name, percent, resets_at_ms: resetsAt}, accent) {
        const used = Math.max(0, Math.min(100, percent));
        // Its colour from the number shown: "80%" is never left white for a 79.6.
        const shown = Math.round(used);
        const level = shown >= this._marks.critical ? 'critical' : shown >= this._marks.warn ? 'warn' : 'normal';
        const limit = new St.BoxLayout({...VERTICAL, style_class: 'isle-usage-limit'});
        const line = new St.BoxLayout({style_class: 'isle-usage-line'});
        const title = label(name, 'isle-usage-window', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        line.add_child(title);
        if (resetsAt > 0) {
            const reset = label(resets(resetsAt), 'isle-usage-reset');
            this._resetLabels.push([reset, resetsAt]);
            line.add_child(reset);
        }
        line.add_child(label(`${shown}%`, `isle-usage-percent ${level}`));
        limit.add_child(line);

        const bar = new Bar(used / 100, level, accent);
        this._bars.push(bar);
        limit.add_child(bar);
        return limit;
    }
});

/** "resets in 1h 20m", "resets in 2d 5h", "resets in 12m". */
function resets(ms) {
    const minutes = Math.max(0, Math.round((ms - Date.now()) / 60000));
    if (minutes < 1)
        return 'resets soon';
    const days = Math.floor(minutes / 1440);
    const hours = Math.floor((minutes % 1440) / 60);
    if (days > 0)
        return hours ? `resets in ${days}d ${hours}h` : `resets in ${days}d`;
    if (hours > 0)
        return minutes % 60 ? `resets in ${hours}h ${minutes % 60}m` : `resets in ${hours}h`;
    return `resets in ${minutes}m`;
}

/** "Updated 14:32", or "From Codex, 14:32" for numbers as of Codex's last use; on another day, with its name. */
function updated(ms, fromCodex) {
    if (!ms)
        return '';
    const at = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const today = GLib.DateTime.new_now_local().format('%F') === at.format('%F');
    const when = today ? Format.timeOfDay(at) : `${at.format('%a')} ${Format.timeOfDay(at)}`;
    return fromCodex ? `From Codex, ${when}` : `Updated ${when}`;
}
