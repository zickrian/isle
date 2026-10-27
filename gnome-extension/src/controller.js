// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Decides what the island shows and when (compact, peek or expanded); see docs/product-spec.md.
// Alerts show one at a time; "instant" ones (volume, brightness, critical...) replace what is showing.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

import {namesProject} from './actionRules.js';
import * as Alerts from './alerts.js';
import {paletteFor} from './bot.js';
import {ClipboardHistory} from './clipboard.js';
import {CompactView} from './compact.js';
import {grabsKeyboard, inhibitScanout, onUiScale, px, stageScale, uiScale} from './compat.js';
import {Daemon} from './daemon.js';
import {BOTTOM_PADDING, ExpandedView, PAGE_HEIGHT} from './expanded.js';
import {Island} from './island.js';
import {AudioOutputs} from './audio.js';
import {CallMonitor} from './call.js';
import {FocusMode} from './focusMode.js';
import * as Format from './format.js';
import {NotificationCenter} from './notifications.js';
import {PrivacyMonitor} from './privacy.js';
import {PeekView} from './peek.js';
import * as Playback from './playback.js';
import {KeyboardWatcher, OsdHook, TopBar} from './shell.js';
import {ShelfHelper} from './shelfHelper.js';
import {CallPage} from './pages/call.js';
import {CalendarPage} from './pages/calendar.js';
import {MediaPage} from './pages/media.js';
import {NotificationsPage} from './pages/notifications.js';
import {ShelfPage} from './pages/shelf.js';
import {TasksPage} from './pages/tasks.js';
import {TimerPage} from './pages/timer.js';
import {UsagePage} from './pages/usage.js';
import {ReminderWatcher} from './reminders.js';
import {GREETING, InstalledApps, UNDO_MS, VoiceView, stopUnit, actionTypes, aiSettings, openSetUp, openSignIn, runActions, signInHint, stopPending, voiceContext} from './voice.js';
import {TextWriter} from './writer.js';

/** While the pointer rests before the island opens (Settings: hover-delay), it moves at most this far (CSS px). */
const REST_DISTANCE_PX = 10;
/** The views and pages are laid out ahead this long after starting, a step at a time (see `_warmUp`). */
const WARM_START_MS = 3000;
const WARM_STEP_MS = 60;
// A ring alert's parts, the alert views' warm-up (see `_warmUp`). Its words are blank, figure spaces as wide
// as real ones, so nothing readable could ever show even if a frame caught it.
const WARM_ALERT = {key: 'warm', title: '\u2007'.repeat(8), subtitle: '\u2007'.repeat(4), icon: 'isle-bolt', ring: 0,
    value: '\u2007'.repeat(3), tone: 'neutral'};
/** And again this long after the island closes, or a page changes out of sight, while it stays closed... */
const WARM_AFTER_CLOSE_MS = 1500;
/** How long a permission notice waits for the island's own ask for it, which may come a moment later. */
const ASK_SETTLE_MS = 1500;
/** An ask this recent for the session covers its permission notice. */
const ASKED_RECENTLY_MS = 60000;
/** ...but for changes, at most this often: a notification updating every second (a download) costs little. */
const WARM_GAP_MS = 10000;
/** Outside an island that shrank under it, the pointer is checked this often, and left this long. */
const MOVE_CHECK_MS = 250;
const STILL_OUTSIDE_MS = 30000;
/** Grace period before closing when the pointer leaves. */
const COLLAPSE_DELAY_MS = 300;
/** An alert the pointer rested on stays this long once it leaves, to finish reading. */
const ALERT_LEAVE_MS = 1500;
/** Touchpad travel over an alert that puts it away (up) or opens the island (down); a wheel's click is one. */
const ALERT_SWIPE = 1.5;
/** A pause this long between scroll events starts a new swipe. */
const SWIPE_GAP_MS = 180;
/** A page picked by hand is kept for this long before smart defaults resume. */
const PAGE_MEMORY_MS = 5 * 60 * 1000;
/** An alert's width is checked again this soon after it shows. */
const ALERT_FIT_DELAY_MS = 60;
/** Which switch in Settings each kind of system event answers to. */
const SYSTEM_ALERTS = {power: 'power', battery_low: 'power', battery_full: 'power', network: 'network', bluetooth: 'bluetooth'};
/** The open island's header on a display without the top bar. */
const HEADER_WITHOUT_BAR = 32;
/** A window's animation (minimizing, say) is over by then, so whether it covers the display is checked again. */
const SCANOUT_SETTLE_MS = 400;
/** isled may be away this long (restarting after an update) before the island does anything about it. */
const SERVICE_GRACE_MS = 5000;
/** Opened from the keyboard without getting it, the island closes this soon unless the pointer is on it. */
const KEYBOARD_LESS_CLOSE_MS = 4000;
/** Notifications waiting to be shown past this many come as one summary. */
const MAX_QUEUED_NOTIFICATIONS = 3;
/** Without input for this long, the user is away and animations rest; sooner on battery. */
const IDLE_MS = 60 * 1000;
const IDLE_ON_BATTERY_MS = 15 * 1000;

// Corner and shoulder ("ear") radii per presentation, in CSS pixels (see `px`); the shoulders grow with the island.
// The compact island hangs 30 px by default, with a 16 px corner and a 10 px shoulder.
const COMPACT_RADIUS = 16;
const COMPACT_SHOULDER = 10;
// Inside the top bar the closed island is a small notch. Its shoulders only show on a bar that is
// not black, where it hangs from the screen's top edge.
const IN_BAR_RADIUS = 10;
const IN_BAR_SHOULDER = 7;
const PEEK_RADIUS = 22;
// Off a black bar an alert has no bar to fill, so it starts this far below
// the screen's top instead of below the bar.
const PEEK_TOP_GLASS = 6;
const PEEK_SHOULDER = 13;
const EXPANDED_RADIUS = 32;
const EXPANDED_SHOULDER = 22;
const VOICE_RADIUS = 26;

/** A question back is shown this long before the island listens for the reply. */
const VOICE_LISTEN_AGAIN_MS = 900;
/** It listens by itself at most this many times in a row; a noisy room can't keep it open. */
const VOICE_MAX_AUTO_LISTENS = 2;
/** How long an answer stays: one that did something, one to read (by its length), and an error. */
const VOICE_DONE_MS = 2500;
const VOICE_READ_MS = {base: 3000, perChar: 45, max: 8000};
const VOICE_ERROR_MS = 4000;
/** Once read with the pointer on it, an answer goes this soon after the pointer leaves. */
const VOICE_LEAVE_MS = 1200;
/** Listening shown this long (ms) without isled recording yet, it says "Getting ready…" instead. */
const MIC_WAIT_MS = 400;
/** Closed while listening, a request isled starts on within this long (ms) was the last words' own. */
const CLOSED_LISTENING_MS = 3000;
/** Where in its flow, and how bright, the still glow of an alert that asks is drawn. */
const ALERT_GLOW_TIME = 2.2;
const ALERT_GLOW_LEVEL = 0.3;
/** A command the AI wants run waits this long (ms) for Run or Deny, as isled does (see agent.rs). */
const APPROVAL_MS = 10 * 60 * 1000;
/** In the conversation, the field comes back this soon (ms) after an answer. */
const CHAT_TYPE_AGAIN_MS = 250;
/** isled's phases while it works on a request: with the island closed, it carries on in the background. */
const VOICE_WORKING = ['transcribing', 'thinking', 'acting'];

// Pages that open by default when they have something to show, best first, unless one was picked
// by hand lately. Notifications count only when some arrived unseen (others were shown as alerts).
const DEFAULT_PAGE_ORDER = ['call', 'notifications', 'music', 'focus'];
/** The AI agents Isle can hear from (see `Agents1` in the daemon). */
const AGENT_PROVIDERS = ['claude', 'codex'];

/** Builds the island a part at a time, then decides what it shows until `destroy`. */
export class Controller {
    /** Starts building on idle; nothing shows until `_buildIsland`. */
    constructor(extension) {
        this._extension = extension;
        this._settings = extension.getSettings();
        this._daemon = new Daemon();
        // Heard once everything listening is built (see `_connectAll`).
        this._daemon.hold();
        this._timeouts = new Map();
        /** When the island last asked for each agent session (`provider:session`); see `_onAgentEvent`. */
        this._askedAt = new Map();
        this._presentation = 'compact';
        /** Whether `_warmUp` shows the open island's view out of sight. */
        this._warmShown = false;
        this._expandWanted = false;
        this._alert = null;
        this._queue = [];
        this._keyboardGrab = null;
        this._pagePickedAt = 0;
        this._lastTrack = null;
        this._tint = null;
        this._tintStyle = null;
        this._voiceOpen = false;
        this._voiceBound = false;
        /** The touchpad swipe over an alert under way: {dy, at, done} (see `_onAlertScroll`). */
        this._swipe = null;
        /** Whether the alert and voice views were laid out ahead since the theme last changed (see `_warmUp`). */
        this._viewsWarm = false;
        /** Counts `_listen` calls, so only the latest sends its request. */
        this._listenRequest = 0;
        /** A Listen went to isled and is not over: typing instead cancels it, even before isled says it listens. */
        this._listenSent = false;
        /** The last request handed to isled (see `_listenRequest`). */
        this._sentRequest = -1;
        this._voiceCloseMs = VOICE_ERROR_MS;
        /** The last answer whose actions ran, and the last batch of actions run mid-way (see isled's `step`). */
        this._voiceTurn = 0;
        this._voiceStep = 0;
        /** A request carries on after the island closed; its answer comes as an alert. */
        this._voiceInBackground = false;
        /** Opened by resting the pointer on it while it works: it goes back as the pointer leaves. */
        this._voiceByHover = false;
        /** When it closed while listening (see `CLOSED_LISTENING_MS`), else 0. */
        this._closedListeningAt = 0;
        /** Whether isled's assistant state was seen yet (see `_onAssistant`). */
        this._assistantSeen = false;
        /** Times in a row it listened again by itself; see `VOICE_MAX_AUTO_LISTENS`. */
        this._autoListens = 0;
        /** The window in front when the assistant opened, for it to write into. */
        this._voiceTarget = null;
        /** Actions waiting for the island to close; see `closeThen`. */
        this._voiceAfter = [];
        /** The window text was last selected in, so a selection only goes to the AI from where it was made. */
        this._selectedIn = null;

        // Built a part at a time, frames drawn in between: all at once, it held the screen still for a tenth
        // of a second at every login and unlock. Nothing outside calls in before the last part.
        this._pages = [];
        this._buildSteps = [
            () => this._buildServices(),
            () => this._buildViews(),
            // A page a step: the music and shelf pages alone take a frame's time.
            ...this._pageMakers().map(make => () => this._pages.push(make())),
            () => (this._expanded = this._buildExpanded(this._pages)),
            () => this._buildIsland(),
            () => this._connectAll(),
        ];
        this._building = GLib.idle_add(GLib.PRIORITY_DEFAULT_IDLE, () => {
            try {
                this._buildSteps.shift()();
            } catch (e) {
                // A part failing (on a GNOME that changed under it) leaves no half-built island: what was built goes.
                console.warn(`Isle: could not start: ${e.message}\n${e.stack}`);
                this._building = 0;
                this._failed = true;
                this._destroyPartial();
                return GLib.SOURCE_REMOVE;
            }
            if (this._buildSteps.length)
                return GLib.SOURCE_CONTINUE;
            this._building = 0;
            return GLib.SOURCE_REMOVE;
        });
    }

    /** What the views watch: notifications, privacy, calls, audio, focus mode and the clipboard. */
    _buildServices() {
        // One "system alerts" switch before 0.7: an "off" there carries over to each of its parts.
        if (!this._settings.get_boolean('system-alerts')) {
            for (const category of ['power', 'network', 'bluetooth', 'caps-lock'])
                this._settings.set_boolean(`alert-${category}`, false);
            this._settings.set_boolean('system-alerts', true);
        }
        this._notifications = new NotificationCenter(this._settings);
        this._privacy = new PrivacyMonitor(this._daemon);
        this._call = new CallMonitor(this._privacy, this._settings);
        this._audio = new AudioOutputs();
        this._focusMode = new FocusMode(this._daemon, this._notifications, this._settings);
        this._clipboard = new ClipboardHistory(this._daemon, this._settings);
        this._writer = new TextWriter(this._clipboard);
    }

    /** The island and its closed, alert and voice views; the pages follow a step at a time. */
    _buildViews() {
        this._island = new Island();
        this._compact = new CompactView(this._daemon, this._settings, this._privacy, this._call);
        // Two, taking turns: a new alert fades in over the one it replaces, rather than swapping in a frame.
        this._peeks = [new PeekView(), new PeekView()];
        this._peek = this._peeks[0];
        this._botLook = this._readBotLook();
        this._voice = new VoiceView(this._botLook);
        this._voice.chatLook = this._botLook;
    }

