// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Synced lyrics: the sung line large and bright, the rest dimmer,
// pauses as breathing dots. Click a line to jump there.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, iconSize} from '../compat.js';
import * as Playback from '../playback.js';
import {icon, label, wrapFixedLines} from '../widgets.js';

/** Where the current line sits in the view, from the top. */
const ANCHOR = 0.36;
/** After scrolling by hand, wait this long before following again. */
const MANUAL_SCROLL_HOLD_MS = 4000;
/** Line opacity: the current one, those to come by distance, those sung. */
const CURRENT_OPACITY = 255;
const COMING_OPACITY = [150, 115, 90];
const SUNG_OPACITY = 75;
/** Lines other than the current one are drawn this much smaller. */
const RESTING_SCALE = 0.93;
const LINE_EASE_MS = 380;
const SCROLL_EASE_MS = 520;
/** A song whose first line comes this late opens with the pause dots. */
const INTRO_MS = 3000;

/** What the view says when there are no lines to show. */
const STATES = {
    loading: {dots: true, title: 'Looking for lyrics'},
    not_found: {icon: 'isle-lyrics', title: 'No lyrics for this song', hint: 'Lyrics come from LRCLIB'},
    instrumental: {icon: 'isle-music', title: 'Instrumental', hint: 'Nothing to sing along to'},
    off: {icon: 'isle-lyrics', title: 'Lyrics are off', hint: 'Turn them on in Isle’s settings'},
    error: {icon: 'isle-lyrics', title: 'Can’t reach the lyrics', hint: 'Check your connection · trying again soon'},
    unavailable: {icon: 'isle-lyrics', title: 'Lyrics are busy right now', hint: 'Trying again in a moment'},
};

/** Three dots that breathe while the singing pauses. */
const PauseDots = GObject.registerClass(
class PauseDots extends St.BoxLayout {
    /** Three still dots; they breathe once `breathing` is set and they are on screen. */
    _init(styleClass = 'isle-lyric-dots') {
        super._init({style_class: styleClass});
        this._dots = [0, 1, 2].map(() => {
            const dot = new St.Widget({style_class: 'isle-lyric-dot', y_align: Clutter.ActorAlign.CENTER});
            dot.set_pivot_point(0.5, 0.5);
            this.add_child(dot);
            return dot;
        });
        this._breathing = false;
        // Only animates on screen; see `breathing`.
        this.connect('notify::mapped', () => this._sync());
    }

    /** True while this pause is the one sung and the music plays. */
    set breathing(breathing) {
        if (breathing === this._breathing)
            return;
        this._breathing = breathing;
        this._sync();
    }

    /** Starts or stops the loop; never runs hidden or with animations off. */
    _sync() {
        const on = this._breathing && this.mapped && St.Settings.get().enable_animations;
        this._dots.forEach((dot, i) => {
            dot.remove_all_transitions();
            dot.set_scale(1, 1);
            dot.opacity = on ? 110 : 255;
            if (!on)
                return;
            dot.ease({
                scale_x: 1.35,
                scale_y: 1.35,
                opacity: 255,
                delay: i * 180,
                duration: 600,
                mode: Clutter.AnimationMode.EASE_IN_OUT_SINE,
                autoReverse: true,
                repeatCount: -1,
            });
        });
    }
});

