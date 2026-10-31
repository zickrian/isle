// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Short-lived alerts the island grows to show. An alert has a key (same key replaces), an icon, art, ring or bot, a
// title and subtitle, tone, a value or level, actions, duration and priority; `setAlert` reads the rest.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {BotIcon} from './botIcon.js';
import {VERTICAL, onUiScale, px} from './compat.js';
import * as Palette from './palette.js';
import * as Theme from './theme.js';
import {Art, LevelBar, Ring, VolumeGlyph, WrapLayout, cornerClose, icon, isSymbolic, ownIcon, pillButton, playMotion,
    revealClose, wrapLines} from './widgets.js';

/** The widest an alert gets; narrower, it fits its content. Sizes are in CSS pixels (see `px`). */
const MAX_WIDTH = 380;
/** Room round the badge, as much on every side (see .isle-peek-row); PEEK_RADIUS in controller.js is the
 * badge's radius plus this, so the corners follow it. */
const PADDING = 12;
/** Room round one lit along its edges (an agent's ask): its buttons clear of the light (see .isle-peek-row-glow). */
const GLOW_PADDING = 16;
/** Height of the part that hangs below the top bar: the badge and its room above and below. */
const HEIGHT = 32 + 2 * PADDING;
/** A two-line title's width: the widest alert less its padding, badge (32) and spacing (10). */
const TITLE_WRAP_WIDTH = MAX_WIDTH - 2 * PADDING - 42;
/** The widest an alert that asks (Allow, Deny…) gets; narrower, it fits what it says. The assistant is this big beside it. */
const DECISION_WIDTH = 440;
/** As wide as its buttons need, up to this (the open island is 600); past it, they go on to a line below. */
const ACTIONS_WIDTH = 560;
/** Between its buttons, and between their lines. */
const ACTIONS_SPACING = 8;
const BOT_SIZE = 46;
/** Its texts' widest: less its padding, the assistant and the spacing (12); see .isle-peek-row-asks. */
const DECISION_TEXT_WIDTH = DECISION_WIDTH - 2 * PADDING - BOT_SIZE - 12;
/** Its answer shows this long (ms), the assistant hopping or shaking, before the alert goes. */
const ANSWERED_MS = 850;
/** Buttons that answer (Allow, Run) take no press this soon after they show. */
const ARMED_AFTER_MS = 500;

/** The ring starts sweeping once the island has made room; a level bar grows a little sooner. */
const RING_DELAY = 350;
const LEVEL_DELAY = 200;
/** As wide as a digit in tabular figures: a counting "7%" keeps the width of "64%". */
const FIGURE_SPACE = '\u2007';

const TONE_COLORS = {
    neutral: Palette.WHITE,
    good: Palette.GREEN,
    focus: Palette.GREEN,
    bad: Palette.RED,
    // The plans' colours on the Usage page (see pages/usage.js).
    claude: [0.85, 0.47, 0.34],
    codex: [0.06, 0.64, 0.5],
    grok: [0.93, 0.94, 0.96],
    agy: [0.3, 0.55, 1],
    warn: Palette.ORANGE,
    break: Palette.BLUE,
    calendar: Palette.BLUE,
};

/** An [r, g, b] colour, each 0 to 1, as CSS rgba(). */
const css = ([r, g, b], alpha = 1) =>
    `rgba(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)}, ${alpha})`;

/** The badge behind an icon, lit from the top in the alert's colour; grey when neutral. */
function badgeStyle(rgb, neutral) {
    const [top, bottom] = neutral ? [0.16, 0.08] : [0.34, 0.16];
    const base = neutral ? [1, 1, 1] : rgb;
    return `background-gradient-direction: vertical; background-gradient-start: ${css(base, top)}; ` +
        `background-gradient-end: ${css(base, bottom)};`;
}

/** Styles `actor` and everything in it now: St styles only what is on screen, and a button not yet shown
 * measures in the default font, wider than it will be. */
function styleNow(actor) {
    if (actor instanceof St.Widget)
        actor.ensure_style();
    for (const child of actor.get_children())
        styleNow(child);
}