    // The bar and the island appear together: the clock gives way to it in the same frame.
    _buildIsland() {
        this._topBar = new TopBar(this._settings);
        this._shelf = this._expanded.pageNamed('shelf');
        this._shelfHelper = new ShelfHelper(this._island, this._shelf);
        for (const view of [this._compact, ...this._peeks, this._expanded, this._voice])
            this._island.addView(view);
        Main.layoutManager.addChrome(this._island, {trackFullscreen: true});
        this._updateGeometry();
        this._render();
    }

    /** The last step: hooks the island to GNOME and isled, then lets isled's held changes through. */
    _connectAll() {
        this._primaryChanged = global.display.get_selection().connect('owner-changed', (_selection, type) => {
            if (type === Meta.SelectionType.SELECTION_PRIMARY)
                this._selectedIn = global.display.focus_window;
        });
        // Clicking into a window, or one an action opened, puts an answer away.
        this._focusChanged = global.display.connect('notify::focus-window', () => {
            const focus = global.display.focus_window;
            if (this._voiceOpen && this._voiceAnswered && focus && focus !== this._voiceTarget)
                this.collapse();
            this._passToAgentWindow(focus);
            this._syncMonitor();
        });
        // Hidden by a fullscreen window meanwhile: what waited shows now.
        this._island.connect('notify::visible', () => {
            this._syncScanout();
            if (!this._island.visible) {
                this._onHidden();
                return;
            }
            // A pointer on it as it hid told it nothing on leaving.
            this._island.syncHover();
            if (!this._alert)
                this._nextAlert();
        });
        // A window that may now cover the island's display, or no longer: see `_syncScanout`. Again once its
        // animation (minimizing, say) is over, as some signals come as it starts.
        const sync = () => {
            this._syncScanout();
            this._later('scanout', SCANOUT_SETTLE_MS, () => this._syncScanout());
        };
        this._scanoutWatches = [
            [global.display, ['restacked', 'workareas-changed', 'in-fullscreen-changed', 'window-entered-monitor',
                'window-left-monitor']],
            [global.window_manager, ['size-changed', 'minimize', 'unminimize', 'map', 'destroy']],
            [global.workspace_manager, ['active-workspace-changed']],
            [Main.layoutManager.panelBox, ['notify::mapped', 'notify::y', 'notify::translation-y']],
        ].flatMap(([source, signals]) => signals.map(signal => [source, source.connect(signal, sync)]));
        this._syncScanout();
        this._panelAdded = Main.layoutManager.uiGroup.connect('child-added', (_group, actor) => {
            // Once GNOME has placed it, which it does right after this.
            if (actor === Main.layoutManager.panelBox)
                this._later('panel', 0, () => this._keepAbovePanel());
        });
        this._keepAbovePanel();
        this._connectSignals();
        this._keyboard = new KeyboardWatcher();
        this._keyboard.connect('caps-lock', (_watcher, on) => this._postSystemAlert(Alerts.capsLock(on), 'caps-lock'));
        this._osd = new OsdHook((icon, label, level, maxLevel) => this._showOsd(icon, label, level, maxLevel));
        this._watchIdle();
        this._installedApps = new InstalledApps();
        this._reminders = new ReminderWatcher(this._daemon, (reminder, done) => {
            this._post(Alerts.reminder(reminder, () => {
                this._chime('complete');
                done();
            }));
        });
        this._syncVoiceEnabled();
        this._syncUsage();
        this._syncEventAlerts();
        this._syncPages();
        // The pointer met while it was still being built (after unlocking, at rest on it) is told now.
        if (this._island.hovered)
            this._onHoverChanged();
        this._render();
        this._later('warm', WARM_START_MS, () => this._warmUp(true));
        this._daemon.release();
    }

    /** Makes each page, in tab order. */
    _pageMakers() {
        const size = {height: PAGE_HEIGHT};
        return [
            () => new CallPage(this._daemon, this._call, this._privacy, this._settings, size),
            () => new MediaPage(this._daemon, this._audio, size),
            () => new NotificationsPage(this._daemon, this._notifications, size),
            () => new TimerPage(this._daemon, size),
            () => new TasksPage(this._daemon, size),
            () => new ShelfPage(this._daemon, this._clipboard, this._settings, size),
            () => new CalendarPage(this._daemon, size),
            () => new UsagePage(this._daemon, size),
        ];
    }

    /** The open island over `pages`, its signals wired to the keyboard, closing, warm-ups and tints. */
    _buildExpanded(pages) {
        for (const page of pages) {
            page.connect('request-keyboard', (_page, wanted) => this._setKeyboard(wanted));
            page.connect('request-close', () => this.collapse());
            page.connect('cold', () => this._scheduleWarm());
        }
        const expanded = new ExpandedView(this._daemon, this._privacy, this._call, this._settings, pages);
        expanded.connect('page-changed', () => {
            // Picked by hand (a tab, a swipe) while open; not when opening, nor when a page
            // (the call's) goes away by itself.
            if (this._expandWanted && expanded.pickedByHand)
                this._pagePickedAt = Date.now();
            if (expanded.page === this._shelf)
                this._shelfHelper?.prepare();
            this._shelfHelper?.sync();
        });
        expanded.connect('page-settled', () => this._shelfHelper?.sync());
        expanded.pageNamed('shelf').connect('helper-area-changed', () => this._shelfHelper?.sync());
        // Lyrics widen the island and wash it with the cover's colour.
        expanded.connect('width-changed', () => {
            if (this._presentation === 'expanded')
                this._render();
        });
        expanded.connect('tint-changed', () => this._syncTint());
        expanded.connect('tint-motion', (_view, time, level) => {
            if (this._presentation === 'expanded')
                this._island.setTintMotion(time, level);
        });
        // A request still at work shows its progress, as from the closed island; a new one would be lost.
        expanded.connect('voice-requested', () => this._voiceWorking ? this._reopenVoice() : this._openVoice({typing: true}));
        // Settings open in their own window; the island gets out of its way.
        expanded.connect('settings-requested', () => {
            this.collapse();
            this._extension.openPreferences();
        });
        return expanded;
    }

    /** Everything else it reacts to: pointer, keys, the shelf helper, Settings, isled and notifications. */
    _connectSignals() {
        const island = this._island;
        island.connect('notify::hovered', () => this._onHoverChanged());
        // Hidden (under a fullscreen window), nothing can be laid out: it waits until shown again.
        island.connect('notify::mapped', () => this._scheduleWarm());
        // A new theme or text size restyles every view: laid out ahead again at the next warm-up.
        island.connect('style-changed', () => (this._viewsWarm = false));
        island.connect('button-release-event', (_actor, event) => this._onClick(event));
        island.connect('touch-event', (_actor, event) => this._onTap(event));
        island.connect('scroll-event', (_actor, event) => this._onAlertScroll(event));
        island.connect('geometry-changed', () => this._shelfHelper.sync());

        // A file dragged towards the island opens the shelf to drop it on.
        this._shelfHelper.connect('drag-near', () => {
            // Left out in Settings: no shelf to drop on.
            if (this._shelf.hidden)
                return;
            this._shelf.showTab('files');
            this._shelf.dropping = true;
            this.expand('shelf');
            // The shelf stays the page to open on, to drag the files out again.
            this._pagePickedAt = Date.now();
        });
        this._shelfHelper.connect('drag-over', (_helper, over) => (this._shelf.dropOver = over));
        this._shelfHelper.connect('drag-files', (_helper, uris) => this._shelf.showDragged(uris));
        this._shelfHelper.connect('drag-end', (_helper, onShelf = false) => {
            // A full shelf turns the file away: the island shakes its head.
            if (this._shelf.endDrop(onShelf))
                this._island.nudge();
            if (!this._island.hovered)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        });
        // It went elsewhere after all.
        this._shelfHelper.connect('drag-away', () => {
            this._shelf.dropping = false;
            this._collapseUnlessHeld();
        });
        this._shelfHelper.connect('available-changed', () =>
            (this._shelf.helperAvailable = this._shelfHelper.available));

        this._compact.connect('width-changed', () => {
            if (this._presentation === 'compact')
                this._render();
        });

        this._settingsChanged = ['notch-depth', 'island-in-top-bar'].map(key =>
            this._settings.connect(`changed::${key}`, () => this._render()));
        this._settingsChanged.push(this._settings.connect('changed::island-monitor', () => this._updateGeometry()));
        // On the display in use, it follows the window in front, once closed.
        this._focusMonitorChanged = global.display.connect('window-entered-monitor', () => this._syncMonitor());
        this._settingsChanged.push(this._settings.connect('changed::voice-assistant', () => {
            this._syncVoiceEnabled();
            this._syncUsage();
        }));
        this._settingsChanged.push(this._settings.connect('changed::voice-shortcut', () => (this._voice.shortcut = this._voiceShortcut)));
        for (const key of ['bot-shape', 'bot-color', 'bot-glow'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncBotLook()));
        for (const key of ['usage-enabled', 'usage-claude', 'usage-codex', 'usage-grok', 'usage-warn', 'usage-critical'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncUsage()));
        for (const key of ['event-alerts', 'event-alert-minutes'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncEventAlerts()));
        for (const key of ['hidden-pages', 'world-clocks'])
            this._settingsChanged.push(this._settings.connect(`changed::${key}`, () => this._syncPages()));
        for (const provider of AGENT_PROVIDERS) {
            this._settingsChanged.push(this._settings.connect(`changed::agent-alerts-${provider}`, () =>
                this._hookAgent(provider)));
        }

        this._topBar.connect('height-changed', () => this._updateGeometry());
        this._topBar.connect('style-changed', () => this._updateGeometry());
        this._topBar.connect('calendar-requested', () => this._toggleFromKeyboard());
        island.connect('key-press-event', (_actor, event) => {
            // A command waiting on the user: Enter runs it, Esc denies it.
            const key = event.get_key_symbol();
            if (this._voiceOpen && this._voice.cardWaiting && !this._voice.typing &&
                [Clutter.KEY_Return, Clutter.KEY_KP_Enter, Clutter.KEY_Escape].includes(key)) {
                this._voice.decideCard(key !== Clutter.KEY_Escape);
                return Clutter.EVENT_STOP;
            }
            if (event.get_key_symbol() === Clutter.KEY_Escape) {
                this.collapse();
                return Clutter.EVENT_STOP;
            }
            // Typing while it listens: the request is typed instead.
            const typed = event.get_key_unicode();
            const modified = event.get_state() & (Clutter.ModifierType.CONTROL_MASK | Clutter.ModifierType.MOD1_MASK |
                Clutter.ModifierType.SUPER_MASK);
            if (this._voiceOpen && !this._voice.typing && this._voice.phase === 'listening' && !modified &&
                typed && /\S/.test(typed)) {
                this._startTyping(typed);
                return Clutter.EVENT_STOP;
            }
            return Clutter.EVENT_PROPAGATE;
        });
        this._monitorsChanged = Main.layoutManager.connect('monitors-changed', () => this._updateGeometry());
        // Another scale (display settings, a display of another one): every size is laid out again.
        onUiScale(island, () => this._updateGeometry(), {now: false});

        const daemon = this._daemon;
        daemon.connect('changed', (_daemon, key) => {
            if (key === 'nowPlaying')
                this._onNowPlaying();
            else if (key === 'assistant')
                this._onAssistant();
            else if (key === 'chat')
                this._onHistory();
        });
        daemon.connect('voice-level', (_daemon, level) => {
            // Sound coming in: it records.
            this._micReady();
            this._voice.setLevel(level);
        });
        daemon.connect('assistant-lost', () => this._onAssistantLost());
        daemon.connect('running-changed', () => this._onServiceChanged());
        // Never started at all (a broken install) is the same as stopped.
        this._onServiceChanged();
        daemon.connect('usage-alert', (_daemon, provider, window, percent, resetsAt) => {
            // Not in Do Not Disturb, as other alerts.
            if (!this._notifications.dnd)
                this._post(Alerts.usage(provider, window, percent, resetsAt, this._settings.get_int('usage-critical')));
        });
        // isled forgets the settings when it restarts; they are sent again whenever it appears.
        daemon.connect('appeared', (_daemon, name) => {
            if (name === 'usage')
                this._syncUsage();
            else if (name === 'updates')
                this._syncUpdates();
            else if (name === 'media')
                this._syncLyrics();
            else if (name === 'agents')
                this._syncAgents(true);
        });
        daemon.connect('agent-event', (_daemon, event) => this._onAgentEvent(event));
        daemon.connect('agent-asking', (_daemon, request) => this._onAgentAsking(request));
        daemon.connect('agent-withdrawn', (_daemon, id) => this._withdrawAlert(`agent-ask:${id}`));
        // A command that ended while nobody watched (isled restarted, or the user was logged out).
        daemon.connect('model-switched', (_daemon, provider, plan, picked, used) =>
            this._post(Alerts.modelSwitched(provider, plan, picked, used)));
        daemon.connect('assistant-notice', (_daemon, text, ok) =>
            this._post(Alerts.assistant(ok ? {phase: 'reply', reply: text} : {phase: 'error', error: text},
                () => this._openVoice({typing: true}))));
        this._expanded.pageNamed('calendar').connect('event-soon', (_page, json) => this._onEventSoon(JSON.parse(json)));
        daemon.connect('changed', (_daemon, key) => {
            if (key === 'updates')
                this._onLatest();
            else if (key === 'agents')
                this._agentsUnsynced ? this._syncAgents() : this._hookNewAgents();
        });
        this._settingsChanged.push(this._settings.connect('changed::check-updates', () => this._syncUpdates()));
        this._settingsChanged.push(this._settings.connect('changed::lyrics-online', () => this._syncLyrics()));
        this._voice.connect('orb-clicked', () => this._onVoiceKey());
        // The × on an answer or an alert puts it away, as a click on the answer or a right click on the alert does.
        this._voice.connect('close-requested', () => this.collapse());
        for (const peek of this._peeks)
            peek.connect('close-requested', () => this._alert && !this._expandWanted && this._dismissAlert(true));
        this._voice.connect('type-requested', () => this._startTyping(''));
        this._voice.connect('typed', (_view, text) => this._ask(text));
        // Typing, then speaking after all: the field goes, it listens (the conversation stays open).
        this._voice.connect('speak', () => {
            this._autoListens = 0;
            this._listen();
        });
        this._voice.connect('new-chat', () => this._newChat());
        this._voice.connect('undo-new-chat', () => this._undoNewChat());
        this._voice.connect('card-decided', (_view, run) => this._deciding?.done(run));
        this._voice.connect('card-stop', () => stopUnit(this._daemon.state.assistant?.card?.stop));
        this._voice.connect('stop', () => {
            // A command card still waiting goes with the request: it is never asked again in an alert.
            this._deciding?.done(false);
            this._daemon.call('assistant', 'Cancel');
            this.collapse();
            // Stopped, not left to carry on.
            this._voiceInBackground = false;
            this._closedListeningAt = 0;
            this._syncAssistantBusy();
        });
        // An AI's CLI signs in from a terminal; the island gets out of its way.
        this._voice.connect('sign-in', () => {
            const state = this._daemon.state.assistant ?? {};
            if (openSignIn(state.provider, state.program))
                this.collapse();
            else
                this._voice.setState({...state, hint: signInHint(state.provider)});
        });
        this._voice.connect('set-up', () => {
            if (openSetUp(this._daemon.state.assistant?.model, this._voiceShortcut))
                this.collapse();
        });
        this._voice.connect('frame', (_view, time, level) => this._island.setTintMotion(time, level));
        this._voice.connect('size-changed', () => {
            if (this._presentation === 'voice')
                this._render();
        });
        daemon.connect('pomodoro-finished', (_daemon, finished, next) => {
            this._chime('complete');
            this._post(Alerts.pomodoroFinished(finished, next, daemon.state.pomodoro, daemon));
        });
        daemon.connect('system-event', (_daemon, event) =>
            this._postSystemAlert(Alerts.system(event), SYSTEM_ALERTS[event.kind] ?? 'power', event.kind === 'battery_low'));

        // Sharing or recording the screen, what others write and what was copied stay out of sight.
        this._privacy.connect('changed', () => this._syncSharing());
        this._syncSharing();
        this._privacy.connect('recording-started', () =>
            this._post(Alerts.recordingStarted(() => this._privacy.stopRecording())));
        // A new call is what the island opens on next, whatever was picked before.
        this._call.connect('started', () => (this._pagePickedAt = 0));

        // GNOME's notifications appear in the island instead of as banners.
        const notifications = this._notifications;
        notifications.connect('banner', (_center, notification) => {
            const urgent = notification.urgency === MessageTray.Urgency.CRITICAL;
            this._post(Alerts.notification(notification, urgent, {
                onShown: () => notifications.acknowledge(notification),
                // Taken back by its app: it goes from the island too.
                onWithdrawn: key => !this._destroying && this._withdrawAlert(key),
            }, this._sharing));
        });
        notifications.connect('dnd-changed', () => (this._compact.doNotDisturb = notifications.dnd));
        notifications.connect('changed', () => this._syncUnseen());
        notifications.connect('seen-changed', () => this._syncUnseen());
        this._compact.doNotDisturb = notifications.dnd;
        this._syncUnseen();
    }