/** The lyrics page's view: the lines, or a state message when there are none. */
export const LyricsPane = GObject.registerClass(
class LyricsPane extends St.Widget {
    /** Scroll view for the lines with a centred state message over it. */
    _init(page) {
        super._init({
            style_class: 'isle-lyrics',
            layout_manager: new Clutter.BinLayout(),
            x_expand: true,
            y_expand: true,
        });
        this._page = page;
        this._key = null;
        this._lines = [];
        this._rows = [];
        /** Each row's last opacity and scale eased to: Clutter would ease again to the same. */
        this._opacities = [];
        this._scales = [];
        this._current = -2;
        this._manualUntil = 0;
        // Hidden (island closed, or the player shown), it has no layout to scroll; it catches up when shown.
        this.connect('notify::mapped', () => {
            if (this.mapped && this._synced)
                this.follow({shown: true});
            else if (this.mapped)
                this._scrollTo(this._current);
        });

        this._column = new St.BoxLayout({...VERTICAL, style_class: 'isle-lyrics-column', x_expand: true});
        this._scroll = new St.ScrollView({
            style_class: 'isle-lyrics-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the words.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._column);
        // The lines laid out anew (say, a new width): back to the one sung.
        this._scroll.vadjustment.connect('notify::upper', () => {
            if (this._synced && Date.now() > this._manualUntil)
                this._page.later('lyric-relayout', 0, () => this._scrollTo(this._current));
        });
        // Scrolling by hand holds the lines still for a while.
        this._scroll.connect('scroll-event', () => {
            this._manualUntil = Date.now() + MANUAL_SCROLL_HOLD_MS;
            this._scroll.vadjustment.remove_transition('value');
            return Clutter.EVENT_PROPAGATE;
        });
        this.add_child(this._scroll);

        this._state = new St.BoxLayout({
            ...VERTICAL,
            style_class: 'isle-lyrics-state',
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._stateIcon = new St.Icon({icon_size: iconSize(22), style_class: 'isle-lyrics-state-icon', x_align: Clutter.ActorAlign.CENTER});
        this._stateDots = new PauseDots('isle-lyric-dots isle-lyrics-state-dots');
        this._stateDots.x_align = Clutter.ActorAlign.CENTER;
        this._stateTitle = label('', 'isle-lyrics-state-title', {x_align: Clutter.ActorAlign.CENTER});
        this._stateHint = label('', 'isle-lyrics-state-hint', {x_align: Clutter.ActorAlign.CENTER});
        for (const part of [this._stateIcon, this._stateDots, this._stateTitle, this._stateHint])
            this._state.add_child(part);
        this.add_child(this._state);
    }

    /** Catches up with isled's lyrics: rebuilt only for a new track or status. */
    update() {
        const {lyrics} = this._page.daemon.state;
        const status = lyrics?.status ?? 'none';
        const showLines = status === 'synced' || status === 'plain';
        this._scroll.visible = showLines;
        this._showState(showLines ? null : STATES[status] ?? null);

        // The same track goes from "loading" to "synced", so both matter.
        const key = `${lyrics?.track}\u001f${status}`;
        if (key !== this._key) {
            this._key = key;
            this._rebuild(showLines ? lyrics : null);
        }
        this.follow();
        this.syncPlaying();
    }

    /** Shows one of STATES, or hides the message for null. */
    _showState(state) {
        this._state.visible = Boolean(state);
        this._stateDots.breathing = Boolean(state?.dots);
        if (!state)
            return;
        this._stateIcon.visible = Boolean(state.icon);
        if (state.icon)
            this._stateIcon.gicon = icon(state.icon);
        this._stateDots.visible = Boolean(state.dots);
        this._stateTitle.text = state.title;
        this._stateHint.text = state.hint ?? '';
        this._stateHint.visible = Boolean(state.hint);
    }

    /** Makes a row per line, all resting until `follow` picks the sung one. */
    _rebuild(lyrics) {
        this._column.destroy_all_children();
        this._synced = lyrics?.status === 'synced';
        this._lines = [...lyrics?.lines ?? []];
        // A long intro opens with the pause dots.
        if (this._synced && this._lines.length && this._lines[0].time_ms > INTRO_MS)
            this._lines.unshift({time_ms: 0, text: ''});
        this._current = -2;
        this._scroll.vadjustment.value = 0;
        this._rows = this._lines.map(line => this._row(line));
        this._opacities = this._rows.map(() => COMING_OPACITY.at(-1));
        this._scales = this._rows.map(() => RESTING_SCALE);
        for (const row of this._rows)
            this._column.add_child(row);
        // Room after the last line, so it too can reach the reading line.
        // (Padding would not do: St takes it off the scrolled view.)
        if (this._rows.length)
            this._column.add_child(new St.Widget({style_class: 'isle-lyrics-end'}));
        // Built out of sight (the player shown), they are laid out ahead of their showing (see `Page.markCold`).
        if (!this.mapped)
            this._page.markCold({force: true});
    }

    /** A line's words, or pause dots for an empty synced line; synced rows seek on click. */
    _row(line) {
        const words = line.text.trim();
        let row;
        if (this._synced && !words) {
            row = new PauseDots();
        } else {
            row = new St.Label({
                text: words || '♪',
                style_class: this._synced ? 'isle-lyric-line' : 'isle-lyric-line plain',
            });
            wrapFixedLines(row);
        }
        if (this._synced) {
            row.reactive = true;
            row.set_pivot_point(0, 0.5);
            row.set_scale(RESTING_SCALE, RESTING_SCALE);
            row.opacity = COMING_OPACITY.at(-1);
            row.connect('button-release-event', () => {
                this._manualUntil = 0;
                this._page.daemon.call('media', 'SetPosition', line.time_ms * 1000);
                return Clutter.EVENT_STOP;
            });
        }
        return row;
    }

    /** Highlights the line being sung and glides it into place; `shown` (just on screen) puts it there at once. */
    follow({shown = false} = {}) {
        if (!this._synced || !this._lines.length)
            return;
        // Out of sight (the player shown, or closed) nothing is eased or timed: opening eased each line changed
        // meanwhile, before its first frame. They are set as they show.
        if (!this.mapped) {
            this._page.cancel('lyric');
            return;
        }
        const {nowPlaying} = this._page.daemon.state;
        const index = Playback.lineIndexAt(this._lines, Playback.positionMs(nowPlaying));
        if (index !== this._current || shown) {
            this._current = index;
            this._rows.forEach((row, i) => {
                const current = i === index;
                const opacity = current ? CURRENT_OPACITY
                    : i < index ? SUNG_OPACITY
                        : COMING_OPACITY[Math.min(i - index - 1, COMING_OPACITY.length - 1)];
                const scale = current ? 1 : RESTING_SCALE;
                // Only the lines around the sung one change; the rest keep where they are.
                if (opacity !== this._opacities[i] || scale !== this._scales[i]) {
                    this._opacities[i] = opacity;
                    this._scales[i] = scale;
                    // As ease() would off screen: there at once.
                    if (shown) {
                        row.remove_all_transitions();
                        row.opacity = opacity;
                        row.set_scale(scale, scale);
                    } else {
                        row.ease({
                            opacity,
                            scale_x: scale,
                            scale_y: scale,
                            duration: LINE_EASE_MS,
                            mode: Clutter.AnimationMode.EASE_OUT_CUBIC,
                        });
                    }
                }
                if (row instanceof PauseDots)
                    row.breathing = current && Playback.isPlaying(nowPlaying);
            });
            if (shown || Date.now() > this._manualUntil)
                this._scrollTo(index);
        }
        const wait = Playback.isPlaying(nowPlaying) ? Playback.msUntilLine(nowPlaying, this._lines, index) : null;
        if (wait === null || !this._page.active)
            this._page.cancel('lyric');
        else
            this._page.later('lyric', wait + 30, () => this.follow());
    }

    /** Pauses or resumes the dots with the music. */
    syncPlaying() {
        const playing = Playback.isPlaying(this._page.daemon.state.nowPlaying);
        this._rows.forEach((row, i) => {
            if (row instanceof PauseDots)
                row.breathing = i === this._current && playing;
        });
    }

    /** Glides the view so line `index` sits at ANCHOR. */
    _scrollTo(index) {
        const target = this._rows[Math.max(index, 0)];
        if (!target || !this.mapped)
            return;
        // Allocation may lag a frame behind a rebuild; wait for it.
        if (!target.has_allocation() || !this._scroll.has_allocation()) {
            this._page.later('lyric-layout', 16, () => this._scrollTo(index));
            return;
        }
        const adjustment = this._scroll.vadjustment;
        const middle = target.get_allocation_box().y1 + target.height / 2;
        const value = Math.max(adjustment.lower,
            Math.min(adjustment.upper - adjustment.page_size, middle - adjustment.page_size * ANCHOR));
        adjustment.remove_transition('value');
        adjustment.ease(value, {duration: SCROLL_EASE_MS, mode: Clutter.AnimationMode.EASE_OUT_CUBIC});
    }
});
