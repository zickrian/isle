// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The voice assistant's view: a little character with lively eyes that listens, thinks and answers,
// beside what was heard and the answer. isled listens and asks the AI; the actions it answers with run here.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import GObject from 'gi://GObject';
import Meta from 'gi://Meta';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {TILES, describeActions, failed, namesProject, outcomeOf, runnable, slotsFor, stoppable, terminalLine} from './actionRules.js';
import {Bot} from './bot.js';
import {ChatView, CommandCard, answerMarkup, elapsed} from './chat.js';
import {isTerminal} from './clipboard.js';
import {answerPlain} from './format.js';
import {VERTICAL, eventActor, maximize, onUiScale, px, uiScale, unmaximize} from './compat.js';
import {plainBody} from './notifications.js';
import {cornerClose, icon, iconButton, pillButton, revealClose, wrapLines} from './widgets.js';


/** Sizes in CSS pixels (see `px`). */
const FACE_SIZE = 36;
/** Steps that read oddly once over, as they are kept in the list of steps done. */
const DONE_AS = {'Asking to run it…': 'Asked to run it'};
/** The pill while listening, and the panel an answer and the conversation open into: as wide as the open island. */
const LISTENING_WIDTH = 280;
const ANSWER_WIDTH = 600;
/** The round button at the row's end: type instead, stop or send (see stylesheet.css). */
const ACTION_SIZE = 32;
/** Row padding, the face, the action and the gaps between them (see stylesheet.css). */
const TEXT_INSET = 16 + 16 + FACE_SIZE + 2 * 12 + ACTION_SIZE;
/** The row's padding above and below the texts; below leaves room for the glow. */
const ROW_PADDING = 14 + 20;
/** Always room for the whole face. */
const MIN_HEIGHT = FACE_SIZE + ROW_PADDING;
const MAX_HEIGHT = 230;
/** The conversation, open above the pill, grows the island to at most this (px below the top bar). */
const CHAT_MAX_HEIGHT = 420;
/** What an open conversation keeps beside a tall command card: its header and a message. */
const CHAT_MIN_HEIGHT = 100;
/** The tallest the row grows for a command card, so its buttons show below a long command. */
const CARD_TALLEST = 600;
/** The pill grows to this with a command card in it. */
const CARD_MAX_HEIGHT = 320;
/** What comes into the pill fades in as its shape grows to it, rather than show cut off by the edge (ms). */
const FADE_IN_MS = 220;
const FADE_IN_DELAY_MS = 40;
/** With no new step for this long (s), a quiet "Still working · 0:12" shows it hasn't stalled. */
const STILL_WORKING_S = 8;
/** What to try, under an empty field: the chip, the words it puts in, and whether it asks at once. */
const IDEAS = [
    ['Today’s plan', 'What’s on my calendar today?', true],
    ['Install an app…', 'Install ', false],
    ['Find a file…', 'Find ', false],
];
/** "New chat · Undo" stays this long (ms); the old chat is deleted only after it. */
export const UNDO_MS = 5000;
/** Answers past this many characters are cut, the panel being small. */
const MAX_REPLY = 360;
/** Answers longer than this read as a paragraph: set smaller and lighter. */
const LONG_REPLY = 90;
/** Selected text past this many characters is cut before it goes to the AI. */
const MAX_SELECTION = 4000;
const SELECTION_TIMEOUT_MS = 500;
/** How many notifications the AI may read, newest first, and how much of each body. */
const MAX_NOTIFICATIONS = 10;
const MAX_NOTIFICATION_BODY = 300;

// Read from /proc once.
let user = null;
/** Who GNOME Shell runs as, to check a command started as root writes its log as them (see `runnable`). */
function shellUser() {
    if (!user) {
        const status = new TextDecoder().decode(GLib.file_get_contents('/proc/self/status')[1]);
        const id = key => status.match(new RegExp(`^${key}:\\s+(\\d+)`, 'm'))?.[1];
        user = {home: GLib.get_home_dir(), cache: GLib.get_user_cache_dir(), uid: id('Uid'), gid: id('Gid')};
    }
    return user;
}

/** An app just opened gets this long (ms) to show its window before the next step goes on without it. */
const WINDOW_WAIT_MS = 5000;
/** An app asked to quit gets this long (ms) to close its windows; one asking to save stays open. */
const CLOSE_WAIT_MS = 3000;
/** A player just opened gets this long (ms) to appear before a media command is dropped. */
const PLAYER_WAIT_MS = 12000;
/** Spotify's name on the session bus, for its MPRIS player. */
const SPOTIFY_BUS = 'org.mpris.MediaPlayer2.spotify';

/** How fast (per second) the glow follows the voice up and down, how fast a silent mic fades,
 * and how fast it moves to each phase's level. */