    /** The unread dot, unless the Notifications page it leads to is left out. */
    _syncUnseen() {
        this._compact.unseenNotifications = this._notifications.unseenCount > 0 &&
            !this._settings.get_strv('hidden-pages').includes('notifications');
    }

    // Layout

    /** Places the island on its display, in or under the top bar, then redraws it. */
    _updateGeometry() {
        const before = this._monitor;
        this._monitor = this._wantedMonitor();
        // On a black bar the island grows out of it, its shoulders below the
        // bar; on any other it hangs from the top of the screen like a notch.
        this._island.topInset = this._blendsIn ? this._topBar.height : 0;
        this._island.monitor = this._monitor;
        // Without a top bar (another display) the open island's header is its own.
        this._expanded.topInset = this._onBar ? this._topBar.height : px(HEADER_WITHOUT_BAR);
        this._topBar.clockShown = !this._onBar;
        this._render();
        if (this._monitor !== before)
            this._syncFullscreen();
        this._syncScanout();
    }

    /** GNOME sends a window covering the whole display straight to the screen, hiding the island that still
     * takes the pointer. Painting stays on while both show, as for GNOME's own menus and OSDs. */
    _syncScanout() {
        const inhibit = !this._destroying && this._island.visible && this._windowCoversDisplay();
        if (inhibit === Boolean(this._scanoutInhibited))
            return;
        this._scanoutInhibited = inhibit;
        inhibitScanout(inhibit);
    }

    /** Whether the top window on the island's display covers all of it with no top bar drawn there. The top one
     * only, as GNOME picks: not the desktop's own (Ubuntu's desktop icons cover the display under every window). */
    _windowCoversDisplay() {
        const monitor = this._monitor;
        if (!monitor)
            return false;
        const panelBox = Main.layoutManager.panelBox;
        if (this._onBar && panelBox.mapped && panelBox.get_transformed_position()[1] >= monitor.y)
            return false;
        const workspace = global.workspace_manager.get_active_workspace();
        const top = global.get_window_actors().map(actor => actor.meta_window).reverse().find(window =>
            !window.minimized && window.get_monitor() === monitor.index && window.located_on_workspace(workspace) &&
            window.get_window_type() !== Meta.WindowType.DESKTOP && !window.is_skip_taskbar() && !window.customJS_ding);
        if (!top)
            return false;
        const rect = top.get_frame_rect();
        return rect.x <= monitor.x && rect.y <= monitor.y && rect.x + rect.width >= monitor.x + monitor.width &&
            rect.y + rect.height >= monitor.y + monitor.height;
    }

    // GNOME hides the island under a fullscreen window only when fullscreen changes, not when it moves
    // to another display: its rule (layout.js `_updateActorVisibility`), here.
    _syncFullscreen() {
        this._island.visible = !(global.window_group.visible && this._monitor?.inFullscreen);
    }

    /** The display the island belongs on: the main one, or the one of the window in use (see Settings). */
    _wantedMonitor() {
        const {monitors, primaryMonitor} = Main.layoutManager;
        if (this._settings.get_string('island-monitor') !== 'active')
            return primaryMonitor;
        const index = global.display.focus_window?.get_monitor() ?? -1;
        return monitors[index] ?? primaryMonitor;
    }

    /** Moves the island to the display in use, once it is closed (never mid-alert or open). */
    _syncMonitor() {
        if (this._monitor && this._presentation === 'compact' && this._wantedMonitor() !== this._monitor)
            this._updateGeometry();
    }

    /** Whether the island is on the main display, in its top bar. */
    get _onBar() {
        return this._monitor === Main.layoutManager.primaryMonitor;
    }

    /** Whether it grows out of a black top bar there. */
    get _blendsIn() {
        return this._onBar && this._topBar.blendsIn;
    }

    // Calendar and AI agents

    /** The calendar alarms, as Settings say (see `CalendarPage.alarmLead`). */
    _syncEventAlerts() {
        const minutes = this._settings.get_boolean('event-alerts') ? this._settings.get_int('event-alert-minutes') : 0;
        this._expanded.pageNamed('calendar').alarmLead = minutes;
    }

    /** The pages left out in Settings lose their tabs; the Calendar page's world clocks as Settings say. */
    _syncPages() {
        const hidden = this._settings.get_strv('hidden-pages');
        for (const page of this._expanded.pages) {
            if (page.name !== 'call' && page.name !== 'usage')
                page.hidden = hidden.includes(page.name);
        }
        this._syncUnseen();
        this._syncLyrics();
        this._expanded.pageNamed('calendar').worldClocks = this._settings.get_boolean('world-clocks');
    }

    /** Lyrics are looked up online only for the Music page, and only while it is in the island. */
    _syncLyrics() {
        this._daemon.call('media', 'SetLyrics', this._settings.get_boolean('lyrics-online') &&
            !this._settings.get_strv('hidden-pages').includes('music'));
    }

    /** An event starts soon: an alert, with Join when the event has a meeting link. Not in Do Not Disturb. */
    async _onEventSoon(event) {
        if (this._notifications.dnd)
            return;
        let link = '';
        // GNOME's id: the calendar, the event and its recurrence, a line each.
        const [source, uid] = event.id?.split('\n') ?? [];
        if (source && uid)
            link = (await this._daemon.call('calendar', 'MeetingLink', source, uid))?.[0] ?? '';
        // Isle turned off, or Do Not Disturb on, while the link was looked for.
        if (this._destroying || this._notifications.dnd)
            return;
        this._post(Alerts.meeting(event, link, () => {
            try {
                Gio.AppInfo.launch_default_for_uri(link, global.create_app_launch_context(0, -1));
            } catch (e) {
                console.warn(`Isle: could not open the meeting: ${e.message}`);
            }
        }));
    }

    /** The hooks as Settings say, once isled is there: a switch left on comes back after a reinstall, and one
     * turned off while isled was away takes its hook out. */
    _syncAgents(appeared = false) {
        // Started again, isled's properties may come a moment after it: then on the first of them.
        this._agentsUnsynced = !this._daemon.state.agents && (appeared || this._agentsUnsynced);
        if (this._agentsUnsynced)
            return;
        const agents = this._daemon.state.agents;
        this._agentsFound = Object.fromEntries(AGENT_PROVIDERS.map(provider => [provider, Boolean(agents[provider]?.found)]));
        for (const provider of AGENT_PROVIDERS) {
            const {found, hooked} = agents[provider] ?? {};
            // Not found any more, a hook left behind still goes when its switch is off.
            if ((found || hooked) && Boolean(hooked) !== this._settings.get_boolean(`agent-alerts-${provider}`))
                this._hookAgent(provider);
        }
    }

    /** An AI installed (or found again) while Isle runs gets its hook, if its switch is on. A hook the user took
     * out of the AI's own config by hand stays out: only an agent that just appeared is hooked. */
    _hookNewAgents() {
        const agents = this._daemon.state.agents ?? {};
        for (const provider of AGENT_PROVIDERS) {
            const {found, hooked} = agents[provider] ?? {};
            const appeared = found && !this._agentsFound?.[provider];
            if (this._agentsFound)
                this._agentsFound[provider] = Boolean(found);
            if (appeared && !hooked && this._settings.get_boolean(`agent-alerts-${provider}`))
                this._hookAgent(provider);
        }
    }

    /** Puts in or takes out `provider`'s hook, as its switch says; refused, the switch goes off and says why. */
    async _hookAgent(provider) {
        const on = this._settings.get_boolean(`agent-alerts-${provider}`);
        const {error} = await this._daemon.attempt('agents', 'SetHooked', provider, on);
        if (this._destroying)
            return;
        // On by default: the first time it connects, it says so once, so nothing changes unseen.
        if (!error && on) {
            const told = this._settings.get_strv('agents-announced');
            if (!told.includes(provider)) {
                this._settings.set_strv('agents-announced', [...told, provider]);
                this._post(Alerts.agentConnected(provider, this._botLook, () => this._extension.openPreferences()));
            }
            return;
        }
        if (!error || !on)
            return;
        this._settings.set_boolean(`agent-alerts-${provider}`, false);
        this._post(Alerts.agentRefused(provider, error));
    }

    /** Whether alerts are on for `provider`. Grok runs Claude's hooks, so it follows Claude's switch. */
    _alertsOn(provider) {
        return this._settings.get_boolean(`agent-alerts-${provider === 'grok' ? 'claude' : provider}`);
    }