/** An alert's content inside the island: badge, texts, and the buttons that answer. */
export const PeekView = GObject.registerClass({
    // The × on its icon (see `showClose`).
    Signals: {'close-requested': {}},
}, class PeekView extends St.Widget {
    /** Builds every piece once; each alert only picks which are shown. */
    _init() {
        super._init({style_class: 'isle-peek', layout_manager: new Clutter.BinLayout()});

        // The content sits in one row, centred; the island fits its width.
        this._row = new St.BoxLayout({
            style_class: 'isle-peek-row',
            x_expand: true,
            // Filling the island, which is an even width: a spare pixel goes to the texts, so the badge and
            // the value or button stay as far from the edges, not half a pixel off.
            x_align: Clutter.ActorAlign.FILL,
            y_expand: true,
        });
        this.add_child(this._row);

        // Leading: one of these sits in the badge bin.
        this._badge = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({icon_size: 16});
        // Cover art, with the playing app's icon on its corner.
        this._art = new Art({size: 32, radius: 8});
        this._art.connect('shown', () => this._syncArtBadge());
        this._artBadgeIcon = new St.Icon({icon_size: 12});
        this._artBadge = new St.Bin({
            style_class: 'isle-app-badge',
            child: this._artBadgeIcon,
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.END,
            y_align: Clutter.ActorAlign.END,
        });
        onUiScale(this._artBadge, scale => this._artBadge.set_translation(4 * scale, 4 * scale, 0));
        // Not widened by the badge's expand flags; see `_art()` in pages/media.js.
        this._artBox = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: false, y_expand: false});
        this._artBox.add_child(this._art);
        this._artBox.add_child(this._artBadge);
        // A level as a ring around a lit badge, like the other alerts' badges.
        this._ringIcon = new St.Icon({icon_size: 12});
        this._ringBadge = new St.Bin({style_class: 'isle-peek-ring-badge', child: this._ringIcon});
        this._ring = new Ring({size: 32, lineWidth: 3, child: this._ringBadge});
        this._volume = new VolumeGlyph();
        // The assistant, for what it or an AI agent asks or has done.
        this._bot = new BotIcon(BOT_SIZE);
        // The badge, with a × on its corner under the pointer; a fixed-size box, so the × moves nothing.
        this._close = cornerClose(() => this.emit('close-requested'));
        this._lead = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._lead.add_child(this._badge);
        this._lead.add_child(this._close);
        this._row.add_child(this._lead);

        const texts = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        this._texts = texts;
        this._title = new St.Label({style_class: 'isle-peek-title'});
        this._subtitle = new St.Label({style_class: 'isle-peek-subtitle'});
        for (const text of [this._title, this._subtitle]) {
            text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            texts.add_child(text);
        }
        // Set up to wrap without hyphens; it wraps only for an alert that asks (see `setAlert`).
        wrapLines(this._title, Pango.EllipsizeMode.END);
        this._title.clutter_text.line_wrap = false;
        this._titleLines = 1;
        this._lineHeight = 0;
        // A notification's words may wrap to a second line too (see `setAlert`).
        wrapLines(this._subtitle, Pango.EllipsizeMode.END);
        this._subtitle.clutter_text.line_wrap = false;
        this._subtitleLines = 1;
        this._subtitleLineHeight = 0;
        // What an agent wants to run, and the answers to give it.
        this._code = new St.Label({style_class: 'isle-peek-code', x_align: Clutter.ActorAlign.START});
        // Whole, over as many lines as it takes: what is allowed is all there to read.
        this._code.clutter_text.set({line_wrap: true, line_wrap_mode: Pango.WrapMode.WORD_CHAR,
            ellipsize: Pango.EllipsizeMode.NONE});
        texts.add_child(this._code);
        // Its buttons small, each as wide as its label, from where the texts start; whole, a line below if need be.
        const wrap = new WrapLayout();
        this._actions = new St.Widget({style_class: 'isle-peek-actions', layout_manager: wrap, x_expand: true});
        onUiScale(this._actions, scale => (wrap.spacing = ACTIONS_SPACING * scale));
        texts.add_child(this._actions);
        this._answered = new St.BoxLayout({style_class: 'isle-peek-answered', visible: false});
        this._answeredIcon = new St.Icon({icon_size: 12, y_align: Clutter.ActorAlign.CENTER});
        this._answeredText = new St.Label({style_class: 'isle-peek-answered-text', y_align: Clutter.ActorAlign.CENTER});
        this._answered.add_child(this._answeredIcon);
        this._answered.add_child(this._answeredText);
        texts.add_child(this._answered);
        this._answerTimer = 0;
        this._row.add_child(texts);

        // Trailing: a value, a level bar or a button.
        this._accessory = new St.Bin({y_align: Clutter.ActorAlign.CENTER});
        this._value = new St.Label({style_class: 'isle-peek-value', y_align: Clutter.ActorAlign.CENTER});
        this._status = new St.Label({style_class: 'isle-peek-status', y_align: Clutter.ActorAlign.CENTER});
        this._level = new LevelBar({width: 72});
        this._levelText = new St.Label({style_class: 'isle-peek-level-text', y_align: Clutter.ActorAlign.CENTER});
        this._levelBox = new St.BoxLayout({style_class: 'isle-peek-level-box'});
        this._levelBox.add_child(this._level);
        this._levelBox.add_child(this._levelText);
        this._row.add_child(this._accessory);

        this._actionButton = null;
        this._forget();
        /** A value counting up with the ring's sweep: {final, digits, target}. */
        this._count = null;
        this._ring.connect('notify::progress', () => this._syncCount());
        // Put away, the next alert here is a new one and animates in, its × hidden.
        this.connect('notify::mapped', () => {
            if (!this.mapped) {
                this._forget();
                this.showClose(false);
            }
        });
        this.connect('destroy', () => this._onDestroy());
    }

    /** The app's icon on the cover's corner, unless the cover already is that icon. */
    _syncArtBadge() {
        this._artBadge.visible = Boolean(this._artBadgeIcon.gicon) && !this._art.showsIcon;
    }

    /** What the alert shown last was, so one updating in place doesn't animate in again. */
    _forget() {
        this._ringKey = this._levelKey = this._volumeKey = this._motionKey = this._underKey = null;
    }

    /** Fills the view from an alert; `onDone` runs after its button did its job. `fresh`: shown anew under the
     * last one's key (a second "Charging"); `under`: its one button goes under the words, as two or three do. */
    setAlert(alert, onDone = null, {fresh = false, under = false} = {}) {
        if (fresh)
            this._forget();
        // Its button stays under its words while it updates in place, the same button under the pointer.
        under = Boolean(alert.action) && (under || alert.key === this._underKey);
        const rgb = Theme.semantic(TONE_COLORS[alert.tone] ?? TONE_COLORS.neutral);
        const color = css(rgb);
        const gicon = alert.gicon ? ownIcon(alert.gicon) : icon(alert.icon ?? 'dialog-information-symbolic');
        const hasRing = alert.ring !== undefined && alert.ring !== null;

        const action = under ? null : alert.action;
        // Moved under, it keeps its colour (a Join stays blue).
        const actions = alert.actions ?? (under ? [{...alert.action, accent: alert.action.primary}] : []);
        this._asks = actions.length > 0;
        this._shown = alert;
        // One that asks reads from the left, like a dialog, the assistant level with its title.
        const decision = this._asks || Boolean(alert.code);
        this._lit = Boolean(alert.glow);
        this._row.style_class = decision ? `isle-peek-row isle-peek-row-asks${this._lit ? ' isle-peek-row-glow' : ''}` : 'isle-peek-row';
        this._lead.y_align = this._texts.y_align = decision ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        // One that asks is answered with its own buttons; the volume and the like pass by themselves.
        // From what it is, not where its button went: one moved under its words keeps its ×.
        this._closable = alert.closable ?? (!(alert.actions?.length || alert.code) && !alert.transient);
        if (!this._closable)
            this.showClose(false);
        if (alert.bot) {
            this._bot.look = alert.bot.look;
            this._bot.form = alert.bot.form ?? 'attentive';
            this._bot.badge = alert.bot.glyph ? {color: rgb, glyph: alert.bot.glyph} : null;
            this._setChild(this._badge, this._bot);
            this._badge.style_class = '';
        } else if (alert.art !== undefined) {
            this._artBadgeIcon.gicon = alert.badge ?? null;
            this._art.setPath(alert.art);
            this._syncArtBadge();
            this._setChild(this._badge, this._artBox);
            this._badge.style_class = '';
        } else if (hasRing) {
            this._ring.color = rgb;
            this._ringIcon.gicon = gicon;
            this._ringIcon.icon_size = alert.ringIconSize ?? 12;
            this._ringIcon.style = `color: ${color};`;
            this._ringBadge.style = badgeStyle(rgb, (alert.tone ?? 'neutral') === 'neutral');
            this._setChild(this._badge, this._ring);
            this._badge.style_class = '';
            // Sweep only when the alert is new, not when it updates in place.
            const ringKey = `${alert.key}:${alert.title}`;
            if (ringKey !== this._ringKey)
                this._ring.fillTo(alert.ring, {delay: RING_DELAY});
            else
                this._ring.jumpTo(alert.ring);
            this._ringKey = ringKey;
        } else if (alert.volume) {
            // A new volume alert brings its waves in; changes while shown add or take away one.
            this._volume.setLevel(alert.volume.level, alert.volume.muted, {fresh: alert.key !== this._volumeKey});
            this._volume.style = `color: ${color};`;
            this._setChild(this._badge, this._volume);
            this._badge.style_class = 'isle-peek-icon';
        } else {
            // An app's own colour icon stands alone; a symbolic one gets a badge.
            const appIcon = alert.appIcon && !isSymbolic(gicon);
            this._icon.gicon = gicon;
            this._icon.icon_size = appIcon ? 28 : 16;
            this._icon.style = appIcon ? null : `color: ${color};`;
            this._setChild(this._badge, this._icon);
            this._badge.style_class = appIcon ? '' : 'isle-peek-icon';
        }
        this._badge.style = this._badge.style_class
            ? badgeStyle(rgb, (alert.tone ?? 'neutral') === 'neutral')
            : null;
        if (!hasRing)
            this._ringKey = null;
        this._volumeKey = alert.volume ? alert.key : null;
        // Its icon's motion plays once, for a new alert (not one updating in place), once the island made room.
        const moving = hasRing ? this._ringIcon : alert.art === undefined && !alert.volume && !alert.bot ? this._icon : null;
        const motionKey = `${alert.key}:${alert.title}`;
        if (moving && motionKey !== this._motionKey)
            playMotion(moving, alert.motion, {delay: RING_DELAY});
        this._motionKey = motionKey;

        // The texts' widest: less where it is lit, with more room round it.
        const textWidth = decision ? DECISION_TEXT_WIDTH - (this._lit ? 2 * (GLOW_PADDING - PADDING) : 0) : TITLE_WRAP_WIDTH;
        // A few lines at most for a title that may run long (an answer, a reminder); the island widens and
        // grows by the line. Cut here: with wrapping, Pango's own … would keep the first line alone.
        let title = alert.title ?? '';
        this._titleLines = 1;
        if (alert.titleLines > 1)
            [title, this._titleLines, this._lineHeight] = this._fitLines(title, alert.titleLines, px(textWidth));
        const wrap = this._titleLines > 1;
        this._title.clutter_text.line_wrap = wrap;
        this._title.clutter_text.ellipsize = wrap ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
        // Its height set: the column would measure a wrapped title as one line and sit off centre.
        this._title.height = wrap ? Math.ceil(this._titleLines * this._lineHeight) : -1;
        this._title.text = title;
        // Cut short: what says how to read it all.
        let subtitle = (title !== (alert.title ?? '') && alert.cutSubtitle) || alert.subtitle || '';
        // A notification's words may take a second line before they are cut.
        this._subtitleLines = 1;
        if (alert.subtitleLines > 1 && subtitle) {
            [subtitle, this._subtitleLines, this._subtitleLineHeight] = this._fitLines(subtitle, alert.subtitleLines,
                px(textWidth), this._subtitle);
        }
        const wrapSubtitle = this._subtitleLines > 1;
        this._subtitle.clutter_text.line_wrap = wrapSubtitle;
        this._subtitle.clutter_text.ellipsize = wrapSubtitle ? Pango.EllipsizeMode.NONE : Pango.EllipsizeMode.END;
        this._subtitle.height = wrapSubtitle ? Math.ceil(this._subtitleLines * this._subtitleLineHeight) : -1;
        this._subtitle.text = subtitle;
        this._subtitle.visible = Boolean(subtitle);

        this._code.text = alert.code ?? '';
        this._code.visible = Boolean(alert.code);
        this._showActions(actions, onDone, alert.key, fresh);

        // The same alert updating in place with the same button keeps it, under the pointer (see `_showActions`).
        const actionLabel = action ? `${action.primary ? '*' : ''}${action.label}` : null;
        const keepButton = Boolean(this._actionButton) && !fresh && alert.key === this._actionKey && actionLabel === this._actionLabel;
        if (!keepButton) {
            this._actionButton?.destroy();
            this._actionButton = null;
        }
        this._shownAction = action;
        this._actionDone = onDone;
        this._actionKey = alert.key;
        this._actionLabel = actionLabel;
        this._count = null;
        if (alert.level === undefined || alert.level === null || action)
            this._levelKey = null;
        if (action) {
            // The one thing to do now (Join) in the accent colour, as a default button.
            if (!keepButton) {
                this._actionButton = pillButton(action.label, action.primary ? 'isle-pill-small isle-pill-accent' : 'isle-pill-small', () => {
                    this._shownAction.callback();
                    this._actionDone?.();
                });
            }
            this._setChild(this._accessory, this._actionButton);
        } else if (alert.level !== undefined && alert.level !== null) {
            if (alert.key !== this._levelKey)
                this._level.growTo(alert.level, {delay: LEVEL_DELAY});
            else
                this._level.level = alert.level;
            this._levelKey = alert.key;
            this._level.fillColor = color;
            this._levelText.text = alert.levelText ?? '';
            this._levelText.visible = Boolean(alert.levelText);
            this._setChild(this._accessory, this._levelBox);
        } else if (alert.value) {
            const counted = hasRing && alert.ring > 0 && /^(\d+)%$/.exec(alert.value);
            this._count = counted ? {final: Number(counted[1]), digits: counted[1].length, target: alert.ring, shown: -1} : null;
            this._value.text = alert.value;
            this._value.opacity = 255;
            this._syncCount();
            this._setChild(this._accessory, this._value);
        } else if (alert.status) {
            this._status.text = alert.status;
            this._status.style = `color: ${color}; background-color: ${css(alert.tone === 'neutral' || !alert.tone ? [1, 1, 1] : rgb, 0.14)};`;
            this._setChild(this._accessory, this._status);
        } else {
            this._setChild(this._accessory, null);
        }
        // Fitted once the island measures it, on the stage and styled (see `_fit`).
        this._unfitted = alert.action || alert.actions?.length ? {alert, onDone, under} : null;
    }

    /** Its button, placed once it can be measured: one beside words that would be cut goes under them. */
    _fit() {
        if (!this._unfitted || !this.get_stage())
            return;
        const {alert, onDone, under} = this._unfitted;
        this._unfitted = null;
        styleNow(this._row);
        if (!under && this._shownAction && this._row.get_preferred_width(-1)[1] > px(MAX_WIDTH)) {
            this._underKey = alert.key;
            this.setAlert(alert, onDone, {under: true});
            this._unfitted = null;
            styleNow(this._row);
        }
    }

    // The answers an alert offers, each {label, primary, answer: allow | deny, callback}; an allow or deny shows a moment.
    // The same alert updating in place (`key`) with the same buttons keeps them, armed and under the pointer.
    _showActions(actions, onDone, key = null, fresh = true) {
        const labels = actions.map(action => `${action.primary ? '*' : ''}${action.label}`).join('\n');
        const kept = !fresh && key !== null && key === this._actionsKey && labels === this._actionLabels && !this._answerTimer &&
            this._actions.visible;
        this._shownActions = actions;
        this._actionsDone = onDone;
        this._actionsKey = key;
        this._actionLabels = labels;
        if (kept)
            return;
        this._clearAnswer();
        this._actions.destroy_all_children();
        this._actions.visible = actions.length > 0;
        this._answered.visible = false;
        this._actionsShownAt = GLib.get_monotonic_time();
        actions.forEach((action, i) => {
            const style = action.accent ? 'isle-pill-small isle-peek-action isle-pill-accent'
                : action.primary ? `isle-pill-small isle-peek-action isle-pill-white${action.answer ? ' isle-pill-decision' : ''}`
                    : 'isle-pill-small isle-peek-action';
            this._actions.add_child(pillButton(action.label, style, () => this._answer(this._shownActions[i], this._actionsDone)));
        });
    }

    /** How wide the alert would be for its buttons on one line: theirs, and the room round its texts. */
    _actionsWidth() {
        if (!this._actions.visible)
            return 0;
        const [, buttons] = this._actions.get_preferred_width(-1);
        const [, lead] = this._lead.get_preferred_width(-1);
        const row = this._row.get_theme_node();
        return buttons + row.get_padding(St.Side.LEFT) + row.get_padding(St.Side.RIGHT) + row.get_length('spacing') + lead;
    }

    /** Runs a button's callback, then shows the answer a moment; a press too soon after the buttons appeared is ignored. */
    _answer(action, onDone) {
        // A click meant for what was there a moment ago never presses what just appeared ("Accept").
        const fresh = GLib.get_monotonic_time() - (this._actionsShownAt ?? 0) < ARMED_AFTER_MS * 1000;
        if (this._answerTimer || fresh)
            return;
        // Answered: putting it away after says nothing more (see `onDismissed`).
        if (this._shown)
            this._shown.answered = true;
        action.callback();
        if (!action.answer) {
            onDone?.();
            return;
        }
        const allowed = action.answer === 'allow';
        this._bot.badge = {color: Theme.semantic(allowed ? Palette.GREEN : Palette.RED), glyph: allowed ? 'check' : 'cross'};
        this._bot.form = allowed ? 'success' : 'attentive';
        this._bot.play(allowed ? 'hop' : 'shake');
        this._answeredIcon.gicon = icon(allowed ? 'isle-check-symbolic' : 'isle-close-symbolic');
        this._answeredText.text = action.done ?? (allowed ? 'Allowed' : 'Denied');
        this._answered.style_class = `isle-peek-answered ${allowed ? 'isle-peek-allowed' : 'isle-peek-denied'}`;
        this._actions.visible = false;
        this._answered.visible = true;
        if (!allowed)
            playMotion(this._texts, 'shake');
        this._answerTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ANSWERED_MS, () => {
            this._answerTimer = 0;
            onDone?.();
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Stops a shown answer's timer. */
    _clearAnswer() {
        if (this._answerTimer)
            GLib.source_remove(this._answerTimer);
        this._answerTimer = 0;
    }

    /** Shows the × on the icon, under the pointer, unless the alert has no use for one. */
    showClose(shown) {
        revealClose(this._close, shown && this._closable);
    }

    /** A ring's percentage counts up as it sweeps. */
    _syncCount() {
        if (!this._count)
            return;
        const {final, digits, target} = this._count;
        const shown = Math.min(final, Math.round(final * this._ring.progress / target));
        // Set each frame of the sweep, but changed only now and then (and not at all in its slow end).
        if (shown === this._count.shown)
            return;
        this._count.shown = shown;
        this._value.text = `${String(shown).padStart(digits, FIGURE_SPACE)}%`;
        // Before the sweep starts, "0%" would read as an empty battery: the number waits, its room kept.
        this._value.opacity = shown > 0 ? 255 : 0;
    }

    /** The height below the top bar this alert needs: less with a title alone. */
    get preferredHeight() {
        this._fit();
        // One that asks: as tall as its lines, code and buttons, with even room above and below.
        if (this._asks || this._code.visible) {
            // Its texts as wide as the island leaves them: a narrower one wraps its code sooner.
            const [, row] = this._row.get_preferred_width(-1);
            const [, texts] = this._texts.get_preferred_width(-1);
            const [, natural] = this._texts.get_preferred_height(this.preferredWidth - (row - texts));
            const [, lead] = this._lead.get_preferred_height(-1);
            return Math.round(Math.max(lead, natural) + px(2 * (this._lit ? GLOW_PADDING : PADDING)));
        }
        return px(HEIGHT) + Math.round((this._titleLines - 1) * this._lineHeight +
            (this._subtitleLines - 1) * this._subtitleLineHeight);
    }

    /** `text` cut to whole words that fit in `max` lines `width` (stage px) wide, with … if cut (by letters when one word is
     * too long: a link): [text, lines, line height]. */
    _fitLines(text, max, width, label = this._title) {
        const layout = Pango.Layout.new(label.get_pango_context());
        layout.set_font_description(label.get_theme_node().get_font());
        layout.set_attributes(label.clutter_text.get_attributes());
        layout.set_width(width * Pango.SCALE);
        layout.set_wrap(Pango.WrapMode.WORD_CHAR);
        // Whether `candidate` takes no more than `max` lines.
        const fits = candidate => {
            layout.set_text(candidate, -1);
            return layout.get_line_count() <= max;
        };
        // No more than the lines could hold of the narrowest letters is measured: a long answer costs no more.
        const room = Math.ceil(max * width / px(2.5));
        const letters = [...text];
        let fitted = letters.length > room ? letters.slice(0, room).join('') : text;
        if (!fits(fitted) || fitted !== text) {
            // Pango broke the lines already: up to where the line after the last starts (in bytes), then room
            // for the …. Found with an iterator: GNOME 46's GJS throws on reading a PangoLayoutLine.
            let end = null;
            if (layout.get_line_count() > max) {
                const lines = layout.get_iter();
                for (let i = 0; i < max; i++)
                    lines.next_line();
                end = lines.get_index();
            }
            let words = fitted;
            if (end !== null)
                words = new TextDecoder().decode(new TextEncoder().encode(fitted).subarray(0, end));
            words = words.trimEnd().split(' ');
            // Cut through by `room` (not at a line's end): its last word is only part of one.
            if (end === null && words.length > 1)
                words.pop();
            for (;;) {
                fitted = `${words.join(' ').replace(/[\s,.;:]+$/, '')}…`;
                if (fits(fitted) || fitted.length <= 1)
                    break;
                if (words.length > 1)
                    words.pop();
                else
                    words = [[...words[0]].slice(0, -1).join('')];
            }
        }
        layout.set_text(fitted, -1);
        const count = layout.get_line_count();
        const [, logical] = layout.get_pixel_extents();
        return [fitted, Math.min(max, count), logical.height / count];
    }

    /** The width the island should have for this alert. */
    get preferredWidth() {
        this._fit();
        const [, natural] = this._row.get_preferred_width(-1);
        if (this._asks || this._code.visible) {
            // Its words up to the usual width; its buttons, whole, a little wider if they need it.
            const widest = Math.max(px(DECISION_WIDTH), Math.min(px(ACTIONS_WIDTH), this._actionsWidth()));
            if (this._titleLines > 1 || this._subtitleLines > 1)
                return Math.round(widest);
            return Math.round(Math.min(widest, natural));
        }
        if (this._titleLines > 1 || this._subtitleLines > 1)
            return px(MAX_WIDTH);
        return Math.round(Math.min(px(MAX_WIDTH), natural));
    }

    /** Puts `child` in `bin`; no child hides the bin. */
    _setChild(bin, child) {
        if (bin.child !== child)
            bin.child = child;
        // An empty slot takes no room (nor the row's spacing), so the rest stays centred.
        bin.visible = child !== null;
    }

    /** Frees the pieces no alert is showing right now. */
    _onDestroy() {
        this._clearAnswer();
        // Pieces not currently shown are not children and must be freed here.
        for (const actor of [this._icon, this._artBox, this._ring, this._volume, this._bot, this._value, this._status, this._levelBox]) {
            if (!actor.get_parent())
                actor.destroy();
        }
    }
});