const MIC_ATTACK = 14;
const MIC_RELEASE = 4;
const MIC_FADE = 2;
const LEVEL_RATE = 8;
/** The glow's level when animations are off in GNOME: there, but still. */
const STILL_LEVEL = 0.2;
/** How much brighter the light is a moment as an answer arrives (see `_boost`). */
const REPLY_BOOST = 0.7;
/** Without the pointer moving for this long (s), the eyes wander on their own. */
const POINTER_REST_S = 2.5;
/** Errors that come from not hearing you (isled's wording): it looks confused at them, sad at others. */
const NOT_HEARD = /^(Didn[’']t catch that|The microphone is muted|No microphone)/;
/** How much each key typed lights the edge, as a syllable does. */
const KEY_LEVEL = 0.32;

/** Fades `actor` in from nothing, where it already is. */
function fadeIn(actor) {
    actor.remove_transition('opacity');
    actor.opacity = 0;
    actor.ease({opacity: 255, duration: FADE_IN_MS, delay: FADE_IN_DELAY_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
}

/** The character (see bot.js), on screen: it looks at the pointer, or reads along as you type. */
const Face = GObject.registerClass(
class Face extends St.DrawingArea {
    /** Sized to the UI scale; the bot paints itself on each repaint. */
    _init(look) {
        super._init();
        onUiScale(this, scale => this.set_size(FACE_SIZE * scale, FACE_SIZE * scale));
        this.bot = new Bot(look);
        this.level = 0;
        /** While typing: where on the stage to look (the caret), or null. */
        this.lookAt = null;
        this._pointer = [0, 0];
        this._pointerAt = -POINTER_REST_S;
        this._look = {x: 0, y: 0};
        this.connect('repaint', area => {
            const cr = area.get_context();
            this.bot.paint(cr, px(FACE_SIZE));
            cr.$dispose();
        });
    }

    /** The character's animation clock (s). */
    get time() {
        return this.bot.time;
    }

    /** Starts the clock over, as the view's animation does when it opens again. */
    restart() {
        this.bot.restart();
        this._pointerAt = -POINTER_REST_S;
    }

    /** A new shape and colours (see bot.js), changed in Settings. */
    setLook({shape, palette}) {
        this.bot.palette = palette;
        this.bot.setShape(shape);
        this.queue_repaint();
    }

    /** What the character is doing: listening, thinking, typing… (see bot.js). */
    setForm(form) {
        this.bot.setForm(form);
    }

    /** Moves the eyes on to `time` (s): at the caret, at the pointer, or about on their own. */
    step(time) {
        const [pointerX, pointerY] = global.get_pointer();
        if (pointerX !== this._pointer[0] || pointerY !== this._pointer[1]) {
            this._pointer[0] = pointerX;
            this._pointer[1] = pointerY;
            this._pointerAt = time;
        }
        const form = this.bot.form;
        const caret = form === 'typing' ? this.lookAt?.() : null;
        let look = null;
        if (caret)
            look = this._towards(caret[0], caret[1]);
        else if (!this.bot.looksOnItsOwn && time - this._pointerAt < POINTER_REST_S)
            look = this._towards(pointerX, pointerY);
        this.bot.step(time, look, this.level);
    }

    /** Looking towards the point `x`, `y` on screen. */
    _towards(x, y) {
        const [fx, fy] = this.get_transformed_position();
        const scale = uiScale();
        this._look.x = Math.max(-1, Math.min(1, (x - fx - FACE_SIZE * scale / 2) / (260 * scale)));
        this._look.y = Math.max(-1, Math.min(1, (y - fy - FACE_SIZE * scale / 2) / (180 * scale)));
        return this._look;
    }
});

/** The assistant's pill: the face, what was heard and answered, the field to type in, the conversation above. */
export const VoiceView = GObject.registerClass({
    Signals: {
        // Taps on the face: speak again, or finish speaking.
        'orb-clicked': {},
        // The Sign in button, shown when the AI is signed out.
        'sign-in': {},
        // The Set up button, shown when speech recognition (or its model) is missing.
        'set-up': {},
        // The stop button, while a request is being worked on.
        'stop': {},
        // The mic in the empty field, or a tap on the face while typing: say it instead.
        'speak': {},
        // The keyboard button: type the request instead of saying it.
        'type-requested': {},
        // A typed request, sent with Enter.
        'typed': {param_types: [GObject.TYPE_STRING]},
        // Each frame: the animation's time (s) and level, to move the island's edge glow with.
        'frame': {param_types: [GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE, GObject.TYPE_DOUBLE]},
        // The + in the conversation, and Undo after it.
        'new-chat': {},
        'undo-new-chat': {},
        // The command card's Run (true) or Deny (false), and its Stop while it runs.
        'card-decided': {param_types: [GObject.TYPE_BOOLEAN]},
        'card-stop': {},
        // Something inside changed its size (the conversation opened, say): the island fits it again.
        'size-changed': {},
        // The × on the face, over an answer: put it away.
        'close-requested': {},
    },
}, class VoiceView extends St.Widget {
    /** Builds the row (face, texts, action button) and the conversation that opens above it. */
    _init(look) {
        // Reactive, so a scroll over it can open the conversation (see `vfunc_scroll_event`).
        super._init({style_class: 'isle-voice', layout_manager: new Clutter.BinLayout(), reactive: true});
        this._phase = 'listening';
        /** Whether isled is not recording yet (see `micWaiting`). */
        this._micWaiting = false;
        /** Shown instead of "Listening…" while it listens for the first request. */
        this.greeting = null;
        /** While it listens for a follow-up, what it just asked, so you know what you answer. */
        this.followUp = null;
        /** The shortcut as set, for hints that name it ("Press Super+I…"). */
        this.shortcut = 'Super+I';
        this._mic = 0;
        this._micTarget = 0;
        this._level = 0;

        const row = new St.BoxLayout({style_class: 'isle-voice-row', x_expand: true, y_expand: true});
        this._face = new Face(look);
        this._faceButton = new St.Button({
            style_class: 'isle-voice-orb',
            child: this._face,
            accessible_name: 'Speak',
            y_align: Clutter.ActorAlign.CENTER,
        });
        this._faceButton.connect('clicked', () => this.emit(this.typing ? 'speak' : 'orb-clicked'));
        // Over an answer, under the pointer, a × on the face's corner puts it away, as an alert's does.
        this._pointerOn = false;
        this._close = cornerClose(() => this.emit('close-requested'), {out: 10});
        this._lead = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        this._lead.add_child(this._faceButton);
        this._lead.add_child(this._close);
        row.add_child(this._lead);

        this._texts = new St.BoxLayout({...VERTICAL, y_align: Clutter.ActorAlign.CENTER});
        // What was heard, or what it asked; with earlier messages, a chevron opens the conversation.
        this._heard = new St.Label({style_class: 'isle-voice-heard', y_align: Clutter.ActorAlign.CENTER});
        this._heard.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const heardRow = new St.BoxLayout({style_class: 'isle-voice-heard-row'});
        this._earlier = new St.Icon({gicon: icon('isle-chevron-up-symbolic'), icon_size: 10, style_class: 'isle-voice-earlier',
            y_align: Clutter.ActorAlign.CENTER, visible: false});
        heardRow.add_child(this._earlier);
        heardRow.add_child(this._heard);
        this._heardButton = new St.Button({child: heardRow, style_class: 'isle-voice-heard-button', reactive: false,
            x_align: Clutter.ActorAlign.START, accessible_name: 'Show the conversation'});
        this._heardButton.connect('clicked', () => this.openChat());
        // After +: the old conversation can come back for a moment.
        this._undo = new St.BoxLayout({style_class: 'isle-voice-undo', visible: false});
        this._undo.add_child(new St.Label({text: 'Started a new chat', style_class: 'isle-voice-undo-text', y_align: Clutter.ActorAlign.CENTER}));
        this._undo.add_child(pillButton('Undo', 'isle-pill-small isle-voice-undo-button', () => {
            this.showUndo(false);
            this.emit('undo-new-chat');
        }));
        // The command it wants to run, waiting for Run, then running.
        this._card = new CommandCard();
        this._card.visible = false;
        this._card.connect('decided', (_card, run) => {
            this._face.bot.gesture(run ? 'nod' : 'shake');
            // The edge flares as it starts, and dims a moment on a no.
            this._boost = run ? 1 : -1;
            this.emit('card-decided', run);
        });
        this._card.connect('stop', () => this.emit('card-stop'));
        this._still = new St.Label({style_class: 'isle-voice-still', visible: false});
        this._text = new St.Label({style_class: 'isle-voice-text'});
        this._hint = new St.Label({style_class: 'isle-voice-hint'});
        for (const label of [this._text, this._hint])
            wrapLines(label);
        // Not wider than its label, at the start of the line.
        this._signIn = pillButton('Sign in', 'isle-pill-small isle-voice-sign-in', () => this.emit('sign-in'));
        this._signIn.x_align = Clutter.ActorAlign.START;
        this._setUp = pillButton('Set up', 'isle-pill-small isle-voice-sign-in', () => this.emit('set-up'));
        this._setUp.x_align = Clutter.ActorAlign.START;
        /** The steps of the request being worked on, done ones first. */
        this._steps = [];
        // Those done, below the one now: a tick and a line each.
        this._stepsBox = new St.BoxLayout({...VERTICAL, style_class: 'isle-voice-steps', visible: false});
        // Ideas under an empty field, so what it can do is never a guess: one asks at once, one starts the words.
        this._ideas = new St.BoxLayout({style_class: 'isle-voice-ideas', visible: false});
        for (const [text, words, send] of IDEAS) {
            const chip = new St.Button({label: text, style_class: 'isle-voice-idea', can_focus: true});
            chip.connect('clicked', () => {
                this._entry.text = words;
                this._entry.clutter_text.set_cursor_position(-1);
                this._entry.grab_key_focus();
                if (send)
                    this._send();
            });
            this._ideas.add_child(chip);
        }
        // A typed request, instead of a spoken one (see `startTyping`).
        this._entry = new St.Entry({style_class: 'isle-voice-entry', hint_text: 'Ask anything…', can_focus: true,
            x_expand: true, visible: false});
        const caret = this._entry.clutter_text;
        caret.connect('activate', () => this._send());
        // Inside the field, as in Messages: a mic while it is empty (speak instead), Send once there are words.
        this._sendIcon = new St.Icon({gicon: icon('isle-mic-symbolic'), icon_size: 14});
        this._sendButton = new St.Bin({style_class: 'isle-voice-send', reactive: true, child: this._sendIcon});
        this._sendButton.set_pivot_point(0.5, 0.5);
        this._sendShows = null;
        this._entry.set_secondary_icon(this._sendButton);
        this._entry.connect('secondary-icon-clicked', () => {
            if (this._entry.text.trim())
                this._send();
            else
                this.emit('speak');
        });
        caret.connect('text-changed', () => {
            this._micTarget = KEY_LEVEL;
            this._syncSend();
            this._syncIdeas();
        });
        this._face.lookAt = () => {
            const position = caret.cursor_position < 0 ? caret.text.length : caret.cursor_position;
            // [ok, x, y, line height], or without ok in older GNOME.
            const [x, y, line] = caret.position_to_coords(position).slice(-3);
            const [cx, cy] = caret.get_transformed_position();
            return [cx + x, cy + y + line / 2].every(Number.isFinite) ? [cx + x, cy + y + line / 2] : null;
        };
        this._texts.add_child(this._undo);
        this._texts.add_child(this._heardButton);
        this._texts.add_child(this._entry);
        this._texts.add_child(this._ideas);
        this._texts.add_child(this._text);
        this._texts.add_child(this._stepsBox);
        this._texts.add_child(this._card);
        this._texts.add_child(this._still);
        this._texts.add_child(this._hint);
        this._texts.add_child(this._signIn);
        this._texts.add_child(this._setUp);
        row.add_child(this._texts);
        // One round button at the end, its size kept whichever shows, so the texts never shift.
        this._action = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        onUiScale(this._action, scale => this._action.set_size(ACTION_SIZE * scale, ACTION_SIZE * scale));
        this._typeButton = iconButton('isle-keyboard-symbolic', 'isle-voice-action', () => this.emit('type-requested'),
            {accessibleName: 'Type instead'});
        this._stop = iconButton('isle-stop-symbolic', 'isle-voice-action isle-voice-stop', () => this.emit('stop'),
            {size: 12, accessibleName: 'Stop'});
        for (const button of [this._typeButton, this._stop]) {
            button.set_pivot_point(0.5, 0.5);
            this._action.add_child(button);
        }
        this._shownAction = null;
        row.add_child(this._action);
        // The conversation above the pill's row, when open; the row stays as it is below it.
        this._chat = new ChatView();
        this._chat.visible = false;
        this._chat.connect('new-chat', () => this.emit('new-chat'));
        this._chat.connect('close', () => this.closeChat());
        // Selecting text to copy takes the keys for a moment; they come back to the field, so typing goes on.
        this._chat.connect('settled', () => {
            if (this.typing)
                this._entry.grab_key_focus();
        });
        this._history = [];
        this._column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
        this._column.add_child(this._chat);
        this._column.add_child(row);
        this.add_child(this._column);
        this._row = row;
        this._boost = 0;
        this._workingAt = 0;
        this._stepAt = 0;
        this._stillShown = '';

        this._timeline = new Clutter.Timeline({actor: this, duration: 1000, repeat_count: -1});
        this._timeline.connect('new-frame', () => this._tick());
        this._start = 0;
        this._lastTick = 0;
        this._flow = 0;
        this.connect('destroy', () => this._timeline.stop());
        /** The parts shown at the last `fit`, so ones new since fade in. */
        this._shownParts = new Set();
        this.setState({phase: 'listening'});
    }

    /** Shows `state` from isled: {phase, heard, reply, error, hint, sign_in, activity, actions}. */
    setState(state) {
        this.stopTyping();
        if (['listening', 'transcribing'].includes(state.phase))
            this._dropEndedCard(state.card);
        // Answered after working: the light brightens a moment, then settles.
        if (state.phase === 'reply' && WORKING.includes(this._phase))
            this._boost = Math.max(this._boost ?? 0, REPLY_BOOST);
        this._phase = state.phase;
        this._syncClose();
        this._exchange = {heard: state.heard ?? '', reply: clip(state.reply ?? '')};
        /** Whether the answer was cut: the chevron then opens it whole in the conversation. */
        this._replyCut = state.phase === 'reply' && this._exchange.reply !== (state.reply ?? '').trim();
        const heard = state.heard ? `“${state.heard}”` : '';
        const step = state.phase === 'acting' ? describeActions(state.actions) : state.activity || '';
        this._noteStep(state.phase, step);
        const [top, main, dim, markdown] = {
            // The first time it opens it greets you.
            listening: [this.followUp ?? '', this._listeningText(), this._micWaiting || !this.greeting],
            transcribing: [this.followUp ?? '', 'One moment…', true],
            // Its answer as it writes it; else an agent's step as it happens ("Searching ~/Downloads for
            // “ttd”…"), else thinking.
            thinking: [heard, clip(state.draft ?? '') || step || 'Thinking…', !state.draft, Boolean(state.draft)],
            acting: [heard, step, true],
            reply: [heard, clip(state.reply ?? ''), false, true],
            error: [heard, state.error || 'Something went wrong', false],
        }[state.phase] ?? ['', '', true];
        this._heard.text = top;
        this._heardButton.visible = Boolean(top) && !this.chatOpen;
        this._syncEarlier();
        // By the clock, not the animation's time: that starts over when the view opens again mid-request.
        if (WORKING.includes(state.phase) && !WORKING.includes(this._lastPhase ?? ''))
            this._workingAt = Date.now() / 1000;
        const newStep = step !== this._lastStep;
        if (newStep)
            this._stepAt = Date.now() / 1000;
        this._lastStep = step;
        this._lastPhase = state.phase;
        // An answer's light Markdown shows as in the conversation; anything else as written.
        if (markdown) {
            this._text.clutter_text.set_markup(answerMarkup(main));
        } else {
            this._text.clutter_text.use_markup = false;
            this._text.text = main;
        }
        if (dim)
            this._text.add_style_class_name('isle-voice-text-dim');
        else
            this._text.remove_style_class_name('isle-voice-text-dim');
        if (!dim && main.length > LONG_REPLY)
            this._text.add_style_class_name('isle-voice-text-long');
        else
            this._text.remove_style_class_name('isle-voice-text-long');
        const working = WORKING.includes(state.phase);
        const hint = state.phase === 'error' ? this.withShortcut(state.hint ?? '') : '';
        this._hint.text = hint;
        this._hint.visible = Boolean(hint);
        // While it works, the steps already done, dimmed below the current one.
        this._showSteps(working ? this._steps.slice(0, -1).slice(-MAX_DONE_STEPS) : []);
        this._syncCardText();
        this._signIn.visible = state.phase === 'error' && Boolean(state.sign_in);
        this._setUp.visible = state.phase === 'error' && Boolean(state.set_up);
        // Stop while it works; else typing instead (to follow up, too).
        this._showAction(working ? this._stop : this._typeButton);
        const searching = (state.phase === 'thinking' && Boolean(state.activity)) || state.phase === 'acting';
        const notHeard = state.phase === 'error' && NOT_HEARD.test(state.error ?? '');
        const form = searching ? 'searching' : notHeard ? 'confused' : {transcribing: 'thinking'}[state.phase] ?? state.phase;
        this._face.setForm(this._cardForm() ?? form);
        this._syncCard(state.card);
        // The answer takes the place of its steps, and each step of the last: the words fade in, not cut.
        const group = working ? 'working' : state.phase;
        if ((group !== this._lastGroup || (working && step && newStep)) && this._shownParts.has(this._text) &&
            this._text.visible && this.mapped && St.Settings.get().enable_animations)
            fadeIn(this._text);
        this._lastGroup = group;
    }

    // The command card as isled has it. Once over, it stays until the next request; in an open
    // conversation it is a line of the list instead (see ChatView).
    _syncCard(card) {
        const live = card && ['waiting', 'running'].includes(card.status);
        const asking = ['listening', 'transcribing'].includes(this._phase);
        // One that ended before this request is the last one's, which isled may still send (with an error).
        const stale = card && !live && card.id === this._staleCardId;
        if (card && !stale && (live || (!this.chatOpen && !asking)))
            this.showCard(card);
        else if (this._card.visible)
            this.showCard(null);
    }

    /** The form the command card asks for: looking at its buttons, watching it run, glad it worked. */
    _cardForm() {
        if (!this._card.visible)
            return null;
        // Glad it worked, but not over an error that came after.
        if (this._phase === 'error' && !['waiting', 'running'].includes(this._card.status))
            return null;
        return {waiting: 'asking', running: 'running', done: 'success', failed: 'error'}[this._card.status] ?? null;
    }

    // A card that waits or runs says it all: the line above it would only repeat it.
    _syncCardText() {
        const busy = this._card.visible && ['waiting', 'running'].includes(this._card.status);
        // In the conversation the answer is already in the list; the row says only what it does now.
        const inList = this.chatOpen && this._phase === 'reply';
        this._text.visible = !busy && !this.typing && !inList;
    }

    /** The command card once it has ended (done, failed, denied, stopped), else null. */
    get endedCard() {
        const card = this._card.visible ? this._cardData : null;
        return card && !['waiting', 'running'].includes(card.status) ? card : null;
    }

    // A new request: the card of the last one has had its say (it is in the conversation now). It, or
    // isled's card as the request starts (`card`), never shows again with this one.
    _dropEndedCard(card = null) {
        const old = card ?? this.endedCard;
        if (old)
            this._staleCardId = old.id;
        if (this.endedCard)
            this.showCard(null);
    }

    /** Whether the command card waits for Run or Deny (Enter and Esc answer it). */
    get cardWaiting() {
        return this._card.visible && this._card.status === 'waiting';
    }

    /** Run (true) or Deny (false), as the card's buttons do. */
    decideCard(run) {
        this._card.decide(run);
    }

    /** The command card: {command, why, detail, risks, status, output, seconds, exit}, or null for none. */
    showCard(card) {
        this._cardData = card;
        this._card.visible = Boolean(card);
        if (card) {
            this._card.setCard(card);
            // Ended, the row's button is back: Stop while the request still works on, else typing instead.
            const ended = WORKING.includes(this._phase) ? this._stop : this._typeButton;
            this._showAction(card.status === 'waiting' || card.status === 'running' ? null : ended);
        }
        const form = this._cardForm();
        if (form)
            this._face.setForm(form);
        this._syncCardText();
        this.emit('size-changed');
    }

    /** The conversation so far (see ChatView): shown when open, and behind the chevron by what was heard. */
    setHistory(items) {
        this._history = items;
        this._chat.setItems(items);
        this._syncIdeas();
        if (!items.length && this.chatOpen)
            this.closeChat();
        this._syncEarlier();
        if (this.chatOpen)
            this.emit('size-changed');
    }

    /** The chevron by what was heard, when the conversation holds more than the pill shows. */
    _syncEarlier() {
        // The chevron, for a conversation longer than what the pill shows, or an answer cut short.
        const earlier = (this._history.length > 2 || (this._replyCut && this._history.length > 0)) && !this.chatOpen;
        this._earlier.visible = earlier;
        this._heardButton.reactive = earlier;
    }

    /** Whether the conversation is open above the pill. */
    get chatOpen() {
        return this._chat.visible;
    }

    // Open, the conversation shows above and the row below becomes the field to write in (the face still
    // listens when tapped), so nothing shows twice.
    openChat() {
        if (this.chatOpen || !this._history.length)
            return;
        this._chat.visible = true;
        this._syncClose();
        this._heardButton.visible = false;
        this._syncEarlier();
        this._syncCardText();
        if (!WORKING.includes(this._phase) && !this.typing)
            this.emit('type-requested');
        if (St.Settings.get().enable_animations) {
            this._chat.opacity = 0;
            this._chat.ease({opacity: 255, duration: 260, delay: 80, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        }
        this.emit('size-changed');
    }

    /** Puts the conversation away; what was heard shows in the pill again. */
    closeChat() {
        if (!this.chatOpen)
            return;
        this._chat.visible = false;
        this._syncClose();
        this._heardButton.visible = Boolean(this._heard.text);
        this._syncCardText();
        this._syncEarlier();
        this.emit('size-changed');
    }

    /** "Started a new chat · Undo", for UNDO_MS after +. */
    showUndo(shown) {
        this._undo.visible = shown;
        if (shown) {
            // The old exchange went with its conversation.
            this._exchange = {heard: '', reply: ''};
            this._heard.text = '';
            this.closeChat();
        }
        this.emit('size-changed');
    }

    // Scrolling up over the pill brings the conversation; down, at its end, puts it away.
    vfunc_scroll_event(event) {
        const direction = event.get_scroll_direction();
        let dy = direction === Clutter.ScrollDirection.UP ? -1 : direction === Clutter.ScrollDirection.DOWN ? 1 : 0;
        if (direction === Clutter.ScrollDirection.SMOOTH)
            dy = event.get_scroll_delta()[1];
        if (dy < -0.3 && !this.chatOpen && this._history.length) {
            this.openChat();
            return Clutter.EVENT_STOP;
        }
        const actor = dy > 0.3 && this.chatOpen ? eventActor(event) : null;
        if (actor && this._row.contains(actor)) {
            this.closeChat();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Sends what was typed, unless it is blank. */
    _send() {
        const text = this._entry.text.trim();
        if (text)
            this.emit('typed', text);
    }

    // Dim until there is something to send.
    // The mic while the field is empty, Send once there are words; the new one pops in.
    _syncSend() {
        const shows = this._entry.text.trim() ? 'send' : 'mic';
        if (shows === this._sendShows)
            return;
        this._sendShows = shows;
        this._sendIcon.gicon = icon(shows === 'send' ? 'isle-send-symbolic' : 'isle-mic-symbolic');
        this._sendButton.style_class = shows === 'send' ? 'isle-voice-send' : 'isle-voice-send isle-voice-send-mic';
        this._sendButton.accessible_name = shows === 'send' ? 'Send' : 'Speak instead';
        if (!St.Settings.get().enable_animations || !this._sendButton.mapped)
            return;
        this._sendButton.remove_all_transitions();
        this._sendButton.set({scale_x: 0.6, scale_y: 0.6});
        this._sendButton.ease({scale_x: 1, scale_y: 1, duration: 200, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    /** The steps done, a tick each; one just done fades in. */
    _showSteps(done) {
        const before = this._stepsBox.visible ? this._stepsBox.get_n_children() : 0;
        this._stepsBox.destroy_all_children();
        for (const step of done) {
            const row = new St.BoxLayout({style_class: 'isle-voice-step'});
            row.add_child(new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: 11, style_class: 'isle-voice-step-tick',
                y_align: Clutter.ActorAlign.CENTER}));
            // As read, not as written: an AI's step may come with Markdown ("**done**").
            const line = new St.Label({text: answerPlain(step).replace(/\s+/g, ' '), style_class: 'isle-voice-step-text', y_align: Clutter.ActorAlign.CENTER});
            line.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(line);
            this._stepsBox.add_child(row);
        }
        this._stepsBox.visible = done.length > 0;
        // A step just done joins the list fading in (a list that just appeared fades in whole, see `fit`).
        if (before > 0 && done.length > before && this.mapped && St.Settings.get().enable_animations)
            fadeIn(this._stepsBox.get_last_child());
    }

    /** `text` naming the shortcut as set instead of the default one isled's hints name. */
    withShortcut(text) {
        if (this.shortcut)
            return text.replaceAll('Super+I', this.shortcut);
        // No shortcut set: "Press Super+I and speak again." is "Speak again."; any other mention, the mic.
        return text.replace(/Press Super\+I and (\w)/, (_match, first) => first.toUpperCase())
            .replace(/press Super\+I/gi, match => `${match[0] === 'P' ? 'P' : 'p'}ress the mic in the island`);
    }

    /** Whether a request is being typed. */
    get typing() {
        return this._entry.visible;
    }

    /** While isled is not recording yet (getting the AI or the speech model ready), "Getting ready…" in place of
     * "Listening…": what was said then would be lost. */
    set micWaiting(waiting) {
        if (waiting === this._micWaiting)
            return;
        this._micWaiting = waiting;
        if (this._phase !== 'listening' || this.typing)
            return;
        this._text.clutter_text.use_markup = false;
        this._text.text = this._listeningText();
        if (waiting || !this.greeting)
            this._text.add_style_class_name('isle-voice-text-dim');
        else
            this._text.remove_style_class_name('isle-voice-text-dim');
        this.emit('size-changed');
    }

    /** The dim line while it listens. */
    _listeningText() {
        return this._micWaiting ? 'Getting ready…' : this.greeting ?? 'Listening…';
    }

    /** Whether the pointer is on the island: an answer then shows its × (see `_syncClose`). */
    set pointerOn(on) {
        this._pointerOn = on;
        this._syncClose();
    }

    // Only an answer in the pill has one: at work there is Stop, and the conversation closes with Esc.
    _syncClose() {
        revealClose(this._close, this._pointerOn && ['reply', 'error'].includes(this._phase) && !this.chatOpen);
    }

    /** Shows the field to type a request in, starting with `initial` (a key typed while it listened); `card` is isled's. */
    startTyping(initial = '', card = null) {
        this._dropEndedCard(card);
        this._phase = 'typing';
        this._syncClose();
        // A new request: the steps and working time of one still at work when the field opened are not its.
        this._lastPhase = 'typing';
        this._lastStep = null;
        this._steps = [];
        this._entry.text = initial;
        this._entry.show();
        this._text.hide();
        this._hint.hide();
        this._stepsBox.hide();
        this._signIn.hide();
        this._setUp.hide();
        this._showAction(null);
        this._syncSend();
        this._entry.grab_key_focus();
        this._entry.clutter_text.set_cursor_position(-1);
        this._face.setForm('typing');
        this._syncIdeas();
    }

    /** Hides the field; the answer line comes back. */
    stopTyping() {
        this._entry.hide();
        this._text.show();
        this._syncIdeas();
    }

    // The ideas show while the field is empty, until something is asked in this conversation.
    _syncIdeas() {
        const shown = this.typing && !this._entry.text && !this._history.length;
        if (shown === this._ideas.visible)
            return;
        this._ideas.visible = shown;
        this.emit('size-changed');
    }

    /** Shows `button` (or none) at the row's end; a new one comes in with a small pop. */
    _showAction(button) {
        this._action.visible = Boolean(button);
        if (button === this._shownAction)
            return;
        this._shownAction = button;
        for (const other of [this._typeButton, this._stop])
            other.visible = other === button;
        if (!button || !St.Settings.get().enable_animations)
            return;
        button.remove_all_transitions();
        button.set({opacity: 0, scale_x: 0.6, scale_y: 0.6});
        button.ease({opacity: 255, scale_x: 1, scale_y: 1, duration: 220, mode: Clutter.AnimationMode.EASE_OUT_BACK});
    }

    /** Keeps the steps of the request being worked on; a new request starts the list over. */
    _noteStep(phase, step) {
        if (!WORKING.includes(phase)) {
            if (phase === 'listening')
                this._steps = [];
            return;
        }
        // Work starting again after an answer is a new request, typed in the conversation too (no listening
        // between): the last one's steps, its words among them, are not this one's.
        if (!WORKING.includes(this._lastPhase ?? ''))
            this._steps = [];
        // Kept as it was said, but for one that reads oddly once over ("Asking to run it").
        const done = DONE_AS[step] ?? step?.replace(/…$/, '');
        if (done && this._steps.at(-1) !== done)
            this._steps.push(done);
    }

    /** The microphone's level (0..1). */
    setLevel(level) {
        this._micTarget = level;
    }

    /** isled's phase as last shown, or 'typing'. */
    get phase() {
        return this._phase;
    }

    /** The character's shape and colours: {shape, palette} (see bot.js). */
    set look(look) {
        this._face.setLook(look);
    }

    /** The look for the little faces beside its answers in the conversation. */
    set chatLook(look) {
        this._chat.look = look;
    }

    /** The exchange on show once answered: {heard, reply}, else null. */
    get exchange() {
        return this._phase === 'reply' ? this._exchange : null;
    }

    /** In stage pixels: narrow while it only listens. */
    get preferredWidth() {
        // With something to show above, it stays wide, so a conversation never jumps.
        const short = ['listening', 'transcribing'].includes(this._phase) && !this.followUp && !this.typing &&
            !this.chatOpen && !this._undo.visible;
        return px(short ? LISTENING_WIDTH : ANSWER_WIDTH);
    }

    /** Sizes the texts, wrapped, and returns the height wanted below the top bar. */
    fit() {
        // Typing, the field takes the button's place too (its send is inside it). A command card keeps the
        // button's room as it waits, runs and ends, so it never changes width.
        const scale = uiScale();
        const width = this.preferredWidth - (TEXT_INSET - (this._action.visible || this._card.visible ? 0 : ACTION_SIZE + 12)) * scale;
        // Measured per label: the box's own answer is the size set below.
        const parts = [this._undo, this._heardButton, this._entry, this._ideas, this._text, this._card, this._stepsBox, this._still,
            this._hint, this._signIn, this._setUp];
        // Every step counted first: those a card hid last time may fit now (see `_fitCard`).
        this._stepsBox.get_children().forEach(step => step.show());
        let natural = parts.filter(part => part.visible).reduce((sum, part) => sum + part.get_preferred_height(width)[1], 0);
        this._fadeInNew(parts);
        // A command card needs room for its buttons.
        let most = (this._card.visible ? CARD_MAX_HEIGHT : MAX_HEIGHT) * scale;
        if (this._card.visible)
            natural = this._fitCard(width, natural, most - ROW_PADDING * scale);
        // Its buttons always in sight: a card taller than that (a long command, read whole before Run) gets the
        // room it needs, up to CARD_TALLEST.
        if (this._card.visible)
            most = Math.max(most, Math.min(natural + ROW_PADDING * scale, CARD_TALLEST * scale));
        // Set outright: the row kept an earlier, shorter height for them.
        this._texts.set_size(width, Math.min(natural, most - ROW_PADDING * scale));
        // Beside a line or two it sits in the middle; beside more, level with the first line.
        this._lead.y_align = this._action.y_align =
            natural > (FACE_SIZE + 8) * scale ? Clutter.ActorAlign.START : Clutter.ActorAlign.CENTER;
        const row = Math.round(Math.min(most, Math.max(MIN_HEIGHT * scale, natural + ROW_PADDING * scale)));
        this._row.height = row;
        if (!this.chatOpen)
            return row;
        // Above a tall card the conversation keeps its header and a message, the island taller for it.
        const chat = this._chat.naturalHeight(this.preferredWidth, Math.max(CHAT_MIN_HEIGHT * scale, CHAT_MAX_HEIGHT * scale - row));
        this._chat.height = chat;
        return row + chat;
    }

    /** Beside a command card, the oldest steps give way (the newest stays) until the card fits in `room`; returns
     * the height then. The steps are all in the conversation still. */
    _fitCard(width, natural, room) {
        const steps = this._stepsBox.get_children();
        if (natural <= room || !this._stepsBox.visible)
            return natural;
        const spacing = this._stepsBox.get_theme_node().get_length('spacing');
        for (const step of steps.slice(0, -1)) {
            if (natural <= room)
                break;
            natural -= step.get_preferred_height(width)[1] + spacing;
            step.hide();
        }
        return natural;
    }

    // What comes into view fades in as the shape grows to it, rather than show cut off by its edge.
    _fadeInNew(parts) {
        const shown = new Set(parts.filter(part => part.visible));
        if (this.mapped && St.Settings.get().enable_animations) {
            for (const part of shown) {
                if (!this._shownParts.has(part))
                    fadeIn(part);
            }
        }
        this._shownParts = shown;
    }

    /** Animates while shown; rests otherwise. With animations off in GNOME, the face and glow hold still. */
    setActive(active) {
        if (active && !this._timeline.is_playing()) {
            this._start = Date.now();
            this._lastTick = 0;
            this._face.restart();
            if (St.Settings.get().enable_animations) {
                this._timeline.start();
            } else {
                this._face.queue_repaint();
                this.emit('frame', 0, STILL_LEVEL, 0);
            }
        } else if (!active) {
            this._timeline.stop();
        }
    }

    // While it works with no new step for a while: how long it has been at it, once a second.
    _syncStill() {
        const now = Date.now() / 1000;
        const working = WORKING.includes(this._phase) && !this._card.visible;
        const text = working && now - this._stepAt > STILL_WORKING_S ? `Still working · ${elapsed(now - this._workingAt)}` : '';
        if (text === this._stillShown)
            return;
        const resize = Boolean(text) !== Boolean(this._stillShown);
        this._stillShown = text;
        this._still.text = text;
        this._still.visible = Boolean(text);
        if (resize)
            this.emit('size-changed');
    }

    /** The edge glow's level for the phase at `t` (s). */
    _levelFor(t) {
        switch (this._phase) {
        case 'listening':
            return this._mic;
        // Each key lights it a little, as a syllable does.
        case 'typing':
            return 0.08 + 0.6 * this._mic;
        case 'transcribing':
            return 0.28 + 0.05 * Math.sin(t * 2);
        case 'thinking':
        case 'acting':
            return 0.32 + 0.08 * Math.sin(t * 1.8);
        case 'reply':
            return 0.12 + 0.03 * Math.sin(t * 1.2);
        default:
            return 0.05;
        }
    }

    /** Each frame: eases the mic and glow, moves the face, and tells the island. */
    _tick() {
        const t = (Date.now() - this._start) / 1000;
        const dt = Math.min(0.1, Math.max(0, t - this._lastTick));
        this._lastTick = t;
        // The voice, smoothed by time (not by frame): quick to rise with a syllable, slow to fall,
        // so the 20 updates a second from isled never show as flicker.
        this._micTarget = (this._micTarget ?? 0) * Math.exp(-dt * MIC_FADE);
        const rate = this._micTarget > this._mic ? MIC_ATTACK : MIC_RELEASE;
        this._mic += (this._micTarget - this._mic) * (1 - Math.exp(-dt * rate));
        // The edge glow swells with your voice, breathes while thinking and settles once answered;
        // Run flares it and Deny dims it, for a moment.
        this._boost *= Math.exp(-dt * 3);
        const target = Math.max(0, this._levelFor(t) + 0.55 * this._boost);
        this._level += (target - this._level) * (1 - Math.exp(-dt * LEVEL_RATE));
        this._face.level = this._level;
        this._face.step(t);
        this._face.queue_repaint();
        this._card.tick(t);
        this._syncStill();
        // A little faster while it thinks; summed up, so a change of speed never makes the glow jump.
        const speed = WORKING.includes(this._phase) ? 1.6 : 1;
        this._flow += dt * speed;
        // While it works, the light's streaks shine brighter as they run round; eased, so it never jumps.
        this._work = (this._work ?? 0) + ((WORKING.includes(this._phase) ? 1 : 0) - (this._work ?? 0)) * (1 - Math.exp(-dt * 3));
        this.emit('frame', this._flow, this._level, this._work);
    }
});

/** The phases in which a request is being worked on. */
const WORKING = ['transcribing', 'thinking', 'acting'];
/** How many done steps show below the current one. */
const MAX_DONE_STEPS = 3;

/** An answer cut to MAX_REPLY characters at a word's end, its Markdown kept whole. */
function clip(text) {
    const trimmed = text.trim();
    if (trimmed.length <= MAX_REPLY)
        return trimmed;
    // At a word's end, so no word or emoji is split (half an emoji is not even text).
    let cut = trimmed.slice(0, MAX_REPLY - 1);
    const end = cut.search(/\s+\S*$/);
    cut = `${(end > MAX_REPLY / 2 ? cut.slice(0, end) : cut.replace(/[\uD800-\uDBFF]$/, '')).trimEnd()}…`;
    // `Code` or **bold** it cut through closes after the "…", so no stray marks show.
    if ((cut.match(/`/g) ?? []).length % 2)
        cut += '`';
    if ((cut.replace(/`[^`]+`/g, '').match(/\*\*/g) ?? []).length % 2)
        cut += '**';
    return cut;
}

// Terminals, the desktop's chosen one first, each with what comes before the command. A CLI's sign-in runs
// there (a browser, then a code pasted back), so Isle never handles the code.
const TERMINALS = [
    ['xdg-terminal-exec'], ['gnome-terminal', '--'], ['kgx', '--'], ['ptyxis', '--'], ['konsole', '-e'],
    ['xfce4-terminal', '-x'], ['mate-terminal', '-x'], ['terminator', '-x'], ['kitty'], ['alacritty', '-e'],
    ['ghostty', '-e'], ['wezterm', 'start', '--'], ['foot'], ['x-terminal-emulator', '-e'],
];

/** Opens a terminal to sign in to `provider` ("agy", "claude", "codex", "grok", "opencode"), with its CLI where isled
 * found it (`found`: nvm, Homebrew…); false without a terminal or the CLI. */
export function openSignIn(provider, found = '') {
    const [name, ...args] = SIGN_IN[provider] ?? SIGN_IN.agy;
    const program = (GLib.path_get_basename(found ?? '') === name && found) || GLib.find_program_in_path(name) ||
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', name]);
    if (!GLib.file_test(program, GLib.FileTest.IS_EXECUTABLE))
        return false;
    // Its own folder first, so a CLI run by Node finds the Node installed beside it.
    const path = `${GLib.path_get_dirname(program)}:${GLib.getenv('PATH') ?? '/usr/bin:/bin'}`;
    return inTerminal(['env', `PATH=${path}`, program, ...args]);
}

/** Opens a terminal that downloads the speech `model` (isle-setup-voice) and stays open to show how it went. */
export function openSetUp(model, shortcut = 'Super+I') {
    const program = GLib.find_program_in_path('isle-setup-voice') ??
        GLib.build_filenamev([GLib.get_home_dir(), '.local', 'bin', 'isle-setup-voice']);
    // What to do next, naming the shortcut as set (passed as an argument, never part of the script).
    const next = shortcut ? `Press ${shortcut} and speak.` : 'Press the mic in the island and speak.';
    return GLib.file_test(program, GLib.FileTest.IS_EXECUTABLE) && inTerminal(['bash', '-c', SET_UP, 'isle', next,
        program, ...model ? [model] : []]);
}

// Runs isle-setup-voice ($2…), then says what next ($1); a shell stays open afterwards.
const SET_UP = 'next="$1"; shift; "$@" && printf "\\nIsle: done. %s\\n" "$next" || ' +
    'printf "\\nIsle: that did not finish; run isle-setup-voice again.\\n"; exec bash';

/** How each AI CLI signs in, run in a terminal (`agy` and `claude` ask on start). */
const SIGN_IN = {
    agy: ['agy'], claude: ['claude'], codex: ['codex', 'login'], grok: ['grok', 'login'],
    opencode: ['opencode', 'auth', 'login'],
};

/** What to do when no terminal could be opened to sign in. */
export function signInHint(provider) {
    return `Open a terminal, type “${(SIGN_IN[provider] ?? SIGN_IN.agy).join(' ')}” to sign in, then ask again.`;
}

/** The AI picked in Settings and the model picked for each, as isled reads them. */
export function aiSettings(settings) {
    return {
        provider: settings.get_string('voice-provider'),
        agy_model: settings.get_string('voice-agy-model'),
        claude_model: settings.get_string('voice-claude-model'),
        codex_model: settings.get_string('voice-codex-model'),
        grok_model: settings.get_string('voice-grok-model'),
        opencode_model: settings.get_string('voice-opencode-model'),
    };
}

/** Runs `argv` in a new terminal window; false when no terminal could be opened. */
function inTerminal(argv) {
    for (const [program, ...before] of TERMINALS) {
        const terminal = GLib.find_program_in_path(program);
        if (!terminal)
            continue;
        try {
            GLib.spawn_async(null, [terminal, ...before, ...argv], null, GLib.SpawnFlags.DEFAULT, null);
            return true;
        } catch (e) {
            console.warn(`Isle: could not open ${program}: ${e.message}`);
        }
    }
    return false;
}

// Shows `$1` typed at a bash prompt, run only once Enter is pressed (it can be edited first); a shell stays
// open afterwards. Passed as an argument, the command is never part of the script itself.
const TYPED_COMMAND = 'printf "\\033[2mIsle: press Enter to run it, edit it first, or Ctrl+C to cancel.\\033[0m\\n"; ' +
    'read -r -e -i "$1" -p "$ " line && eval "$line"; exec bash';

/** Opens a terminal with `command` typed in, waiting for the user to press Enter. */
function typeInTerminal(command) {
    const line = terminalLine(command);
    // What the user could not read whole before pressing Enter is never typed, as a card never offers it.
    if (line === null)
        return failed('not typed: it has hidden characters, or is too long to show whole');
    if (!line)
        return failed('no command to type');
    return inTerminal(['bash', '-c', TYPED_COMMAND, 'isle', line]) ? 'typed into a terminal' : failed('no terminal app found');
}

/** The greeting it opens with; it understands any language spoken back. */
export const GREETING = 'How can I help?';

/** Starts `argv` (systemd-run; for root, GNOME's password dialog shows first): whether it started. */
function startUnit(argv) {
    return new Promise(resolve => {
        let process;
        try {
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve(failed(`not started: ${e.message}`));
            return;
        }
        process.communicate_utf8_async(null, null, (_process, result) => {
            try {
                const [, , stderr] = process.communicate_utf8_finish(result);
                if (process.get_successful()) {
                    resolve({ok: true, detail: 'started'});
                    return;
                }
                // The password dialog dismissed is the usual way it ends here.
                const why = (stderr ?? '').trim().split('\n').at(-1) || `exit ${process.get_exit_status()}`;
                resolve(failed(/dismissed|not authorized|access denied/i.test(why)
                    ? `not started: the password was not given (${why})` : `not started: ${why}`));
            } catch (e) {
                resolve(failed(`not started: ${e.message}`));
            }
        });
    });
}

/** Stops one of Isle's commands (Stop on its card). */
export function stopUnit(argv) {
    if (!stoppable(argv))
        return;
    try {
        Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    } catch (e) {
        console.warn(`Isle: could not stop the command: ${e.message}`);
    }
}

// What isled passes on to the AI: the apps, the models, the selected text (not from apps kept out of the
// clipboard history) and, when allowed, the latest of `notifications` (a NotificationCenter).
export async function voiceContext(settings, notifications, {apps = [], selectedIn = null} = {}) {
    // Asked for first, before anything else can move the selection.
    const selection = sharesSelection(settings, selectedIn) ? primarySelection() : Promise.resolve('');
    const system = Shell.AppSystem.get_default();
    return JSON.stringify({
        apps,
        actions: actionTypes(settings),
        running: system.get_running().map(app => app.get_name()),
        windows: openWindows(),
        ...aiSettings(settings),
        whisper_model: settings.get_string('voice-speech-model'),
        language: settings.get_string('voice-language'),
        keep_chat: settings.get_string('voice-keep-chat'),
        selection: await selection,
        // null: not allowed to read them; []: allowed, but there are none.
        notifications: settings.get_boolean('voice-read-notifications') ? recentNotifications(notifications) : null,
    });
}

// The installed apps' names, sorted, for the AI. Gathering them takes a few milliseconds, enough to stall
// the island as it opens, so they are kept until apps are installed or removed, and gathered when idle.
export class InstalledApps {
    /** Gathers the names when idle, and again whenever apps are installed or removed. */
    constructor() {
        this._names = null;
        this._system = Shell.AppSystem.get_default();
        this._changed = this._system.connect('installed-changed', () => this._gatherLater());
        this._gatherLater();
    }

    /** Gathered now if the idle gathering hasn't run yet. */
    get names() {
        this._names ??= [...new Set(this._system.get_installed()
            .filter(info => info.should_show()).map(info => info.get_name()))].sort();
        return this._names;
    }

    /** Forgets the names and gathers them again once the shell is idle. */
    _gatherLater() {
        this._names = null;
        if (this._idle)
            GLib.source_remove(this._idle);
        this._idle = GLib.idle_add(GLib.PRIORITY_LOW, () => {
            this._idle = 0;
            void this.names;
            return GLib.SOURCE_REMOVE;
        });
    }

    /** Stops listening for installs. */
    destroy() {
        this._system.disconnect(this._changed);
        if (this._idle)
            GLib.source_remove(this._idle);
    }
}

// Whether the selected text may go to the AI: allowed in Settings, made in the window in front (`selectedIn`),
// and that is neither a terminal (tokens, commands) nor an app kept out of the clipboard history.
function sharesSelection(settings, selectedIn) {
    const window = global.display.focus_window;
    if (!settings.get_boolean('voice-use-selection') || !window || window !== selectedIn)
        return false;
    const app = Shell.WindowTracker.get_default().get_window_app(window);
    return !isTerminal(window) && !(app && settings.get_strv('clipboard-ignored-apps').includes(app.get_id()));
}

/** The newest notifications as {app, title, body, time}, the time as local HH:MM. */
function recentNotifications(center) {
    return center.notifications.slice(0, MAX_NOTIFICATIONS).map(notification => {
        const body = plainBody(notification).replace(/\s+/g, ' ').trim();
        return {
            app: notification.source?.title ?? '',
            title: notification.title ?? '',
            body: body.length > MAX_NOTIFICATION_BODY ? `${body.slice(0, MAX_NOTIFICATION_BODY - 1)}…` : body,
            time: notification.datetime?.to_local().format('%H:%M') ?? '',
        };
    });
}

/** The text selected anywhere (the primary selection), trimmed and cut to MAX_SELECTION; '' if none. */
function primarySelection() {
    return new Promise(resolve => {
        let done = false;
        const finish = text => {
            if (done)
                return;
            done = true;
            const trimmed = (text ?? '').trim();
            resolve(trimmed.length > MAX_SELECTION ? `${trimmed.slice(0, MAX_SELECTION - 1)}…` : trimmed);
        };
        // An app that is slow to hand its selection over is not waited for.
        const giveUp = after(SELECTION_TIMEOUT_MS, () => finish(''));
        St.Clipboard.get_default().get_text(St.ClipboardType.PRIMARY, (_clipboard, text) => {
            giveUp();
            finish(text);
        });
    });
}

// Each action the AI may answer with (see `Session::prompt` in isled); each returns what it did, for the AI.
// `isle` holds the daemon, audio, notifications, the window in front (`target`), its `writer` and `closeThen`.
const ACTIONS = {
    open_url: ({url}) => {
        if (!/^(https?|mailto):/i.test(url ?? ''))
            return failed('not a web address');
        openUri(url);
        return 'opened in the browser';
    },
    open_app: async ({app}, isle) => {
        const found = findApp(app ?? '');
        if (!found)
            return failed(`no app called ${app}`);
        // Not running yet: a media command after it waits for its player.
        if (found.get_state() !== Shell.AppState.RUNNING)
            isle.launched = found;
        found.activate();
        // What comes next (placing its window) needs the window there.
        return await windowOf(found, WINDOW_WAIT_MS) ? `${found.get_name()} is open` : `${found.get_name()} is starting`;
    },
    media: ({command}, {daemon, launched}) => {
        const method = {play_pause: 'PlayPause', next: 'Next', previous: 'Previous'}[command];
        if (!method)
            return failed('not a media command');
        return whenPlayerOf(daemon, launched, () => called(daemon, 'media', method));
    },
    focus: ({command}, {daemon}) => daemon.call('pomodoro', command === 'stop' ? 'Stop' : 'Start'),
    add_task: ({text}, {daemon}) => text && daemon.call('todo', 'Add', text),
    // To the calendar the Calendar page adds to (an account's, or Isle's own).
    add_event: ({date, text}, {daemon, eventCalendar}) => date && text && daemon.addEvent(eventCalendar(), date, text),
    done_task: ({id}, {daemon}) => Number.isInteger(id) && daemon.call('todo', 'SetDone', id, true),
    remove_task: ({id}, {daemon}) => Number.isInteger(id) && daemon.call('todo', 'Remove', id),
    cancel_reminder: ({id}, {daemon}) => Number.isInteger(id) && daemon.call('reminders', 'Dismiss', id),
    remove_event: ({id}, {daemon}) => Number.isInteger(id) && daemon.call('calendar', 'Remove', id),
    remind: ({minutes, text}, {daemon}) => {
        if (!text || !(minutes > 0))
            return failed('a reminder needs its minutes and its words');
        return called(daemon, 'reminders', 'Add', Math.round(minutes * 60000), text);
    },
    volume: ({level, command}, {audio}) => {
        if (!audio.hasOutput)
            return failed('there is no sound output');
        if (typeof level === 'number')
            audio.volume = level / 100;
        else if (command === 'up' || command === 'down')
            audio.volume += command === 'up' ? 0.1 : -0.1;
        else if (['mute', 'unmute'].includes(command))
            (command === 'mute') !== audio.muted && audio.toggleMuted();
        else
            return failed('not a volume command');
        return undefined;
    },
    wifi: ({on}) => spawn(['nmcli', 'radio', 'wifi', on === false ? 'off' : 'on']),
    bluetooth: ({on}) => setBluetooth(on !== false),
    dnd: ({on}, {notifications}) => {
        notifications.dnd = on !== false;
    },
    notifications: (_action, {showNotifications}) => showNotifications(),
    play_music: ({query, uri}) => playMusic(query ?? '', uri),
    window: ({command, title, app}, {target}) => {
        const window = title ? windowTitled(title)
            : app ? findApp(app, Shell.AppSystem.get_default().get_running())?.get_windows()[0] : target;
        // The window in front when asked may have closed since.
        if (!window?.get_compositor_private())
            return failed('no such window is open');
        if (!WINDOW_COMMANDS[command])
            return failed(`no window command ${command}`);
        WINDOW_COMMANDS[command](window);
        return `${command}: ${window.title ?? 'the window'}`;
    },
    arrange: ({layout, apps}) => {
        const count = arrangeWindows(layout, Array.isArray(apps) ? apps : []);
        return count ? `${count} windows arranged` : failed('no matching windows are open');
    },
    open_file: async ({path}) => await withFile(path, file => openUri(file.get_uri()), {opening: true})
        ? 'opened' : failed('not found, or not allowed'),
    reveal_file: async ({path}) => await withFile(path, file => revealFile(file))
        ? 'shown in Files' : failed('not found, or not allowed'),
    chrome_profile: ({profile}) => openChromeProfile(profile ?? ''),
    close_app: async ({app}) => {
        const running = findApp(app ?? '', Shell.AppSystem.get_default().get_running());
        if (!running)
            return failed(`${app} is not open`);
        const name = running.get_name();
        running.request_quit();
        return await closed(running, CLOSE_WAIT_MS) ? `${name} closed` : failed(`${name} is still open; it may be asking to save`);
    },
    open_folder: ({path}) => openFolder(path ?? ''),
    brightness: ({level, command}) => setBrightness(level, command),
    dark_mode: ({on}) => setDarkMode(on !== false),
    power_mode: ({mode}) => setPowerMode(mode),
    night_light: ({on}) => new Gio.Settings({schema_id: 'org.gnome.settings-daemon.plugins.color'})
        .set_boolean('night-light-enabled', on !== false),
    settings: ({panel}) => /^[a-z-]+$/.test(panel ?? '') && spawn(['gnome-control-center', panel]),
    terminal: ({command}) => typeof command === 'string' && typeInTerminal(command),
    // A command the AI wants run: the user says Run or Deny (the card, or an alert while the island is
    // closed); run, it starts as a systemd unit of its own, which isled follows to its end.
    run: async (action, {decide}) => {
        if (!runnable(action, shellUser()))
            return failed('Isle refused to start it: it was not the command shown');
        const answer = await decide(action);
        if (answer === 'unanswered')
            return failed('no answer in time');
        if (!answer)
            return failed('denied');
        return startUnit(action.spawn);
    },
    screenshot: (_action, {closeThen}) => closeThen(() => Main.screenshotUI.open()),
    lock: (_action, {closeThen}) => closeThen(() => Main.screenShield?.lock(true)),
    // Closed first, so the keys go back to the window the user asked from.
    write: ({text}, {closeThen, target, writer}) => {
        if (typeof text === 'string' && text)
            closeThen(() => writer.write(text, target));
    },
};

// What the actions are still waiting on (a player to appear, a moment to pass), each with how to stop it;
// all stopped when the extension is turned off (`stopPending`).
const pending = new Set();
/** Counts `stopPending` calls: actions started before one never go on after it. */
let generation = 0;

/** Calls `callback` after `ms`, unless stopped first; returns the stop. */
function after(ms, callback) {
    const entry = {};
    const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
        pending.delete(entry);
        callback();
        return GLib.SOURCE_REMOVE;
    });
    entry.stop = () => {
        if (pending.delete(entry))
            GLib.source_remove(id);
    };
    pending.add(entry);
    return entry.stop;
}

/** Stops everything the actions still wait on, and the actions still to run. */
export function stopPending() {
    generation++;
    for (const entry of [...pending])
        entry.stop();
}

// Runs `run` once `app` (just launched; null for none) is the player isled controls; never if it doesn't show up.
function whenPlayerOf(daemon, app, run) {
    const id = app?.get_id().replace(/\.desktop$/, '').toLowerCase();
    const ready = () => {
        const playing = daemon.state.nowPlaying;
        return playing?.available && (playing.desktop_entry.toLowerCase() === id ||
            playing.identity.toLowerCase() === app.get_name().toLowerCase());
    };
    if (!app || ready())
        return Promise.resolve(run());
    return new Promise(resolve => {
        const entry = {};
        const changed = daemon.connect('changed', (_daemon, key) => {
            if (key === 'nowPlaying' && ready()) {
                entry.stop();
                resolve(run());
            }
        });
        const giveUp = after(PLAYER_WAIT_MS, () => {
            entry.stop();
            resolve(failed(`${app.get_name()} did not start playing in time`));
        });
        entry.stop = () => {
            if (!pending.delete(entry))
                return;
            daemon.disconnect(changed);
            giveUp();
        };
        pending.add(entry);
    });
}

/** What an isled call did, for the AI: its reply, else failed with isled's own words. */
async function called(daemon, ...args) {
    const {result, error} = await daemon.attempt(...args);
    return result === null ? failed(error ?? `${args[1]} did not work`) : result;
}


// What `window` does to a window.
const WINDOW_COMMANDS = {
    focus: window => Main.activateWindow(window),
    close: window => window.delete(global.get_current_time()),
    minimize: window => window.minimize(),
    maximize,
    unmaximize,
    fullscreen: window => window.make_fullscreen(),
    unfullscreen: window => window.unmake_fullscreen(),
    ...Object.fromEntries(Object.entries(TILES).map(([name, slot]) => [name, window => tile(window, slot)])),
};

/** Puts `window` in `slot` of its monitor's work area. */
function tile(window, [x, y, width, height]) {
    const area = window.get_work_area_current_monitor();
    if (window.is_fullscreen())
        window.unmake_fullscreen();
    // A maximized window keeps its size; a no-op on any other.
    WINDOW_COMMANDS.unmaximize(window);
    window.move_resize_frame(true, Math.round(area.x + area.width * x), Math.round(area.y + area.height * y),
        Math.round(area.width * width), Math.round(area.height * height));
}

// Tiles windows on this workspace: those of `apps` in that order (one each, or every window of a single
// app), else the ones in front; as many as `layout` holds, and the first of them is focused. Returns how many.
function arrangeWindows(layout, apps) {
    const workspace = global.workspace_manager.get_active_workspace();
    // Windows of their own, which a dialog with no parent window is too.
    const shown = window => !window.skip_taskbar && !window.minimized && (window.get_window_type() === Meta.WindowType.NORMAL ||
        (window.get_window_type() === Meta.WindowType.DIALOG && !window.get_transient_for()));
    // Front to back.
    const stack = global.display.sort_windows_by_stacking(workspace.list_windows().filter(shown)).reverse();
    let windows = stack;
    if (apps.length > 0) {
        const running = Shell.AppSystem.get_default().get_running();
        const each = apps.length > 1 ? 1 : Infinity;
        windows = apps.flatMap(name => {
            const app = findApp(name, running);
            return app ? stack.filter(window => app.get_windows().includes(window)).slice(0, each) : [];
        });
        windows = [...new Set(windows)];
    }
    const slots = slotsFor(layout, windows.length);
    const placed = windows.slice(0, slots.length);
    placed.forEach((window, i) => tile(window, slots[i]));
    if (placed.length > 0)
        Main.activateWindow(placed[0]);
    return placed.length;
}

// Plays `uri` (a Spotify link isled checked) in Spotify, started first if need be; without one, Spotify
// opens on a search for `query`, and without Spotify, YouTube Music does.
function playMusic(query, uri) {
    const spotify = findApp('spotify');
    if (!spotify) {
        if (!query)
            return failed('Spotify is not installed and nothing was named to play');
        openUri(`https://music.youtube.com/search?q=${encodeURIComponent(query)}`);
        return 'Spotify is not installed: searched YouTube Music in the browser';
    }
    if (!uri) {
        if (!query)
            return failed('nothing was named to play');
        openUri(`spotify:search:${encodeURIComponent(query)}`);
        return 'searched Spotify';
    }
    const play = () => Gio.DBus.session.call(SPOTIFY_BUS, '/org/mpris/MediaPlayer2', 'org.mpris.MediaPlayer2.Player',
        'OpenUri', new GLib.Variant('(s)', [uri]), null, Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
            try {
                bus.call_finish(result);
            } catch (e) {
                // Spotify then at least shows it.
                console.warn(`Isle: Spotify would not play ${uri}: ${e.message}`);
                openUri(uri);
            }
        });
    // Just started, it takes a moment past joining the bus before it plays what it's given.
    const ready = spotify.get_state() === Shell.AppState.RUNNING ? play : () => after(1500, play);
    whenOnBus(SPOTIFY_BUS, PLAYER_WAIT_MS, ready);
    spotify.activate();
}

/** At most this many open windows go to the AI, each title cut to this many characters. */
const MAX_WINDOWS = 20;
const MAX_WINDOW_TITLE = 80;

/** The windows on screen, as {app, title}, the ones in the task bar only. */
function openWindows() {
    const tracker = Shell.WindowTracker.get_default();
    return global.get_window_actors().map(actor => actor.meta_window)
        .filter(window => !window.skip_taskbar && window.title)
        .slice(0, MAX_WINDOWS)
        .map(window => ({
            app: tracker.get_window_app(window)?.get_name() ?? '',
            title: window.title.slice(0, MAX_WINDOW_TITLE),
        }));
}

/** The open window whose title contains `title`, ignoring case. */
function windowTitled(title) {
    const wanted = title.toLowerCase().trim();
    if (!wanted)
        return null;
    // Frontmost first (the actors run bottom to top); the closest match wins: the whole title, a word in it,
    // then any part ("youtube" is the browser's YouTube tab before "youtube_notes.txt").
    const windows = global.get_window_actors().map(actor => actor.meta_window)
        .filter(window => !window.skip_taskbar).reverse();
    const titled = window => (window.title ?? '').toLowerCase();
    return windows.find(window => titled(window) === wanted) ??
        windows.find(window => namesProject(titled(window), wanted)) ??
        windows.find(window => titled(window).includes(wanted)) ?? null;
}

/** Folders the assistant may open or show files in, as isled's own file tools do. */
const FILE_ROOTS = ['/media/', '/mnt/', '/run/media/'];
/** Kinds of file that run something when opened; the assistant never opens those. */
const RUNS = /x-desktop|java-archive|executable|x-sharedlib|x-msdownload|x-ms-dos|x-msi|x-deb|x-rpm|x-appimage|x-shellscript|x-perl|x-python|x-ruby|x-php/;

/** Runs `callback` with `path` (from ~, or absolute) as a Gio.File if allowed: in home (not a hidden part) or on
 * a removable drive, never a link; `opening` also refuses anything that would run. Returns whether it ran. */
async function withFile(path, callback, {opening = false} = {}) {
    if (typeof path !== 'string' || !path.trim())
        return false;
    const home = GLib.get_home_dir();
    const expanded = path.trim().replace(/^~(?=\/|$)/, home);
    const file = Gio.File.new_for_path(GLib.canonicalize_filename(expanded, home));
    const where = file.get_path();
    const inHome = where.startsWith(`${home}/`);
    if (!inHome && !FILE_ROOTS.some(root => where.startsWith(root)))
        return false;
    if (inHome && where.slice(home.length + 1).split('/').some(part => part.startsWith('.')))
        return false;
    let info;
    try {
        info = await queryInfo(file, 'standard::is-symlink,standard::content-type,access::can-execute',
            Gio.FileQueryInfoFlags.NOFOLLOW_SYMLINKS);
    } catch {
        return false; // not there
    }
    if (info.get_is_symlink())
        return false;
    if (opening) {
        const type = info.get_content_type() ?? '';
        const mime = Gio.content_type_get_mime_type(type) ?? '';
        // Documents and media open in a viewer whatever their permissions (files on a USB stick often
        // look executable); anything else that could run is left alone.
        const viewed = type === 'inode/directory' || /^(image|video|audio|text)\//.test(mime) ||
            /pdf|opendocument|officedocument|msword|ms-excel|ms-powerpoint|epub/.test(mime);
        const runnable = Gio.content_type_can_be_executable(type) || info.get_attribute_boolean('access::can-execute');
        if (RUNS.test(mime) || (!viewed && runnable))
            return false;
    }
    callback(file);
    return true;
}

/** Shows `file` selected in the file manager, as "Show in Files" does. */
function revealFile(file) {
    Gio.DBus.session.call('org.freedesktop.FileManager1', '/org/freedesktop/FileManager1',
        'org.freedesktop.FileManager1', 'ShowItems', new GLib.Variant('(ass)', [[file.get_uri()], '']),
        null, Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
            try {
                bus.call_finish(result);
            } catch {
                // No file manager there: its folder, at least.
                openUri(file.get_parent()?.get_uri() ?? file.get_uri());
            }
        });
}

/** Opens Chrome (or Chromium) in the profile kept in folder `profile`, e.g. "Profile 2". */
function openChromeProfile(profile) {
    if (!/^[\w .-]+$/.test(profile))
        return failed('not a profile name');
    const browser = ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']
        .map(name => GLib.find_program_in_path(name)).find(Boolean);
    if (!browser)
        return failed('neither Chrome nor Chromium is installed');
    GLib.spawn_async(null, [browser, `--profile-directory=${profile}`], null, GLib.SpawnFlags.DEFAULT, null);
    return undefined;
}

/** Opens `uri` in its default app, launched as from the shell. */
function openUri(uri) {
    Gio.AppInfo.launch_default_for_uri(uri, global.create_app_launch_context(0, -1));
}

/** Runs `callback` once `name` is on the session bus, now or within `ms`; never if it doesn't come. */
function whenOnBus(name, ms, callback) {
    const entry = {};
    const watch = Gio.bus_watch_name(Gio.BusType.SESSION, name, Gio.BusNameWatcherFlags.NONE, () => {
        entry.stop();
        callback();
    }, null);
    const giveUp = after(ms, () => entry.stop());
    entry.stop = () => {
        if (!pending.delete(entry))
            return;
        Gio.bus_unwatch_name(watch);
        giveUp();
    };
    pending.add(entry);
}

/** Runs `argv` to its end: {ok, output} (its error output when it failed). */
function finish(argv) {
    return new Promise(resolve => {
        let process;
        try {
            process = Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_PIPE);
        } catch (e) {
            resolve({ok: false, output: e.message});
            return;
        }
        process.communicate_utf8_async(null, null, (_process, result) => {
            try {
                const [, stdout, stderr] = process.communicate_utf8_finish(result);
                const ok = process.get_successful();
                resolve({ok, output: ((ok ? stdout : stderr || stdout) ?? '').trim()});
            } catch (e) {
                resolve({ok: false, output: e.message});
            }
        });
    });
}

/** Sets the power mode (power-profiles-daemon): power-saver, balanced or performance. */
async function setPowerMode(mode) {
    if (!['power-saver', 'balanced', 'performance'].includes(mode))
        return failed('the mode is power-saver, balanced or performance');
    const program = GLib.find_program_in_path('powerprofilesctl');
    if (!program)
        return failed('power-profiles-daemon is not installed, so there are no power modes to switch');
    const {ok, output} = await finish([program, 'set', mode]);
    // Not every computer has a performance mode.
    return ok ? `power mode is now ${mode}` : failed(output.split('\n').at(-1) || 'it did not change');
}

/** Starts `argv` without waiting; failed when the program is not installed. */
function spawn(argv) {
    const program = GLib.find_program_in_path(argv[0]);
    if (!program)
        return failed(`${argv[0]} is not installed`);
    GLib.spawn_async(null, [program, ...argv.slice(1)], null, GLib.SpawnFlags.DEFAULT, null);
    return undefined;
}

/** Opens `path` (from ~, or absolute) in Files; a folder that isn't there opens its nearest parent. */
async function openFolder(path) {
    const home = GLib.get_home_dir();
    const expanded = path.trim().replace(/^~(?=\/|$)/, home);
    let folder = Gio.File.new_for_path(GLib.path_is_absolute(expanded) ? expanded : GLib.build_filenamev([home, expanded]));
    while (folder.get_parent() && !await isFolder(folder))
        folder = folder.get_parent();
    openUri(folder.get_uri());
    return `opened ${folder.get_path()}`;
}

/** `file`'s info for `attributes`, read off the main loop's way. */
function queryInfo(file, attributes, flags = Gio.FileQueryInfoFlags.NONE) {
    return new Promise((resolve, reject) => {
        file.query_info_async(attributes, flags, GLib.PRIORITY_DEFAULT, null, (_file, result) => {
            try {
                resolve(file.query_info_finish(result));
            } catch (e) {
                reject(e);
            }
        });
    });
}

/** Whether `file` is a folder; false when it can't be read. */
async function isFolder(file) {
    try {
        return (await queryInfo(file, 'standard::type')).get_file_type() === Gio.FileType.DIRECTORY;
    } catch {
        return false;
    }
}

/** The dark style, and on Ubuntu its Yaru theme to match, as its Settings do. */
function setDarkMode(dark) {
    const settings = new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    settings.set_string('color-scheme', dark ? 'prefer-dark' : 'default');
    const theme = settings.get_string('gtk-theme');
    if (theme.startsWith('Yaru')) {
        const light = theme.replace(/-dark$/, '');
        settings.set_string('gtk-theme', dark ? `${light}-dark` : light);
    }
}

/** The screen's brightness: `level` 0..100, or `command` up or down by a tenth. */
function setBrightness(level, command) {
    const step = {up: 10, down: -10}[command];
    if (typeof level !== 'number' && !step)
        return failed('not a brightness command');
    // GNOME 48 and later.
    const scale = Main.brightnessManager?.globalScale;
    if (scale) {
        const value = typeof level === 'number' ? level / 100 : scale.value + step / 100;
        scale.value = Math.max(0.01, Math.min(1, value));
        return undefined;
    }
    const SERVICE = ['org.gnome.SettingsDaemon.Power', '/org/gnome/SettingsDaemon/Power'];
    const IFACE = 'org.gnome.SettingsDaemon.Power.Screen';
    const set = percent => propertySet(...SERVICE, IFACE, 'Brightness',
        new GLib.Variant('i', Math.round(Math.max(1, Math.min(100, percent)))));
    if (typeof level === 'number')
        return set(level);
    return new Promise(resolve => {
        Gio.DBus.session.call(...SERVICE, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [IFACE, 'Brightness']), null, Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
                try {
                    resolve(set(bus.call_finish(result).deep_unpack()[0].deep_unpack() + step));
                } catch (e) {
                    resolve(failed(`this screen's brightness can't be read (${e.message})`));
                }
            });
    });
}

/** Turns Bluetooth on or off as Quick Settings does, through GNOME's rfkill service. */
function setBluetooth(on) {
    return propertySet('org.gnome.SettingsDaemon.Rfkill', '/org/gnome/SettingsDaemon/Rfkill',
        'org.gnome.SettingsDaemon.Rfkill', 'BluetoothAirplaneMode', new GLib.Variant('b', !on));
}

/** Sets a D-Bus property of a GNOME service: resolves undefined once done, else failed with why. */
function propertySet(name, path, iface, property, value) {
    return new Promise(resolve => {
        Gio.DBus.session.call(name, path, 'org.freedesktop.DBus.Properties', 'Set',
            new GLib.Variant('(ssv)', [iface, property, value]), null, Gio.DBusCallFlags.NONE, -1, null,
            (bus, result) => {
                try {
                    bus.call_finish(result);
                    resolve(undefined);
                } catch (e) {
                    resolve(failed(e.message.replace(/^GDBus\.Error:[\w.]+:\s*/, '')));
                }
            });
    });
}

/** What this extension can do: isled offers the AI nothing else. Not the Notifications page while it is left out. */
export function actionTypes(settings) {
    const notifications = !settings.get_strv('hidden-pages').includes('notifications');
    return Object.keys(ACTIONS).filter(type => type !== 'notifications' || notifications);
}

/** Runs the AI's actions in order; `isle` is what they act on (see `ACTIONS`). Resolves to what each did,
 * as `{type, ok, detail}`, for the AI to take its next step from. */
export async function runActions(actions, isle) {
    const results = [];
    const started = generation;
    for (const action of actions ?? []) {
        // Isle turned off meanwhile: nothing more runs.
        if (generation !== started)
            break;
        let outcome;
        try {
            outcome = ACTIONS[action.type] ? await ACTIONS[action.type](action, isle) : failed('unknown action');
        } catch (e) {
            console.warn(`Isle: voice action ${action.type} failed: ${e.message}`);
            outcome = failed(e.message);
        }
        results.push({type: action.type, ...outcomeOf(outcome)});
    }
    return results;
}

/** Resolves once `app` has a window (true), or after `ms` (false). */
function windowOf(app, ms) {
    return windowsUntil(app, windows => windows.length > 0, ms);
}

/** Resolves once `app` has no window left (true), or after `ms` (false). */
function closed(app, ms) {
    return windowsUntil(app, windows => windows.length === 0, ms);
}

/** Resolves once `app`'s windows pass `test` (true), or after `ms` (false). */
function windowsUntil(app, test, ms) {
    if (test(app.get_windows()))
        return Promise.resolve(true);
    return new Promise(resolve => {
        const entry = {};
        const changed = app.connect('windows-changed', () => {
            if (test(app.get_windows()))
                entry.stop(true);
        });
        const giveUp = after(ms, () => entry.stop(false));
        entry.stop = (found = false) => {
            if (!pending.delete(entry))
                return;
            app.disconnect(changed);
            giveUp();
            resolve(found);
        };
        pending.add(entry);
    });
}

/** The app called `name` among `running` (Shell.Apps), else installed: by exact name, then by part of its name or id. */
function findApp(name, running = null) {
    const wanted = name.toLowerCase().trim();
    if (!wanted)
        return null;
    const system = Shell.AppSystem.get_default();
    const apps = running ?? system.get_installed().filter(info => info.should_show());
    const match = apps.find(app => app.get_name().toLowerCase() === wanted) ??
        apps.find(app => app.get_name().toLowerCase().includes(wanted)) ??
        apps.find(app => app.get_id().toLowerCase().includes(wanted.replace(/\s+/g, '')));
    return match && !running ? system.lookup_app(match.get_id()) : match ?? null;
}