    /** Claude Code, Codex or Grok needs the user, or is done: an alert, unless its window is the one in front. */
    _onAgentEvent(event) {
        if (!this._alertsOn(event.provider) || this._notifications.dnd)
            return;
        // A permission the island asked for itself needs no second alert; one it could not ask (a long
        // command, too many waiting) does. Its ask may come a moment after this.
        if (event.kind === 'permission') {
            const key = `${event.provider}:${event.session}`;
            this._later(`agent-permission:${key}`, ASK_SETTLE_MS, () => {
                if (Date.now() - (this._askedAt.get(key) ?? 0) > ASKED_RECENTLY_MS)
                    this._showAgentEvent(event);
            });
            return;
        }
        this._showAgentEvent(event);
    }

    /** The alert for `event`, unless the agent's window is the one in front. */
    _showAgentEvent(event) {
        const window = this._agentWindow(event);
        if (window && window === global.display.focus_window)
            return;
        const show = window ? () => Main.activateWindow(window) : null;
        this._post(event.kind === 'done' ? Alerts.agentDone(event, this._botLook, show) : Alerts.agent(event, show));
    }

    /** The window (a terminal, VS Code) the agent runs in: one of the hook's parent processes (`pids`), else the
     * latest whose title names the project. Null when unsure, so nothing is held back or sent there by mistake. */
    _agentWindow({project, pids}) {
        const windows = global.get_window_actors().map(actor => actor.meta_window);
        const named = window => namesProject(window.get_title() ?? '', project);
        const parents = new Set(pids ?? []);
        const own = windows.filter(window => parents.has(window.get_pid()));
        // One process may hold several windows (GNOME Terminal, VS Code): the one naming the project.
        if (own.length === 1)
            return own[0];
        if (own.length > 1) {
            const mine = own.filter(named);
            return mine.length === 1 ? mine[0] : null;
        }
        if (!project)
            return null;
        return windows.filter(named).sort((a, b) => b.get_user_time() - a.get_user_time())[0] ?? null;
    }

    /** Sizes and shapes the island for what it shows now: the assistant, the pages, an alert, or nothing. */
    _render() {
        if (this._destroying)
            return;
        const presentation = this._voiceOpen ? 'voice'
            : this._expandWanted ? 'expanded' : this._alert ? 'peek' : 'compact';
        this._presentation = presentation;
        if (presentation !== 'compact')
            this._putAwayWarm();
        // A display without the top bar: the island hangs from its top edge. Sizes are in stage pixels; the
        // CSS ones (padding) are divided by `scale` again, as St multiplies them.
        const scale = uiScale();
        const top = this._onBar ? this._topBar.height : 0;
        const inBar = this._onBar && this._settings.get_boolean('island-in-top-bar');
        // Before measuring it: inside the bar it is smaller.
        this._compact.inBar = inBar;

        // Alerts hang below the top bar; the open island's header sits in the bar. The compact island
        // either hangs too or sits inside the bar like a notch, covering no window.
        let size, view;
        switch (presentation) {
        case 'expanded':
            size = {
                width: this._expanded.preferredWidth,
                height: (this._onBar ? top : HEADER_WITHOUT_BAR * scale) + (PAGE_HEIGHT + BOTTOM_PADDING) * scale,
                radius: EXPANDED_RADIUS * scale,
                shoulder: EXPANDED_SHOULDER * scale,
            };
            view = this._expanded;
            break;
        case 'voice': {
            // Like an alert, it hangs below the bar (or near the top of the screen).
            const inset = this._blendsIn ? top : PEEK_TOP_GLASS * scale;
            size = {width: this._voice.preferredWidth, height: inset + this._voice.fit(), radius: VOICE_RADIUS * scale,
                shoulder: PEEK_SHOULDER * scale};
            view = this._voice;
            view.style = `padding-top: ${inset / stageScale()}px;`;
            break;
        }
        case 'peek': {
            const inset = this._blendsIn ? top : PEEK_TOP_GLASS * scale;
            size = {width: this._peek.preferredWidth, height: inset + this._peek.preferredHeight, radius: PEEK_RADIUS * scale,
                shoulder: PEEK_SHOULDER * scale};
            view = this._peek;
            view.style = `padding-top: ${inset / stageScale()}px;`;
            break;
        }
        default:
            size = {
                width: this._compact.preferredWidth,
                height: inBar ? top : top + this._settings.get_int('notch-depth') * scale,
                radius: (inBar ? IN_BAR_RADIUS : COMPACT_RADIUS) * scale,
                shoulder: (inBar ? IN_BAR_SHOULDER : COMPACT_SHOULDER) * scale,
            };
            view = this._compact;
            view.style = inBar ? null : `padding-top: ${top / stageScale()}px;`;
        }
        view.set_size(size.width, size.height);
        if (this._onBar)
            this._topBar.reserveWidth(this._compact.preferredWidth);
        this._island.morph(size, view);
        this._expanded.setActive(presentation === 'expanded');
        this._voice.setActive(presentation === 'voice');
        // A new alert under the pointer: its × shows (or not) at once.
        this._syncClose();
        this._syncTint();
        // Closed again, it goes to the display in use if that changed meanwhile.
        if (presentation === 'compact' && this._monitor && this._wantedMonitor() !== this._monitor)
            this._later('monitor', 0, () => this._syncMonitor());
        // Have the helper running before it is needed: starting takes a moment.
        if (presentation === 'expanded' && this._expanded.page === this._shelf)
            this._shelfHelper.prepare();
        this._shelfHelper.sync();
    }

    /** Lays out ahead, closed and a step at a time, what the frames showing it would otherwise style and lay
     * out: the pages changed out of sight, and with `all` the alert and voice views. */
    _warmUp(all) {
        const island = this._island;
        const expanded = this._expanded;
        if (!island.mapped)
            return;
        const pages = expanded.pages.filter(page => page.cold && !page.hidden);
        // The voice view only while the assistant is turned on.
        const steps = [];
        if (all) {
            // Each alert view shown with a ring alert's parts until the next step: a frame lays them out.
            for (const peek of this._peeks) {
                steps.push(() => island.warmView(peek, true) && peek.setAlert(WARM_ALERT, null, {fresh: true}));
                steps.push(() => island.warmView(peek, false));
            }
            if (this._voiceBound)
                steps.push(() => island.warmView(this._voice, true) && island.warmView(this._voice, false));
        }
        if (pages.length || all) {
            steps.push(() => {
                this._warmShown = island.warmView(expanded, true);
                expanded.warmTabs();
            });
            // Each page stays shown until the next step, so a frame lays it out too.
            pages.forEach((page, i) => steps.push(() => {
                if (!this._warmShown)
                    return;
                if (i)
                    expanded.warmPage(pages[i - 1], false);
                expanded.warmPage(page, true);
            }));
            steps.push(() => this._putAwayWarm());
        }
        const next = () => {
            // Opened meanwhile (see `_render`): the rest waits.
            if (this._presentation !== 'compact') {
                this._later('warm', WARM_START_MS, () => this._warmUp(all));
                return;
            }
            steps.shift()?.();
            if (steps.length) {
                this._later('warm', WARM_STEP_MS, next);
                return;
            }
            this._warmedAt = GLib.get_monotonic_time() / 1000;
            if (all)
                this._viewsWarm = true;
            this._scheduleWarm();
        };
        next();
    }

    /** Hides what `_warmUp` showed out of sight. */
    _putAwayWarm() {
        if (!this._warmShown)
            return;
        this._warmShown = false;
        this._expanded.hideWarmPages();
        this._island.warmView(this._expanded, false);
    }

    /** Lays out the pages that changed out of sight, once the island has rested closed a while. */
    _scheduleWarm() {
        if (this._presentation !== 'compact' || !this._island.mapped || this._timeouts.has('warm') ||
            !this._expanded.pages.some(page => page.cold && !page.hidden))
            return;
        const sinceLast = GLib.get_monotonic_time() / 1000 - (this._warmedAt ?? -Infinity);
        this._later('warm', Math.max(WARM_AFTER_CLOSE_MS, WARM_GAP_MS - sinceLast), () => this._warmUp(false));
    }

    /** The assistant's shape and colours, from Settings (see bot.js). */
    _readBotLook() {
        return {shape: this._settings.get_string('bot-shape'),
            palette: paletteFor(this._settings.get_string('bot-color'), this._settings.get_string('bot-glow'))};
    }

    /** Settings changed the bot: the voice view and the island's glow follow. */
    _syncBotLook() {
        this._botLook = this._readBotLook();
        this._voice.look = this._botLook;
        this._voice.chatLook = this._botLook;
        this._syncTint();
    }

    /** The island's colours for what it shows: the bot's glow, an alert's, or the open page's tint. */
    _syncTint() {
        const expanded = this._presentation === 'expanded';
        const voice = this._presentation === 'voice';
        // An alert that asks or tells what an agent did glows in its colours, still: drawn once.
        const glow = this._presentation === 'peek' ? this._alert?.glow : null;
        const tint = voice ? this._botLook.palette.glow : glow ?? (expanded ? this._expanded.tint : null);
        const style = voice || glow ? 'aura' : expanded ? this._expanded.tintStyle : null;
        if (glow && tint !== this._tint)
            this._island.setTintMotion(ALERT_GLOW_TIME, ALERT_GLOW_LEVEL);
        if (tint !== this._tint || style !== this._tintStyle) {
            this._tint = tint;
            this._tintStyle = style;
            this._island.setTint(tint, style);
        }
    }

    // Pointer

    /** Whether the pointer is on the island as a hover: not one it grew under that has not moved since. */
    get _pointerOn() {
        return this._island.hovered && !this._hoverUnmoved;
    }

    /** The pointer came or went: holds or times out alerts and answers, and opens or closes the island. */
    _onHoverChanged(moved = false) {
        const unmoved = this._hoverUnmoved;
        this._hoverUnmoved = false;
        this._cancel('hover');
        // Grown under a still pointer is no hover yet: it counts once the pointer moves (see `_hoverOnMove`).
        if (this._island.hovered && !moved && this._island.changedUnderPointer && !this._expandWanted) {
            this._hoverUnmoved = true;
            this._hoverOnMove(global.get_pointer());
            return;
        }
        if (!this._island.hovered && unmoved && !this._expandWanted)
            return;
        this._syncClose();
        // An answer stays while the pointer is on it, and as long again once it leaves. Peeked at by hovering
        // while it works, it goes back to the background as the pointer leaves.
        if (this._voiceOpen) {
            if (this._island.hovered) {
                this._cancel('voice-close');
                this._cancel('collapse');
            } else if (this._voicePeeked) {
                // Answered meanwhile, it closes on its own time instead (see `_onAssistant`).
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._voicePeeked && this.collapse());
            } else {
                this._scheduleVoiceClose(Math.min(this._voiceCloseMs, VOICE_LEAVE_MS));
            }
            return;
        }
        // An alert waits while the pointer is on it, as a notification should; not the volume's.
        if (this._alert && !this._alert.transient && this._presentation === 'peek') {
            if (this._island.hovered)
                this._cancel('alert');
            // One that waits for an answer (Allow) or a reminder (Join) keeps its own time; a notification goes
            // soon, its button with it, as one without does.
            else if (this._alert.sticky || this._alert.actions?.length || (this._alert.action && this._alert.kind !== 'notification'))
                this._timeAlert();
            else
                this._later('alert', Math.min(ALERT_LEAVE_MS, this._alert.duration ?? ALERT_LEAVE_MS),
                    () => this._dismissAlert(true));
        }
        if (this._island.hovered) {
            this._cancel('collapse');
            if (!this._expandWanted && this._settings.get_string('open-on') === 'hover' && !this._alertHoldsHover)
                this._expandOnRest();
        } else {
            this._cancel('expand');
            if (!this._expandWanted || this._keyboardGrab)
                return;
            // Shrinking under a still pointer is no reason to close: wait until it moves.
            if (this._island.changedUnderPointer)
                this._collapseOnMove(global.get_pointer());
            else
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        }
    }

    /** Opened by hovering and only showing its work: the pointer leaving puts it back in the background. Once
     * used (the conversation, typing, a click that took the keyboard) it stays. */
    get _voicePeeked() {
        return this._voiceByHover && VOICE_WORKING.includes(this._voice.phase) && !this._voice.chatOpen && !this._keyboardGrab;
    }

    /** Under the pointer, the × on an answer, and on an alert that hovering doesn't open (see `_expandOnRest`). */
    _syncClose() {
        const on = this._pointerOn;
        this._voice.pointerOn = on && this._presentation === 'voice';
        const opens = this._settings.get_string('open-on') === 'hover' && !this._alertHoldsHover;
        this._peek.showClose(on && this._presentation === 'peek' && !opens);
    }

    /** An alert with buttons (Join, Allow…), or one that opens no page (the assistant's answer), is on show: the
     * pointer goes there to press or read it, not to open the island. */
    get _alertHoldsHover() {
        const alert = this._alert;
        return this._presentation === 'peek' &&
            Boolean(alert?.action || alert?.actions?.length || (alert?.onActivate && !this._alertPage));
    }

    /** The page the alert shown opens, unless that page is left out in Settings. */
    get _alertPage() {
        const page = this._alert?.page;
        return page && !this._expanded.pageNamed(page)?.hidden ? page : null;
    }

    // Opens once the pointer rests on the island, so passing over it along the top bar opens nothing.
    _expandOnRest() {
        const [x, y] = global.get_pointer();
        this._later('expand', this._settings.get_int('hover-delay'), () => {
            if (this._alertHoldsHover)
                return;
            const [nowX, nowY] = global.get_pointer();
            // The assistant still at work: its progress, rather than the pages (as a click does).
            const rested = Math.hypot(nowX - x, nowY - y) <= px(REST_DISTANCE_PX);
            if (rested && this._voiceWorking)
                this._reopenVoice({byHover: true});
            else if (rested)
                this.expand();
            else if (this._island.hovered)
                this._expandOnRest();
        });
    }

    // Counts the pointer on the island as a hover once it moves from `[x, y]`.
    _hoverOnMove([x, y]) {
        this._later('hover', MOVE_CHECK_MS, () => {
            const [nowX, nowY] = global.get_pointer();
            if (Math.hypot(nowX - x, nowY - y) > px(REST_DISTANCE_PX))
                this._onHoverChanged(true);
            else
                this._hoverOnMove([x, y]);
        });
    }

    // Closes after the pointer, outside the island, moves away from `[x, y]`, or has rested there a while.
    _collapseOnMove([x, y], waited = 0) {
        this._later('collapse', MOVE_CHECK_MS, () => {
            const [nowX, nowY] = global.get_pointer();
            if (Math.hypot(nowX - x, nowY - y) > px(2) || waited >= STILL_OUTSIDE_MS)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
            else
                this._collapseOnMove([x, y], waited + MOVE_CHECK_MS);
        });
    }

    /** Closes, unless the pointer is on the shelf helper's window over the island. */
    _collapseUnlessHeld() {
        // The shelf helper window covers the island; the pointer may be on it.
        if (this._shelfHelper.containsPointer()) {
            this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
            return;
        }
        this.collapse();
    }

    /** What a click on the closed island does: an alert's own action, or else the island opens. */
    _openFromClosed() {
        // Clicking a notification opens it, like GNOME's banner did.
        if (!this._expandWanted && this._alert?.onActivate) {
            // Done with: the assistant it may open puts it back in line no more.
            this._alert.answered = true;
            this._alert.onActivate();
            this._dismissAlert(true);
            return Clutter.EVENT_STOP;
        }
        // isled down: why the island can do little, and how to fix it, rather than the pages.
        if (!this._expandWanted && this._compact.serviceDown) {
            this._post(Alerts.serviceDown(() => this._daemon.start()));
            return Clutter.EVENT_STOP;
        }
        // The assistant still at work: its progress, rather than the pages.
        if (!this._expandWanted && this._voiceWorking) {
            this._reopenVoice();
            return Clutter.EVENT_STOP;
        }
        if (!this._expandWanted) {
            this.expand();
            return Clutter.EVENT_STOP;
        }
        return Clutter.EVENT_PROPAGATE;
    }

    /** Over an alert, a swipe up puts it away and a swipe down opens it, as on a phone. */
    _onAlertScroll(event) {
        if (this._presentation !== 'peek' || !this._alert || this._expandWanted)
            return Clutter.EVENT_PROPAGATE;
        let step;
        switch (event.get_scroll_direction()) {
        case Clutter.ScrollDirection.UP:
            step = -1;
            break;
        case Clutter.ScrollDirection.DOWN:
            step = 1;
            break;
        case Clutter.ScrollDirection.SMOOTH: {
            const now = GLib.get_monotonic_time() / 1000;
            if (now - (this._swipe?.at ?? 0) > SWIPE_GAP_MS)
                this._swipe = {dy: 0, done: false};
            this._swipe.at = now;
            this._swipe.dy += event.get_scroll_delta()[1];
            if (this._swipe.done || Math.abs(this._swipe.dy) < ALERT_SWIPE)
                return Clutter.EVENT_STOP;
            // Once a swipe, however far it goes.
            this._swipe.done = true;
            step = Math.sign(this._swipe.dy);
            break;
        }
        default:
            return Clutter.EVENT_PROPAGATE;
        }
        // The click-style copies of a smooth scroll count once, as the smooth one.
        if (event.get_flags() & Clutter.EventFlags.POINTER_EMULATED)
            return Clutter.EVENT_STOP;
        // Content scrolls down with fingers moving up (and a wheel turned down): the alert goes up and away.
        if (step > 0)
            this._dismissAlert(true);
        else
            this._openFromClosed();
        return Clutter.EVENT_STOP;
    }

    /** A tap is a primary click, but for a button's own; opened by one, a tap elsewhere closes it. */
    _onTap(event) {
        if (event.type() !== Clutter.EventType.TOUCH_END)
            return Clutter.EVENT_PROPAGATE;
        for (let actor = global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords());
            actor && actor !== this._island; actor = actor.get_parent()) {
            if (actor instanceof St.Button)
                return Clutter.EVENT_PROPAGATE;
        }
        const wasOpen = this._expandWanted;
        const result = this._onClick(event, Clutter.BUTTON_PRIMARY);
        if (!wasOpen && this._expandWanted && !this._keyboardGrab)
            this._holdOpen();
        return result;
    }

    /** Left opens or acts, middle plays or pauses, right puts an alert away or brings the call or player forward. */
    _onClick(event, button = event.get_button()) {
        // A click puts an answer away; the face and the Sign in button take their own clicks.
        if (this._voiceOpen) {
            // Peeked at by hovering while it works, a click keeps it open, Esc putting it back.
            if (this._voicePeeked) {
                this._voiceByHover = false;
                this._setKeyboard(true);
            }
            if (!this._voiceAnswered || this._voice.chatOpen)
                return Clutter.EVENT_PROPAGATE;
            this.collapse();
            return Clutter.EVENT_STOP;
        }
        switch (button) {
        case Clutter.BUTTON_PRIMARY:
            return this._openFromClosed();
        case Clutter.BUTTON_MIDDLE:
            this._daemon.call('media', 'PlayPause');
            return Clutter.EVENT_STOP;
        case Clutter.BUTTON_SECONDARY:
            // On an alert: puts it away without opening what it is about.
            if (!this._expandWanted && this._alert) {
                this._dismissAlert(true);
                return Clutter.EVENT_STOP;
            }
            // Brings the call, or else the music player, to the front from the closed island
            // (the open one has its own controls, cards and fields).
            if (this._expandWanted)
                return Clutter.EVENT_PROPAGATE;
            if (this._call.active) {
                this._call.raise();
                return Clutter.EVENT_STOP;
            }
            if (!Playback.hasTrack(this._daemon.state.nowPlaying))
                return Clutter.EVENT_PROPAGATE;
            this.collapse();
            this._daemon.call('media', 'Raise');
            return Clutter.EVENT_STOP;
        default:
            return Clutter.EVENT_PROPAGATE;
        }
    }

    /** Opens the island, on `pageName` or the most useful page. */
    expand(pageName = null) {
        // An action finishing after Isle was turned off.
        if (this._destroying)
            return;
        // A close still pending (the pointer just left) would shut it again.
        this._cancel('expand');
        this._cancel('collapse');
        const target = pageName ?? this._alertPage ?? this._defaultPage();
        if (target)
            this._expanded.showPage(target, {animate: this._expandWanted});
        // Opening the island takes over from the alert being shown; one asking for an answer waits its turn.
        if (this._alert?.key?.startsWith('agent-ask:') || this._alert?.key?.startsWith('task-ask:'))
            this._shelveAlert();
        else
            this._dismissAlert(false);
        this._expandWanted = true;
        // Closed once it is open, a command still waiting for Run or Deny waits its turn as an alert.
        if (this._voiceOpen)
            this._closeVoice();
        this._render();
    }

    /** Closes the open island or the assistant, then shows what waited. */
    collapse() {
        if (this._destroying)
            return;
        this._cancel('collapse');
        this._setKeyboard(false);
        // Once closed and settled, what changed meanwhile is laid out for next time (see `_warmUp`); the
        // alert and voice views keep their layout, unless the theme changed.
        this._later('warm', WARM_AFTER_CLOSE_MS, () => this._warmUp(!this._viewsWarm));
        if (this._voiceOpen) {
            this._closeVoice();
            this._nextAlert();
            return;
        }
        if (!this._expandWanted)
            return;
        this._expandWanted = false;
        this._nextAlert();
    }

    /** The page to open on: the one picked lately by hand, else one with something live, else music. */
    _defaultPage() {
        if (Date.now() - this._pagePickedAt < PAGE_MEMORY_MS)
            return null; // stay on the current page
        const page = DEFAULT_PAGE_ORDER.map(name => this._expanded.pageNamed(name)).find(p => p?.available && p.relevant);
        return page?.name ?? this._expanded.pages.find(p => p.available)?.name ?? null;
    }

    // Keyboard

    // Super+V (GNOME's calendar shortcut, taken over) opens the clipboard history, search ready, and
    // holds the island open without the pointer; Super+V again, Esc or a click elsewhere closes it.
    _toggleFromKeyboard() {
        // Hidden by a fullscreen window, it would take the keyboard unseen.
        if (!this._island.visible)
            return;
        if (this._expandWanted && this._keyboardGrab) {
            this.collapse();
            return;
        }
        this._shelf.showTab('clipboard');
        this.expand('shelf');
        this._holdOpen();
        if (this._keyboardGrab)
            this._shelf.showTab('clipboard', {focusSearch: true});
    }

    /** Opened without the pointer, it takes the keyboard: Esc or a click elsewhere closes it. */
    _holdOpen() {
        this._setKeyboard(true);
        if (!this._keyboardGrab) // another grab holds the keyboard: it closes once the pointer is not on it
            this._later('collapse', KEYBOARD_LESS_CLOSE_MS, () => {
                if (!this._island.hovered)
                    this._collapseUnlessHeld();
            });
    }

    /** Grabs the keyboard for typing into the island (e.g. a new task). */
    _setKeyboard(wanted) {
        if (wanted && !this._keyboardGrab) {
            const grab = Main.pushModal(this._island, {actionMode: Shell.ActionMode.POPUP});
            // Another grab (a menu, a dialog) may hold the keyboard already.
            if (!grabsKeyboard(grab)) {
                Main.popModal(grab);
                return;
            }
            this._keyboardGrab = grab;
            // Clicking anywhere else ends typing and closes the island.
            this._stageCapture = global.stage.connect('captured-event', (_stage, event) => {
                // The shelf helper's window lies over the island: inside too.
                const press = [Clutter.EventType.BUTTON_PRESS, Clutter.EventType.TOUCH_BEGIN].includes(event.type());
                if (press && !this._shelfHelper.containsPointer() &&
                    !this._island.contains(global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...event.get_coords()))) {
                    this.collapse();
                }
                return Clutter.EVENT_PROPAGATE;
            });
        } else if (!wanted && this._keyboardGrab) {
            // Clear the grab first: releasing it moves key focus, which can
            // make a text field ask to release it again.
            const grab = this._keyboardGrab;
            this._keyboardGrab = null;
            global.stage.disconnect(this._stageCapture);
            Main.popModal(grab);
            // Left during the grab, the pointer told the island nothing: an alert would wait for it forever.
            // Read now, so the alert shown next is timed by where the pointer really is.
            this._island.syncHover();
            // An open assistant closes on its own timer.
            if (!this._island.hovered && !this._voiceOpen)
                this._later('collapse', COLLAPSE_DELAY_MS, () => this._collapseUnlessHeld());
        }
    }

    // Alerts

    /** Shows `alert` now, or queues it behind the one on screen. */
    _post(alert) {
        if (!alert)
            return;
        // Hidden by a fullscreen window: shown once it is gone, but a volume or Caps Lock change is stale by then.
        if (!this._island.visible) {
            if (!alert.transient)
                this._enqueue(alert);
            return;
        }
        if (this._alert && this._alert.key === alert.key) {
            this._showAlert(alert, {inPlace: true});
            return;
        }
        if (this._expandWanted || this._voiceOpen) {
            // Volume and the like are stale by the time the island closes.
            if (!alert.transient)
                this._enqueue(alert);
            return;
        }
        if (this._alert && alert.priority !== 'instant') {
            this._enqueue(alert);
            return;
        }
        // Shown again afterwards, unless it was a passing one (the volume) or answered; a critical notification stays.
        this._shelveAlert();
        this._showAlert(alert);
    }

    /** A system alert of `category` (power, network, bluetooth, caps-lock), if wanted; only a low battery gets
     * through Do Not Disturb. */
    _postSystemAlert(alert, category, urgent = false) {
        if (!alert || !this._settings.get_boolean(`alert-${category}`))
            return;
        if (this._notifications.dnd && !urgent)
            return;
        this._post(alert);
    }

    /** Queues `alert`, replacing one with its key; past a few waiting notifications, they merge into a summary. */
    _enqueue(alert) {
        this._queue = this._queue.filter(queued => queued.key !== alert.key);
        this._queue.push(alert);
        // Many notifications waiting (a long fullscreen video) come as one; each stays unread in the list.
        // With no list (the Notifications page left out), each comes on its own, to be read and clicked.
        if (this._expanded.pageNamed('notifications').hidden)
            return;
        const waiting = this._queue.filter(queued => queued.kind === 'notification' && queued.priority !== 'instant');
        const summary = this._queue.find(queued => queued.key === 'notifications-summary');
        if (waiting.length > (summary ? 0 : MAX_QUEUED_NOTIFICATIONS)) {
            // Counted once each, however often one was updated meanwhile.
            const items = new Set([...summary?.items ?? [], ...waiting.map(queued => queued.item)]);
            this._queue = this._queue.filter(queued => !waiting.includes(queued) && queued !== summary);
            this._queue.push(Alerts.notificationsSummary(items));
        }
    }

    /** `inPlace` for a newer version of the alert on screen (the volume moving): it doesn't animate in again. */
    _showAlert(alert, {inPlace = false} = {}) {
        // Another alert on screen takes the other view; the same one (the volume moving) updates in place.
        if (this._presentation === 'peek' && this._shownAlertKey !== alert.key)
            this._peek = this._peeks[1 - this._peeks.indexOf(this._peek)];
        this._shownAlertKey = alert.key;
        this._alert = alert;
        try {
            if (!alert.shown) {
                alert.shown = true;
                alert.onShown?.();
            }
            // Its button does what it says, and that is the end of the alert (not of one fading in over it).
            this._peek.setAlert(alert, () => {
                if (this._alert === alert)
                    this._dismissAlert(true);
            }, {fresh: !inPlace});
        } catch (e) {
            // One that can't be shown must not hold up those behind it, never timed out.
            console.warn(`Isle: could not show an alert: ${e.message}`);
            this._alert = null;
            this._shownAlertKey = null;
            this._nextAlert();
            return;
        }
        this._timeAlert();
        this._render();
        // Parts shown for the first time are only measured right once styled;
        // fit the island again then.
        this._later('alert-fit', ALERT_FIT_DELAY_MS, () => {
            if (this._presentation === 'peek')
                this._render();
        });
    }

    // An alert goes after its time; a sticky one (a reminder) only counts it while someone is there.
    _timeAlert() {
        const alert = this._alert;
        if (!alert)
            return;
        // Not while someone reads it (see `_onHoverChanged`), nor while no one is there for a sticky one.
        if ((this._pointerOn && !alert.transient) || (alert.sticky && this._compact.idle)) {
            this._cancel('alert');
            return;
        }
        this._later('alert', alert.duration ?? 3000, () => this._dismissAlert(true));
    }

    /** Puts the alert away; with `showNext`, the next in line comes on. */
    _dismissAlert(showNext) {
        this._cancel('alert');
        // Put away without an answer, it says so (an agent then asks in its terminal).
        if (this._alert && !this._alert.answered)
            this._alert.onDismissed?.();
        this._alert = null;
        if (showNext)
            this._nextAlert();
    }

    /** Puts the alert on screen back first in line, not put away (an agent's ask keeps waiting for its answer);
     * a passing or answered one just goes. */
    _shelveAlert() {
        const alert = this._alert;
        this._cancel('alert');
        this._alert = null;
        if (alert && !alert.transient && !alert.answered)
            this._queue.unshift(alert);
    }

    // Hidden by a fullscreen window: an agent's ask goes to its terminal, as one asked now would (see
    // `_onAgentAsking`); the alert on screen waits to be seen, its time not running out unseen.
    _onHidden() {
        this._passAgentAsks();
        this._shelveAlert();
        this._render();
    }

    /** The agents' asks on screen or waiting, unanswered, go back to their terminals. */
    _passAgentAsks() {
        const asks = [this._alert, ...this._queue].filter(alert => alert?.onDismissed && !alert.answered);
        this._queue = this._queue.filter(alert => !asks.includes(alert));
        for (const alert of asks) {
            alert.answered = true;
            alert.onDismissed();
        }
    }

    /** Shows the first alert in line that still has something to say, once nothing else is on screen. */
    _nextAlert() {
        // One shows already (the command asked as the assistant closed): the queue waits behind it.
        if (this._alert || !this._island.visible || this._expandWanted || this._voiceOpen || !this._queue.length) {
            this._render();
            return;
        }
        // What waited may have been read, withdrawn or become private meanwhile.
        while (this._queue.length) {
            const queued = this._queue.shift();
            const alert = queued.fresh ? queued.fresh(this._sharing) : queued;
            if (alert) {
                this._showAlert(alert);
                return;
            }
        }
        this._render();
    }

    /** Volume or brightness as an alert in place of GNOME's OSD; false lets GNOME show its own. */
    _showOsd(icon, label, level, maxLevel) {
        if (!this._settings.get_boolean('replace-osd') || !this._island.visible)
            return false;
        // Working on another display, the user would not see it: GNOME shows its own there.
        if (Main.layoutManager.monitors.length > 1 && global.display.get_current_monitor() !== this._monitor?.index)
            return false;
        // While the island is open the OSD would cover it; let GNOME show it.
        if (this._expandWanted || this._voiceOpen)
            return false;
        const alert = Alerts.osd(icon, label, level, maxLevel);
        // Pressing on at 0% or 100% stretches the island like a rubber band.
        const atLimit = alert.level !== null && (alert.level >= 1 || alert.level <= 0);
        const repeated = this._alert?.key === 'osd' && this._alert.title === alert.title &&
            this._alert.level === alert.level;
        this._post(alert);
        if (atLimit && repeated)
            this._island.nudge();
        return true;
    }

    /** A new song that starts playing peeks in, if Settings want that. */
    _onNowPlaying() {
        const nowPlaying = this._daemon.state.nowPlaying;
        const track = Playback.hasTrack(nowPlaying) ? `${nowPlaying.title}\u001f${nowPlaying.artist}` : null;
        const changed = track !== this._lastTrack;
        this._lastTrack = track;
        if (changed && track && Playback.isPlaying(nowPlaying) && this._settings.get_boolean('track-peek') &&
            !this._notifications.dnd && !this._expanded.pageNamed('music').hidden)
            this._post(Alerts.track(nowPlaying));
    }

    // isled gone (a crash, or stopped by hand): started again once; still gone, the island says so and offers
    // to restart it, with a warning on the closed island meanwhile.
    _onServiceChanged() {
        if (this._daemon.running) {
            this._cancel('service-check');
            this._compact.serviceDown = false;
            if (this._alert?.key === 'service-down')
                this._dismissAlert(true);
            this._queue = this._queue.filter(queued => queued.key !== 'service-down');
            return;
        }
        this._later('service-check', SERVICE_GRACE_MS, () => {
            this._daemon.start();
            this._later('service-check', SERVICE_GRACE_MS, () => {
                if (this._daemon.running)
                    return;
                this._compact.serviceDown = true;
                this._post(Alerts.serviceDown(() => this._daemon.start()));
            });
        });
    }

    /** Whether others may see the screen now: shared, or recorded. */
    get _sharing() {
        return this._privacy.screenShare || this._privacy.recording;
    }

    /** While others can see the screen, private text leaves the shelf, the notifications and the alert shown. */
    _syncSharing() {
        this._shelf.sharing = this._sharing;
        this._expanded.pageNamed('notifications').sharing = this._sharing;
        // A message on screen as sharing starts loses its text at once; one gone meanwhile goes.
        const redone = this._alert?.fresh?.(this._sharing);
        if (this._alert?.fresh && !redone)
            this._dismissAlert(true);
        else if (redone && redone !== this._alert)
            this._showAlert(redone, {inPlace: true});
    }

    // Updates

    /** Tells isled whether to look for new versions. */
    _syncUpdates() {
        this._daemon.call('updates', 'SetEnabled', this._settings.get_boolean('check-updates'));
    }

    /** A newer Isle is out: said once per version; in Do Not Disturb, next time Isle starts. */
    _onLatest() {
        const latest = this._daemon.state.updates;
        if (!latest || latest === this._settings.get_string('update-shown') || this._notifications.dnd)
            return;
        this._settings.set_string('update-shown', latest);
        // Settings' About page has the Update button (or, for a package, how to update it).
        this._post(Alerts.update(latest, () => {
            this._settings.set_string('prefs-page', 'about');
            this._extension.openPreferences();
        }, this._extension.path.startsWith('/usr/')));
    }

    // Usage

    /** Sends the usage settings to isled, and the warning marks to the page. */
    _syncUsage() {
        const config = {
            enabled: this._settings.get_boolean('usage-enabled'),
            claude: this._settings.get_boolean('usage-claude'),
            codex: this._settings.get_boolean('usage-codex'),
            grok: this._settings.get_boolean('usage-grok'),
            // Off, a plan seen there starts no AI to list its models.
            assistant: this._settings.get_boolean('voice-assistant'),
            warn: this._settings.get_int('usage-warn'),
            critical: this._settings.get_int('usage-critical'),
        };
        this._expanded.pageNamed('usage')?.setMarks(config.warn, config.critical);
        this._daemon.call('usage', 'SetConfig', JSON.stringify(config));
    }

    // Voice

    /** Binds the shortcut and shows the mic button while the assistant is turned on. */
    _syncVoiceEnabled() {
        const enabled = this._settings.get_boolean('voice-assistant');
        if (enabled && !this._voiceBound) {
            Main.wm.addKeybinding('voice-shortcut', this._settings, Meta.KeyBindingFlags.IGNORE_AUTOREPEAT,
                Shell.ActionMode.NORMAL | Shell.ActionMode.OVERVIEW | Shell.ActionMode.POPUP,
                () => this._onVoiceKey());
        } else if (!enabled && this._voiceBound) {
            Main.wm.removeKeybinding('voice-shortcut');
            if (this._voiceOpen)
                this.collapse();
            // Turned off, a request at work is stopped: the island would show it, and open on nothing else.
            this._closedListeningAt = 0;
            if (this._voiceInBackground) {
                this._deciding?.done(false);
                this._daemon.call('assistant', 'Cancel');
                this._voiceInBackground = false;
                this._syncAssistantBusy();
            }
        }
        this._voiceBound = enabled;
        if (enabled)
            this._viewsWarm = false;
        this._expanded.voiceEnabled = enabled;
        this._voice.shortcut = this._voiceShortcut;
    }

    // The shortcut (or the face) opens the assistant listening; while listening it finishes,
    // and once answered it listens again for a follow-up.
    _onVoiceKey() {
        // Hidden by a fullscreen window: it would listen unseen.
        if (!this._island.visible)
            return;
        if (!this._voiceOpen) {
            // A request still at work shows its progress; a new one waits until it is done.
            if (this._voiceWorking)
                this._reopenVoice();
            else
                this._openVoice();
            return;
        }
        // isled's phase, not the view's: the view says listening before isled has started.
        const phase = this._daemon.state.assistant?.phase;
        if (phase === 'listening')
            this._daemon.call('assistant', 'Stop');
        else if (this._voiceAnswered) {
            this._autoListens = 0;
            this._listen();
        }
    }

    // Opened by Super+I it listens; with `typing` (opened with the mouse) the field is ready instead, and an
    // ongoing conversation shows above it.
    _openVoice({typing = false} = {}) {
        if (!this._voiceBound)
            return;
        // Opened again before the last answer's actions ran: they belonged to that one.
        this._cancel('voice-after');
        this._voiceAfter = [];
        this._voiceTarget = global.display.focus_window;
        this._cancel('expand');
        this._cancel('collapse');
        this._expandWanted = false;
        this._shelveAnswer();
        this._voiceOpen = true;
        this._voiceByHover = false;
        this._voiceInBackground = false;
        this._voiceTurn = this._daemon.state.assistant?.turn ?? 0;
        this._voiceStep = this._daemon.state.assistant?.step ?? 0;
        this._autoListens = 0;
        // The conversation open last time stays shut, unless opened with the mouse (just below).
        this._voice.closeChat();
        if (!typing) {
            this._listen({greet: true});
            return;
        }
        this._startTyping('');
        this._warm();
        if (this._history.length) {
            this._voice.setHistory(this._history);
            this._voice.openChat();
        }
    }

    /** The AI starts as the field opens, ready by the time the request is typed (see `Warm` in isled). */
    async _warm() {
        try {
            const json = await voiceContext(this._settings, this._notifications,
                {apps: this._installedApps.names, selectedIn: this._selectedIn});
            this._daemon.call('assistant', 'Warm', json);
        } catch (e) {
            console.warn(`Isle: could not get the AI ready: ${e.message}`);
        }
    }

    /** Types the request instead of saying it: listening stops (speech recognition never starts). */
    _startTyping(initial) {
        // Closed, it would take the keyboard from the windows unseen.
        if (!this._voiceOpen)
            return;
        this._voiceByHover = false;
        if (this._listenSent || this._daemon.state.assistant?.phase === 'listening')
            this._daemon.call('assistant', 'Cancel');
        this._listenSent = false;
        this._listenRequest++;
        this._cancel('voice-close');
        this._cancel('voice-listen');
        this._setKeyboard(true);
        this._voice.followUp = null;
        this._voice.greeting = null;
        this._voice.startTyping(initial, this._daemon.state.assistant?.card);
        this._render();
    }

    /** Asks a typed request, with what the island knows, as `_listen` does for a spoken one. */
    async _ask(text) {
        this._askedTyped = true;
        // In the conversation, what was sent shows at once, as in Messages; isled's own copy replaces it.
        if (this._voice.chatOpen)
            this._voice.setHistory([...this._history, {role: 'user', text, at: Date.now()}]);
        const request = ++this._listenRequest;
        this._voice.setState({phase: 'thinking', heard: text});
        this._render();
        let json;
        try {
            json = await voiceContext(this._settings, this._notifications,
                {apps: this._installedApps.names, selectedIn: this._selectedIn});
        } catch (e) {
            console.warn(`Isle: could not gather the request's context: ${e.message}`);
            json = JSON.stringify({...aiSettings(this._settings), actions: actionTypes(this._settings)});
        }
        if (this._voiceOpen && request === this._listenRequest)
            this._sendRequest(request, 'Ask', text, json);
    }

    // Sends a request to isled; not running (or refusing it), it would never answer, so the island says so
    // rather than listen or think forever.
    async _sendRequest(request, method, ...args) {
        this._sentRequest = request;
        const {result, error} = await this._daemon.attempt('assistant', method, ...args);
        if (result || request !== this._listenRequest)
            return;
        // Closed meanwhile: nothing carries on in the background.
        if (!this._voiceOpen) {
            this._voiceInBackground = false;
            this._syncAssistantBusy();
            return;
        }
        const why = error || (this._daemon.running ? 'Isle couldn’t take that' : 'Isle’s service isn’t running');
        this._listenSent = false;
        this._voice.setState({phase: 'error', error: why, hint: this._askAgainHint});
        this._setKeyboard(false);
        this._render();
        this._scheduleVoiceClose(VOICE_ERROR_MS);
    }

    // As the assistant opens: an answer of its own on show has been seen, so it goes rather than come back
    // once the assistant closes; any other alert waits its turn.
    _shelveAnswer() {
        if (this._alert?.key === 'assistant')
            this._alert.answered = true;
        this._shelveAlert();
    }

    /** Shows the assistant again as it is (at work, or with the answer it came to), without listening; `byHover`
     * only while the pointer rests on it, the keyboard left to the app. */
    _reopenVoice({byHover = false} = {}) {
        const state = this._daemon.state.assistant;
        if (!this._voiceBound || !state)
            return;
        // Ended since (another request, or isled restarted), there is nothing to show again: the conversation.
        if (!['reply', 'error', ...VOICE_WORKING].includes(state.phase)) {
            this._openVoice({typing: true});
            return;
        }
        this._cancel('expand');
        this._cancel('collapse');
        this._expandWanted = false;
        this._shelveAnswer();
        this._voiceOpen = true;
        this._voiceByHover = byHover;
        this._voiceInBackground = false;
        this._voiceTarget = global.display.focus_window;
        this._voice.followUp = null;
        this._voice.greeting = null;
        // Its progress or answer in the pill; the chevron opens the conversation.
        this._voice.closeChat();
        this._voice.setState(state);
        this._syncAssistantBusy();
        // At work, Esc and clicks elsewhere put it back in the background, and Enter or Esc answer its card.
        if (VOICE_WORKING.includes(state.phase) && !byHover)
            this._setKeyboard(true);
        this._render();
        if (this._voiceAnswered)
            this._scheduleVoiceClose(VOICE_READ_MS.max);
    }

    /** The assistant's shortcut as people write it, or '' when it has none. */
    get _voiceShortcut() {
        return Format.shortcutLabel(this._settings.get_strv('voice-shortcut')[0] ?? '');
    }

    /** How to ask again, under an error: the shortcut, if there is one. */
    get _askAgainHint() {
        return this._voiceShortcut ? `Press ${this._voiceShortcut} to ask again.` : 'Ask again from the mic in the island.';
    }

    /** Whether the assistant works on a request with the island closed. */
    get _voiceWorking() {
        return this._voiceInBackground && VOICE_WORKING.includes(this._daemon.state.assistant?.phase);
    }

    /** The closed island shows the assistant at work. */
    _syncAssistantBusy() {
        this._compact.assistantBusy = this._voiceWorking;
    }

    /** Shows "Listening…" and sends isled a Listen with the request's context; `greet` for a conversation's first. */
    async _listen({greet = false} = {}) {
        this._voiceByHover = false;
        this._askedTyped = false;
        // Read before the keyboard is taken, while the selection is surely the app's.
        // The app list only matters to a conversation's first request.
        const apps = greet ? this._installedApps.names : [];
        const context = voiceContext(this._settings, this._notifications, {apps, selectedIn: this._selectedIn});
        const request = ++this._listenRequest;
        this._cancel('voice-close');
        this._cancel('voice-listen');
        // A follow-up shows what was just said back, one dim line above "Listening…".
        this._voice.followUp = greet ? null : Format.answerPlain(this._voice.exchange?.reply ?? '') || null;
        // Esc and clicks elsewhere close it while it listens and thinks.
        this._setKeyboard(true);
        this._voice.greeting = greet ? GREETING : null;
        this._voice.micWaiting = false;
        this._voice.setState({phase: 'listening'});
        // Not recording yet after a moment (isled getting the AI or the speech model ready): it says so.
        this._later('mic-wait', MIC_WAIT_MS, () => {
            if (this._voiceOpen && request === this._listenRequest && this._voice.phase === 'listening')
                this._voice.micWaiting = true;
        });
        this._render();
        let json;
        try {
            json = await context;
        } catch (e) {
            // Never left listening for nothing: ask without the extras.
            console.warn(`Isle: could not gather the request's context: ${e.message}`);
            json = JSON.stringify({
                ...aiSettings(this._settings),
                actions: actionTypes(this._settings),
                whisper_model: this._settings.get_string('voice-speech-model'),
                language: this._settings.get_string('voice-language'),
            });
        }
        // Closed, or asked to listen again, meanwhile.
        if (this._voiceOpen && request === this._listenRequest) {
            this._listenSent = true;
            this._sendRequest(request, 'Listen', json);
        }
    }

    /** Follows isled's assistant: shows each phase, runs the answer's actions, and closes or alerts once done. */
    _onAssistant() {
        const state = this._daemon.state.assistant;
        if (!state)
            return;
        // Built again (turned back on after a lock) while a request was at work: it carries on as if asked with the
        // island closed. A batch isled still waits on is told as cut short, never run twice (it may have happened).
        if (!this._assistantSeen) {
            this._assistantSeen = true;
            if (!this._voiceOpen && VOICE_WORKING.includes(state.phase)) {
                this._voiceInBackground = true;
                this._voiceTurn = state.turn ?? 0;
                this._voiceStep = state.step ?? 0;
                if (state.phase === 'acting') {
                    const detail = 'Isle was restarted (the screen locked) while this ran; it may not have happened';
                    this._daemon.call('assistant', 'Results', state.step,
                        JSON.stringify((state.actions ?? []).map(action => ({type: action.type, ok: false, detail}))));
                }
            }
        }
        // Closed as the last words were heard, isled had just begun on them unseen (its state lags a moment):
        // the request carries on as one closed while at work, its actions run and its answer told.
        if (!this._voiceOpen && !this._voiceInBackground && VOICE_WORKING.includes(state.phase) &&
            Date.now() - this._closedListeningAt < CLOSED_LISTENING_MS) {
            this._closedListeningAt = 0;
            this._voiceInBackground = true;
        }
        const ours = this._voiceOpen || this._voiceInBackground;
        // Actions it takes mid-way, open or closed: each batch once, and what they did goes back.
        if (ours && state.phase === 'acting' && state.step !== this._voiceStep) {
            this._voiceStep = state.step;
            const step = state.step;
            runActions(state.actions, this._voiceActions()).then(results =>
                this._daemon.call('assistant', 'Results', step, JSON.stringify(results)));
        }
        this._syncAssistantBusy();
        if (!this._voiceOpen) {
            this._onAssistantInBackground(state);
            return;
        }
        if (state.phase === 'idle')
            return;
        if (state.phase === 'listening')
            this._micReady();
        // Typing: the listening it stopped may still report in, "Didn't catch that" too.
        const stopped = ['listening', 'transcribing'].includes(state.phase) || (state.phase === 'error' && state.heard_nothing);
        if (this._voice.typing && stopped)
            return;
        // Nothing said back to a follow-up: it just closes, no error.
        if (state.phase === 'error' && state.heard_nothing && this._voice.followUp) {
            this.collapse();
            return;
        }
        this._voice.setState(state);
        this._render();
        // New text is only measured right once styled; fit the island again then.
        this._later('voice-fit', ALERT_FIT_DELAY_MS, () => {
            if (this._presentation === 'voice')
                this._render();
        });
        // Once answered, typing goes back to the windows; the answer closes on its own.
        if (state.phase === 'reply' || state.phase === 'error') {
            this._listenSent = false;
            this._setKeyboard(false);
        }
        if (state.phase === 'reply' && state.turn !== this._voiceTurn) {
            this._voiceTurn = state.turn;
            runActions(state.actions, this._voiceActions());
            // In the conversation the answer is already in the list: the field is ready for the next word.
            if (this._voice.chatOpen && !state.listen) {
                // Not once closed meanwhile (Esc, or an action that closes it first, as `write` does).
                this._later('chat-type', CHAT_TYPE_AGAIN_MS, () => this._voiceOpen && this._voice.chatOpen && this._startTyping(''));
            } else if (state.listen && this._autoListens < VOICE_MAX_AUTO_LISTENS) {
                this._autoListens++;
                // Asked something back: listen for the reply without a key press.
                this._later('voice-listen', VOICE_LISTEN_AGAIN_MS, () => {
                    if (this._voiceOpen && this._voice.phase === 'reply')
                        this._listen();
                });
            } else {
                const {base, perChar, max} = VOICE_READ_MS;
                this._scheduleVoiceClose(state.actions?.length ? VOICE_DONE_MS
                    : Math.min(max, base + perChar * (state.reply?.length ?? 0)));
            }
        } else if (state.phase === 'error') {
            // Long enough to reach the Sign in button.
            this._scheduleVoiceClose(state.sign_in || state.set_up ? VOICE_READ_MS.max : VOICE_ERROR_MS);
        }
    }

    // Answered with the island closed: its actions run, and the answer (or what went wrong) shows as an
    // alert, which opens it in full.
    _onAssistantInBackground(state) {
        if (!this._voiceInBackground)
            return;
        if (state.phase === 'reply' && state.turn !== this._voiceTurn) {
            this._voiceTurn = state.turn;
            runActions(state.actions, this._voiceActions());
        } else if (state.phase !== 'error') {
            return;
        }
        this._voiceInBackground = false;
        this._syncAssistantBusy();
        // Closed as it turned what was said into text, and nothing was: there is nothing to tell.
        if (state.phase === 'error' && state.heard_nothing)
            return;
        this._post(Alerts.assistant({...state, hint: this._voice.withShortcut(state.hint ?? '')}, () => this._reopenVoice()));
    }

    /** isled records (it said so, or sound comes in): "Listening…" again (see `micWaiting` in voice.js). */
    _micReady() {
        this._cancel('mic-wait');
        this._voice.micWaiting = false;
    }

    /** The conversation, as isled keeps it (see chat.rs). */
    get _history() {
        return Array.isArray(this._daemon.state.chat) ? this._daemon.state.chat : [];
    }

    /** The conversation changed; one brought back by Undo opens again. */
    _onHistory() {
        this._voice.setHistory(this._history);
        if (this._openWhenBack) {
            this._cancel('chat-undo');
            this._openWhenBack = false;
            if (this._voiceOpen)
                this._voice.openChat();
        }
    }

    // +: isled starts a new conversation; Undo brings the old one back for a moment, then it is deleted.
    _newChat() {
        this._openWhenBack = false;
        this._daemon.call('assistant', 'NewChat');
        this._voice.showUndo(true);
        this._later('chat-undo', UNDO_MS, () => this._voice.showUndo(false));
    }

    /** Asks isled for the old conversation back, opening it when it comes (see `_onHistory`). */
    _undoNewChat() {
        this._openWhenBack = true;
        // Not back by then (isled busy, or it dropped it), it never pops open on a later change.
        this._later('chat-undo', UNDO_MS, () => (this._openWhenBack = false));
        this._daemon.call('assistant', 'UndoNewChat');
    }

    // A command the AI wants run waits for Run or Deny: on its card while the island shows the assistant,
    // else in an alert. Resolves true for Run, false for Deny, and 'unanswered' after APPROVAL_MS.
    _decide(action) {
        return new Promise(resolve => {
            const entry = {
                id: action.id,
                action,
                done: run => {
                    if (this._deciding !== entry)
                        return;
                    this._deciding = null;
                    this._cancel('decide');
                    this._withdrawAlert(`task-ask:${action.id}`);
                    resolve(run);
                },
            };
            this._deciding?.done(false);
            this._deciding = entry;
            this._later('decide', APPROVAL_MS, () => entry.done('unanswered'));
            if (this._voiceOpen)
                this._setKeyboard(true);
            else
                this._askInAlert(action);
        });
    }

    /** Run or Deny for the command, as an alert while the island is closed. */
    _askInAlert(action) {
        // Its buttons answer its own command, never one asked after it.
        this._post(Alerts.taskAsks(action, this._botLook, run => this._deciding?.action === action && this._deciding.done(run)));
    }

    /** Takes the alert with `key` away, shown or waiting its turn; one answered on screen goes once its answer
     * has shown ("Running"). */
    _withdrawAlert(key) {
        this._queue = this._queue.filter(alert => alert.key !== key);
        if (this._alert?.key === key && !this._alert.answered) {
            this._alert.answered = true;
            this._dismissAlert(true);
        }
    }

    // Claude Code or Codex asks a permission: an alert to answer it, unless the user would not see it
    // (its window in front, Do Not Disturb, alerts off); then it asks in its own terminal.
    _onAgentAsking(request) {
        const now = Date.now();
        for (const [key, at] of this._askedAt) {
            if (now - at > ASKED_RECENTLY_MS)
                this._askedAt.delete(key);
        }
        this._askedAt.set(`${request.provider}:${request.session}`, now);
        const pass = () => this._daemon.call('agents', 'Resolve', request.id, '');
        if (!this._alertsOn(request.provider) || this._notifications.dnd ||
            !this._island.visible)
            return pass();
        const window = this._agentWindow(request);
        if (window && window === global.display.focus_window)
            return pass();
        const alert = Alerts.agentAsks(request, this._botLook,
            answer => this._daemon.call('agents', 'Resolve', request.id, answer));
        // Put away unanswered: the terminal asks instead.
        alert.onDismissed = pass;
        alert.agentWindow = window;
        return this._post(alert);
    }

    // Gone to the agent's own window while its ask waits here: it asks there instead (Codex shows its
    // prompt only once Isle lets go).
    _passToAgentWindow(focus) {
        if (!focus)
            return;
        const asks = [this._alert, ...this._queue].filter(alert => alert?.agentWindow === focus);
        for (const alert of asks) {
            this._withdrawAlert(alert.key);
            alert.onDismissed?.();
        }
    }

    /** An answer or an error is on show, no longer listening or thinking. */
    get _voiceAnswered() {
        return ['reply', 'error'].includes(this._voice.phase);
    }

    // isled restarted (an update) or stopped while listening or thinking: it will never answer, so
    // the island says so rather than wait forever.
    _onAssistantLost() {
        // Its request is gone, so is a command card waiting for it.
        this._deciding?.done(false);
        // isled counts its answers and batches of actions from 0 again.
        this._voiceTurn = 0;
        this._voiceStep = 0;
        if (this._voiceInBackground) {
            this._voiceInBackground = false;
            this._syncAssistantBusy();
            this._post(Alerts.assistant({phase: 'error', error: 'Isle restarted', hint: this._askAgainHint},
                () => this._openVoice()));
            return;
        }
        if (!this._voiceOpen || !['listening', ...VOICE_WORKING].includes(this._voice.phase))
            return;
        this._voice.setState({phase: 'error', error: 'Isle restarted', hint: this._askAgainHint});
        this._setKeyboard(false);
        this._render();
        this._scheduleVoiceClose(VOICE_ERROR_MS);
    }

    /** Closes an answer after `ms`, unless the pointer is on it or the conversation is open. */
    _scheduleVoiceClose(ms) {
        this._voiceCloseMs = ms;
        // An action may have closed it already; an open conversation stays until put away.
        if (!this._voiceOpen || this._voice.chatOpen)
            return;
        if (this._voiceAnswered && !this._pointerOn)
            this._later('voice-close', ms, () => this.collapse());
    }

    /** What the assistant's actions act on; see `ACTIONS` in voice.js. */
    _voiceActions() {
        return {
            daemon: this._daemon,
            audio: this._audio,
            notifications: this._notifications,
            target: this._voiceTarget,
            writer: this._writer,
            decide: action => this._decide(action),
            // The answer shows for a moment, then the page.
            showNotifications: () => this._later('voice-page', 1200, () => {
                // Left out in Settings meanwhile: the answer stays.
                if (this._expanded.pageNamed('notifications').hidden)
                    return;
                this.expand('notifications');
                if (!this._island.hovered && !this._keyboardGrab)
                    this._holdOpen();
            }),
            // Closed first, so the island is not in a screenshot or over the lock screen.
            // Every close-first action of an answer runs, in order, once the island has closed.
            closeThen: callback => {
                this._voiceAfter.push(callback);
                this.collapse();
                this._later('voice-after', 450, () => {
                    const callbacks = this._voiceAfter;
                    this._voiceAfter = [];
                    callbacks.forEach(run => run());
                });
            },
        };
    }

    /** Ends the conversation: the AI and the speech model quit until next time. */
    _closeVoice() {
        this._cancel('voice-close');
        this._cancel('voice-listen');
        this._cancel('chat-type');
        this._cancel('voice-page');
        this._voiceOpen = false;
        this._voiceByHover = false;
        this._micReady();
        this._listenSent = false;
        // A command still waiting for Run or Deny is asked in an alert now.
        if (this._deciding)
            this._askInAlert(this._deciding.action);
        // Still at work, or typed and not yet taken up (its AI still starting): it carries on, and its answer
        // comes as an alert.
        const asked = this._voice.phase === 'thinking' && this._sentRequest === this._listenRequest;
        this._voiceInBackground = asked || VOICE_WORKING.includes(this._daemon.state.assistant?.phase);
        // Still listening as far as it knows: isled may be turning the last words into a request (see `_onAssistant`).
        this._closedListeningAt = !this._voiceInBackground && this._voice.phase === 'listening' ? Date.now() : 0;
        this._syncAssistantBusy();
        this._daemon.call('assistant', 'End');
    }

    /** Plays a theme sound, if chimes are on. */
    _chime(soundName) {
        if (this._settings.get_boolean('chimes'))
            global.display.get_sound_player().play_from_theme(soundName, 'Isle', null);
    }

    // Idle

    /** Marks the user away after a minute without input (sooner on battery), so animations rest. */
    _watchIdle() {
        const monitor = global.backend.get_core_idle_monitor();
        const rest = () => {
            this._compact.idle = true;
            // Away: a reminder on screen waits for them.
            if (this._alert?.sticky)
                this._cancel('alert');
            if (!this._activeWatch) {
                this._activeWatch = monitor.add_user_active_watch(() => {
                    this._activeWatch = 0;
                    this._compact.idle = false;
                    // Back: a reminder that waited starts its time now.
                    this._timeAlert();
                });
            }
        };
        this._idleWatch = monitor.add_idle_watch(IDLE_MS, rest);
        this._batteryIdleWatch = monitor.add_idle_watch(IDLE_ON_BATTERY_MS, () => {
            const battery = this._daemon.state.system?.battery;
            if (battery && !battery.plugged)
                rest();
        });
    }

    // Timeouts

    /** Runs `callback` after `ms`, replacing a pending one of the same name; nothing once tearing down. */
    _later(name, ms, callback) {
        if (this._destroying)
            return;
        this._cancel(name);
        this._timeouts.set(name, GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => {
            this._timeouts.delete(name);
            callback();
            return GLib.SOURCE_REMOVE;
        }));
    }

    /** Drops the named timeout, if pending. */
    _cancel(name) {
        const id = this._timeouts.get(name);
        if (id) {
            GLib.source_remove(id);
            this._timeouts.delete(name);
        }
    }

    /** Turns Isle off: agents' asks go back to their terminals, then all it built is torn down. */
    destroy() {
        // Failed to start: what it built went then.
        if (this._failed)
            return;
        // Turned off while still being built (locked at once): only what was built goes.
        if (this._building) {
            GLib.source_remove(this._building);
            this._building = 0;
            this._destroyPartial();
            return;
        }
        // Turned off (the screen locks too): agents waiting on an answer here ask in their terminals at once.
        this._passAgentAsks();
        // What waits goes with Isle, never shown (a notification marked read, its sound played) as it goes.
        this._queue = [];
        Alerts.stopWatching();
        global.display.get_selection().disconnect(this._primaryChanged);
        Main.layoutManager.uiGroup.disconnect(this._panelAdded);
        global.display.disconnect(this._focusChanged);
        global.display.disconnect(this._focusMonitorChanged);
        stopPending();
        if (this._voiceBound)
            Main.wm.removeKeybinding('voice-shortcut');
        // A command waiting for Run or Deny ends with Isle; built again, it is asked again (see `_onAssistant`).
        this._deciding?.done(false);
        if (this._voiceOpen)
            this._closeVoice();
        // Releasing the keyboard may schedule a collapse; cancel it after. Tearing down schedules nothing.
        this._setKeyboard(false);
        for (const name of [...this._timeouts.keys()])
            this._cancel(name);
        this._destroying = true;

        const monitor = global.backend.get_core_idle_monitor();
        if (this._idleWatch)
            monitor.remove_watch(this._idleWatch);
        if (this._batteryIdleWatch)
            monitor.remove_watch(this._batteryIdleWatch);
        if (this._activeWatch)
            monitor.remove_watch(this._activeWatch);

        this._settingsChanged.forEach(id => this._settings.disconnect(id));
        Main.layoutManager.disconnect(this._monitorsChanged);
        this._releaseScanout();
        this._osd.destroy();
        this._keyboard.destroy();
        this._shelfHelper.destroy();
        this._reminders.destroy();
        // Ending focus mode can turn Do Not Disturb off, which the views
        // still show.
        this._focusMode.destroy();

        // The views listen to the services below, so they go first.
        this._island.destroy();
        this._writer.destroy();
        this._installedApps.destroy();
        this._clipboard.destroy();
        this._call.destroy();
        this._privacy.destroy();
        this._audio.destroy();
        this._notifications.destroy();
        this._topBar.destroy();
        this._daemon.destroy();
        this._settings = null;
        Format.release();
    }

    /** Lets GNOME send windows straight to the screen again, as it was before Isle (see `_syncScanout`). */
    // Hide Top Bar adds the bar again, over the island, which then never gets the pointer: put it back below.
    _keepAbovePanel() {
        const group = Main.layoutManager.uiGroup;
        const children = group.get_children();
        if (children.indexOf(Main.layoutManager.panelBox) > children.indexOf(this._island))
            group.set_child_below_sibling(Main.layoutManager.panelBox, this._island);
    }

    _releaseScanout() {
        this._scanoutWatches?.forEach(([source, id]) => source.disconnect(id));
        this._scanoutWatches = null;
        if (this._scanoutInhibited)
            inhibitScanout(false);
        this._scanoutInhibited = false;
    }

    /** Frees what the steps of building (see the constructor) made before it was turned off: nothing
     * outside knows of it yet, but for what it built. */
    _destroyPartial() {
        this._destroying = true;
        for (const name of [...this._timeouts.keys()])
            this._cancel(name);
        // What the last step had connected before it failed (see `_connectAll`).
        Alerts.stopWatching();
        stopPending();
        if (this._primaryChanged)
            global.display.get_selection().disconnect(this._primaryChanged);
        if (this._panelAdded)
            Main.layoutManager.uiGroup.disconnect(this._panelAdded);
        for (const id of [this._focusChanged, this._focusMonitorChanged].filter(Boolean))
            global.display.disconnect(id);
        if (this._voiceBound)
            Main.wm.removeKeybinding('voice-shortcut');
        this._setKeyboard(false);
        const monitor = global.backend.get_core_idle_monitor();
        for (const watch of [this._idleWatch, this._batteryIdleWatch, this._activeWatch].filter(Boolean))
            monitor.remove_watch(watch);
        this._settingsChanged?.forEach(id => this._settings.disconnect(id));
        if (this._monitorsChanged)
            Main.layoutManager.disconnect(this._monitorsChanged);
        this._releaseScanout();
        for (const part of [this._osd, this._keyboard, this._reminders, this._installedApps])
            part?.destroy();
        this._shelfHelper?.destroy();
        // The views are the island's once it is on screen (see `_buildIsland`); before, each goes by itself.
        if (!this._island?.get_parent()) {
            for (const view of [this._compact, ...this._peeks ?? [], this._voice, this._expanded])
                view?.destroy();
            if (!this._expanded)
                this._pages.forEach(page => page.destroy());
        }
        this._island?.destroy();
        for (const service of [this._topBar, this._writer, this._clipboard, this._focusMode, this._call,
            this._privacy, this._audio, this._notifications, this._daemon])
            service?.destroy();
        this._settings = null;
        Format.release();
    }
}
