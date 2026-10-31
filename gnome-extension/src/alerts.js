// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Turns events into alerts for the peek view (see peek.js for the format).

import GLib from 'gi://GLib';

import * as Format from './format.js';
import * as Playback from './playback.js';
import {notificationIcon, plainBody} from './notifications.js';
import * as Theme from './theme.js';
import {hasOwnIcon} from './widgets.js';

const OSD_DURATION = 1500;
const STATUS_DURATION = 2600;
const REMINDER_DURATION = 8000;
/** As long as GNOME's own banner; a passing one (a screenshot taken) less. The pointer on it holds it. */
const NOTIFICATION_DURATION = 4000;
const TRANSIENT_NOTIFICATION_DURATION = 2500;
/** Buttons that turn something down, never shown as the one to press. */
const DECLINING = /^(decline|reject|deny|dismiss|cancel|ignore|hang up|end call|not now|tolak|abaikan|batal|tutup)\b/i;
/** As many of a notification's buttons as GNOME's banner shows. */
const MAX_NOTIFICATION_BUTTONS = 3;
/** The longest an answer stays to be read, as the open island gives it (see VOICE_READ_MS in controller.js). */
const ANSWER_MAX_DURATION = 8000;
/** A critical notification stays this long once someone is there to see it. */
const CRITICAL_DURATION = 20000;

/** A battery on its side; the ring around it shows the level. */
function batteryIcon(percent) {
    return percent <= 20 ? 'isle-battery-low-symbolic' : 'isle-battery-symbolic';
}

/** "42%", rounded. */
function percentText(value) {
    return `${Math.round(value)}%`;
}

// GNOME's OSD icons by prefix (first match wins): a title, and the state an icon-only toggle shows.
const OSD_KINDS = [
    ['audio-volume', 'Volume'],
    ['microphone-sensitivity-muted', 'Microphone', 'Muted'],
    ['microphone', 'Microphone'],
    ['keyboard-brightness', 'Keyboard light'],
    ['display-brightness', 'Brightness'],
    ['touchpad-disabled', 'Touchpad', 'Off'],
    ['input-touchpad', 'Touchpad', 'On'],
    ['airplane-mode-disabled', 'Airplane mode', 'Off'],
    ['airplane-mode', 'Airplane mode', 'On'],
    ['camera-disabled', 'Camera', 'Off'],
    ['camera', 'Camera', 'On'],
    ['bluetooth-disabled', 'Bluetooth', 'Off'],
    ['bluetooth', 'Bluetooth', 'On'],
    ['network-wireless-disabled', 'Wi-Fi', 'Off'],
    ['video-display', 'Display'],
];

/** Where a level applies when GNOME names none, so every level alert has two lines, as Volume's "Speakers". */
const OSD_PLACES = {'Brightness': 'Built-in Display', 'Keyboard light': 'Keyboard'};

/** "touchpad-disabled-symbolic" → "Touchpad disabled", for OSDs not listed above. */
function iconTitle(iconName) {
    const words = iconName.replace(/-symbolic$/, '').replace(/-/g, ' ').trim();
    return words ? words[0].toUpperCase() + words.slice(1) : '';
}

/** Volume, brightness and similar on-screen displays from GNOME. */
export function osd(gicon, text, level, maxLevel) {
    const iconName = gicon?.get_names?.()[0] ?? '';
    const [, kind, state] = OSD_KINDS.find(([prefix]) => iconName.startsWith(prefix)) ?? [];
    const hasLevel = typeof level === 'number';
    const fraction = hasLevel ? level / (maxLevel || 1) : null;
    return {
        key: 'osd',
        priority: 'instant',
        transient: true,
        gicon,
        // Toggles (touchpad, airplane mode...) send only an icon; never show it alone.
        title: kind ?? (text || iconTitle(iconName)),
        subtitle: kind && text && text !== kind ? text : hasLevel ? OSD_PLACES[kind] ?? '' : '',
        status: hasLevel ? null : state,
        level: hasLevel ? Math.min(fraction, 1) : null,
        levelText: hasLevel ? percentText(level * 100) : null,
        tone: 'neutral',
        duration: OSD_DURATION,
        // Volume: the speaker's waves follow the level (see VolumeGlyph).
        volume: kind === 'Volume' ? {level: hasLevel ? fraction : 0, muted: iconName.includes('muted')} : undefined,
    };
}

/** Caps Lock turned on or off; it rises only when on. */
export function capsLock(on) {
    return {
        key: 'keyboard',
        priority: 'instant',
        transient: true,
        icon: 'isle-capslock-symbolic',
        motion: on ? 'rise' : undefined,
        title: 'Caps Lock',
        status: on ? 'On' : 'Off',
        tone: 'neutral',
        duration: OSD_DURATION,
    };
}

/** A `SystemEvent` from the daemon, or null if it is not worth showing. */
export function system(event) {
    switch (event.kind) {
    // Charging and battery alerts: a ring that sweeps up to the
    // charge level around a bolt, with the percentage large on the right.
    case 'power':
        return {
            key: 'power',
            icon: event.plugged ? 'isle-bolt' : batteryIcon(event.percent),
            motion: event.plugged ? 'pulse' : undefined,
            ringIconSize: event.plugged ? undefined : 14,
            ring: event.percent / 100,
            title: event.plugged ? 'Charging' : 'On battery',
            subtitle: event.plugged ? 'Charger connected' : 'Charger disconnected',
            value: percentText(event.percent),
            tone: event.plugged ? 'good' : event.percent <= 20 ? 'bad' : 'neutral',
            duration: STATUS_DURATION,
        };
    case 'battery_low':
        return {
            key: 'power',
            icon: batteryIcon(event.percent),
            ringIconSize: 14,
            ring: event.percent / 100,
            title: 'Low battery',
            subtitle: 'Plug in your charger soon',
            value: percentText(event.percent),
            tone: 'bad',
            duration: REMINDER_DURATION,
        };
    case 'battery_full':
        return {
            key: 'power',
            icon: 'isle-bolt',
            motion: 'pulse',
            ring: 1,
            title: 'Fully charged',
            subtitle: 'You can unplug your charger',
            value: '100%',
            tone: 'good',
            duration: STATUS_DURATION,
        };
    case 'network':
        // Only losing the connection is worth a pop-up; connecting is
        // expected (e.g. after every wake from sleep).
        if (event.connected)
            return null;
        return {
            key: 'network',
            icon: 'network-wireless-offline-symbolic',
            title: 'Offline',
            subtitle: 'The network connection was lost',
            tone: 'bad',
            duration: STATUS_DURATION,
        };
    case 'bluetooth': {
        const {device} = event;
        const battery = event.connected ? device.battery ?? null : null;
        return {
            key: `bluetooth:${device.path}`,
            // A kind Isle has no icon of its own for (a printer, a watch): Bluetooth's, in Isle's style.
            icon: hasOwnIcon(device.icon) ? device.icon : 'isle-bluetooth-symbolic',
            ring: battery !== null ? battery / 100 : null,
            title: device.name,
            subtitle: event.connected ? 'Connected' : 'Disconnected',
            value: battery !== null ? percentText(battery) : null,
            tone: !event.connected ? 'neutral' : battery !== null && battery < 20 ? 'bad' : 'good',
            duration: STATUS_DURATION,
        };
    }
    default:
        return null;
    }
}

/** A pomodoro phase ended; when the next one waits to be started, a button starts it. */
export function pomodoroFinished(finished, next, state, daemon) {
    const waiting = !state?.running;
    const minutes = state ? Math.round(state.duration_ms / 60000) : 0;
    if (finished === 'focus') {
        return {
            key: 'pomodoro',
            icon: 'isle-timer-symbolic',
            motion: 'bounce',
            title: 'Focus session done',
            subtitle: waiting ? 'Take a break when you’re ready' : `Enjoy a ${minutes}-minute break`,
            tone: 'good',
            action: waiting ? {label: 'Start break', callback: () => daemon.call('pomodoro', 'Start')} : null,
            duration: REMINDER_DURATION,
            page: 'focus',
        };
    }
    return {
        key: 'pomodoro',
        icon: 'isle-timer-symbolic',
        motion: 'bounce',
        title: next === 'focus' ? 'Break is over' : Format.phaseName(next),
        subtitle: waiting ? 'Ready for another focus session?' : `${minutes} minutes of focus`,
        tone: 'focus',
        action: waiting ? {label: 'Start focus', callback: () => daemon.call('pomodoro', 'Start')} : null,
        duration: REMINDER_DURATION,
        page: 'focus',
    };
}

/** A new song: its cover with the player's icon as a badge. */
export function track(nowPlaying) {
    return {
        key: 'track',
        art: nowPlaying.art_path,
        badge: Playback.playerApp(nowPlaying)?.get_icon() ?? null,
        title: nowPlaying.title,
        subtitle: nowPlaying.artist || nowPlaying.identity,
        duration: STATUS_DURATION,
        page: 'music',
    };
}

/** Notifications already watched (each with what to do once it is withdrawn), and those since withdrawn. */
const watched = new WeakMap();
/** Each watched notification's `destroy` handler, undone by `stopWatching` as Isle stops. */
const watchIds = new Map();
const withdrawn = new WeakSet();
/** Each notification's own number, so alerts for different ones never replace each other. */
const numbers = new WeakMap();
let lastNumber = 0;

/** Watches `item` for being withdrawn, once however often it is shown (updates come as the same one); then
 * the latest `onWithdrawn` runs. */
function watchWithdrawal(item, onWithdrawn) {
    const known = watched.has(item);
    watched.set(item, onWithdrawn);
    if (known)
        return;
    const id = item.connect('destroy', () => {
        withdrawn.add(item);
        item.disconnect(id);
        watchIds.delete(item);
        watched.get(item)?.();
    });
    watchIds.set(item, id);
}

/** Stops watching notifications, so none calls back into an Isle that stopped. */
export function stopWatching() {
    for (const [item, id] of watchIds) {
        item.disconnect(id);
        watched.delete(item);
    }
    watchIds.clear();
}

/** Whether a notification still waits to be seen: not withdrawn, nor read in the list meanwhile. */
function unseen(item) {
    return !withdrawn.has(item) && !item.acknowledged;
}

/** Whether GNOME would show `item`'s banner now: not in Do Not Disturb, nor with its app's banners turned off. */
function bannersOn(item) {
    return item.source?.policy?.showBanners ?? true;
}

/** A GNOME notification, in place of GNOME's own banner; `onShown` once on screen, `onSeen` once someone is there to
 * see it, `onWithdrawn(key)` once its app takes it back. While the screen is `shared`, only who it is from shows. */
export function notification(item, urgent, {onShown, onSeen, onWithdrawn}, shared = false) {
    if (!numbers.has(item))
        numbers.set(item, ++lastNumber);
    const key = `notification:${numbers.get(item)}`;
    // The app or GNOME may withdraw the notification while it is shown;
    // clicking the alert afterwards must not touch the destroyed object.
    watchWithdrawal(item, () => onWithdrawn(key));
    const body = shared ? '' : plainBody(item).replace(/\s+/g, ' ').trim();
    // On one line, as the body.
    const title = (shared ? item.source?.title || 'New notification' : item.title || item.source?.title || '')
        .replace(/\s+/g, ' ').trim();
    const buttons = shared ? [] : (item.actions ?? []).slice(0, MAX_NOTIFICATION_BUTTONS);
    // The last, as GNOME's banner has it, unless it turns something down ("Decline"): then the last that doesn't.
    const turnsDown = button => DECLINING.test(button.label ?? '');
    const mainButton = buttons.findLastIndex(button => !turnsDown(button));
    const press = button => {
        if (!withdrawn.has(item))
            button.activate();
    };
    const alert = {
        // Its own key: one arriving behind another waits its turn; the same one updated replaces itself.
        key,
        kind: 'notification',
        // Put away with its ×, buttons or not, as GNOME's banner.
        closable: true,
        // A critical one keeps its whole time, like GNOME's, which stays until handled. Every one waits for
        // someone to be there (see `waitsWhileAway` in controller.js).
        sticky: urgent,
        // One button ("Mark as read") beside the words; two or three ("Decline", "Accept") under them, all of
        // them, as GNOME's banner has them.
        action: buttons.length === 1 ? {label: buttons[0].label, callback: () => press(buttons[0])} : undefined,
        actions: buttons.length > 1 ? buttons.map((button, index) => ({
            label: button.label,
            primary: index === mainButton,
            callback: () => press(button),
        })) : undefined,
        onShown: () => {
            if (!withdrawn.has(item))
                onShown();
        },
        onSeen: () => {
            if (!withdrawn.has(item))
                onSeen();
        },
        appIcon: true,
        gicon: notificationIcon(item),
        icon: 'dialog-information-symbolic',
        title,
        subtitle: body,
        // Its words on up to two lines before they are cut.
        subtitleLines: 2,
        // A critical one stands out in red.
        tone: urgent ? 'bad' : 'neutral',
        priority: urgent ? 'instant' : undefined,
        duration: urgent ? CRITICAL_DURATION : item.isTransient ? TRANSIENT_NOTIFICATION_DURATION : NOTIFICATION_DURATION,
        page: 'notifications',
        onActivate: () => {
            if (!withdrawn.has(item))
                item.activate();
        },
        item,
        // When its turn comes: gone if withdrawn or read meanwhile, else as it reads now (an app may have
        // updated it) and as the screen is shared now.
        fresh: sharedNow => {
            // Do Not Disturb turned on while it waited: it stays unread in the list, never popping up.
            if (withdrawn.has(item) || (!alert.shown && (item.acknowledged || (!urgent && !bannersOn(item)))))
                return null;
            const redone = notification(item, urgent, {onShown, onSeen, onWithdrawn}, sharedNow);
            const labels = a => [a.action, ...a.actions ?? []].map(button => button?.label).join();
            if (redone.title === alert.title && redone.subtitle === alert.subtitle &&
                labels(redone) === labels(alert) && redone.gicon === alert.gicon)
                return alert;
            redone.shown = alert.shown;
            return redone;
        },
    };
    return alert;
}

/** "5 hours" → "5-hour limit", "Week · Opus" → "weekly Opus limit". */
function limitName(window) {
    if (window === '5 hours')
        return '5-hour limit';
    const [span, model] = window.split(' · ');
    const kind = span === 'Week' ? 'Weekly' : span;
    return model ? `${kind} ${model} limit` : `${kind} limit`;
}

/** An AI plan limit nears its end: the provider's logo in a ring of the share, "86%" beside it. */
export function usage(provider, window, percent, resetsAt, critical) {
    const at = GLib.DateTime.new_from_unix_local(Math.floor(resetsAt / 1000));
    // Within the next 20 hours (later today or tomorrow morning), the time alone; later, with the day.
    const when = resetsAt - Date.now() < 20 * 3600e3 ? Format.timeOfDay(at) : `${at.format('%a')} ${Format.timeOfDay(at)}`;
    const name = provider.toLowerCase();
    return {
        key: `usage:${provider}:${window}`,
        icon: name.includes('claude') ? 'isle-claude'
            : name.includes('grok') ? 'isle-grok'
            : name.includes('gpt') || name.includes('codex') ? 'isle-openai' : 'isle-gauge',
        ring: Math.min(1, percent / 100),
        title: provider,
        subtitle: resetsAt > 0 ? `${limitName(window)} · resets ${when}` : limitName(window),
        value: percentText(percent),
        // In the plan's own colour, as on the Usage page; red once nearly used up.
        tone: Math.round(percent) >= critical ? 'bad'
            : name.includes('claude') ? 'claude'
            : name.includes('grok') ? 'grok'
            : name.includes('gpt') || name.includes('codex') ? 'codex' : 'neutral',
        duration: REMINDER_DURATION,
        page: 'usage',
    };
}

/** A reminder the voice assistant set ("remind me in ten minutes to..."). `onShown` once on screen. */
export function reminder({id, text}, onShown) {
    return {
        // Its own key, so reminders due together queue instead of replacing each other.
        key: `reminder:${id}`,
        icon: 'isle-bell',
        motion: 'ring',
        title: text,
        // Its words are the point: two lines, as a meeting's title.
        titleLines: 2,
        subtitle: 'Reminder',
        tone: 'neutral',
        duration: REMINDER_DURATION,
        // Its time only runs while someone is there to see it.
        sticky: true,
        onShown,
    };
}

/** The meeting service a link goes to, by its host. */
function meetingService(link) {
    const host = (/^https:\/\/([^/]+)/.exec(link)?.[1] ?? '').toLowerCase();
    if (host === 'meet.google.com')
        return 'Google Meet';
    if (host.endsWith('zoom.us'))
        return 'Zoom';
    if (host.startsWith('teams.'))
        return 'Microsoft Teams';
    if (host.endsWith('webex.com'))
        return 'Webex';
    return null;
}

/** An event starts soon ({title, start_ms, end_ms} from the Calendar page); with a meeting `link`, Join opens it.
 * `onShown` once it is on screen. */
export function meeting(event, link, join, onShown) {
    const start = new Date(event.start_ms);
    const minutes = Math.max(0, Math.round((event.start_ms - Date.now()) / 60000));
    const at = date => Format.timeOfDay(GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000)));
    const span = event.end_ms ? `${at(start)} – ${at(new Date(event.end_ms))}` : at(start);
    const service = link ? meetingService(link) : null;
    const alert = {
        key: `meeting:${event.id ?? event.title}:${event.start_ms}`,
        icon: link ? 'isle-video-symbolic' : 'isle-calendar',
        motion: 'bounce',
        title: minutes > 0 ? `${event.title} in ${minutes} min` : `${event.title} now`,
        subtitle: service ? `${span} · ${service}` : span,
        tone: 'calendar',
        duration: REMINDER_DURATION,
        // Its time only runs while someone is there to see it, as a reminder's.
        sticky: true,
        action: link ? {label: 'Join', callback: join, primary: true} : null,
        onShown,
        // When its turn comes: the minutes left then, and gone once the event is over (an hour without an end).
        fresh: () => {
            if (Date.now() >= (event.end_ms || event.start_ms + 3600e3))
                return null;
            const redone = meeting(event, link, join, onShown);
            if (redone.title === alert.title)
                return alert;
            redone.shown = alert.shown;
            return redone;
        },
    };
    return alert;
}

const AGENT_NAMES = {claude: 'Claude', codex: 'Codex', grok: 'Grok'};
const AGENT_APPS = {claude: 'Claude Code', codex: 'Codex', grok: 'Grok'};
/** The agent's icon and accent colour; Claude's for anything unknown. */
const agentIcon = provider => provider === 'codex' ? 'isle-openai' : provider === 'grok' ? 'isle-grok' : 'isle-claude';
const agentTone = provider => provider === 'codex' ? 'codex' : provider === 'grok' ? 'grok' : 'claude';

/** An AI agent needs the user, or is done ({provider, kind, project, message}); `show` brings its window up. */
export function agent(event, show) {
    const name = AGENT_NAMES[event.provider] ?? 'Your AI';
    const waiting = event.kind === 'permission' || event.kind === 'waiting';
    const title = {permission: `${name} needs your OK`, waiting: `${name} is waiting for you`}[event.kind] ?? `${name} is done`;
    // Said once: the title already says it needs an OK; the tool it asks for, as a question.
    const tool = /permission to use (.+?)\.?$/i.exec(event.message ?? '')?.[1];
    const detail = {permission: tool ? `Allow ${tool}?` : '', waiting: ''}[event.kind] ?? event.message?.trim();
    return {
        // One per session: a newer word from the same one replaces it.
        key: `agent:${event.provider}:${event.session || event.project}`,
        icon: agentIcon(event.provider),
        motion: waiting ? 'ring' : 'bounce',
        title,
        subtitle: [event.project, detail].filter(Boolean).join(' · '),
        tone: agentTone(event.provider),
        duration: waiting ? REMINDER_DURATION + 4000 : REMINDER_DURATION,
        // It waits on the user: it stays until they are there to see it.
        sticky: waiting,
        action: show ? {label: 'Show', callback: show} : null,
    };
}

/** The light round an alert that asks (amber), and one that tells an agent is done (green). */
const ASKING_GLOW = [[1, 0.62, 0.04], [1, 0.42, 0.25], [1, 0.8, 0.3]];
const DONE_GLOW = [[0.19, 0.82, 0.35], [0.35, 0.88, 0.75], [0.7, 0.94, 0.35]];
/** On glass, each runs one way as Classic does, deep to light: orange to gold, green to teal. */
const GLASS_ASKING_GLOW = [[0.99, 0.48, 0.06], [0.93, 0.62, 0.07], [0.86, 0.75, 0.33]];
const GLASS_DONE_GLOW = [[0.21, 0.64, 0.05], [0.07, 0.72, 0.45], [0.31, 0.86, 0.74]];

/** What a tool call asks to do, on one line: a shell command as it is, else the tool and what it touches
 * (isled sends that as a line; see agents/hook.rs `request`). */
function toolLine(tool, input) {
    const line = String(typeof input === 'string' ? input
        : input?.command ?? input?.file_path ?? input?.path ?? input?.url ?? input?.pattern ?? '').split('\n')[0];
    if (/^(bash|shell|exec_command|local_shell)$/i.test(tool ?? '') && line)
        return line;
    return [tool, line].filter(Boolean).join(' ');
}

/** An AI agent asks to run something ({provider, project, tool, input, always}), shown by the assistant;
 * `answer(choice)` sends allow, deny or always back. */
export function agentAsks(request, look, answer) {
    // Allow is the one to press; Always (Claude keeps a rule for next time) is offered, never pressed for you.
    const actions = [
        {label: 'Deny', answer: 'deny', callback: () => answer('deny')},
        ...request.always ? [{label: 'Always', answer: 'allow', done: 'Always allowed here', callback: () => answer('always')}] : [],
        {label: 'Allow', answer: 'allow', primary: true, callback: () => answer('allow')},
    ];
    return {
        key: `agent-ask:${request.id}`,
        bot: {look, glyph: '!'},
        title: `${request.project || AGENT_APPS[request.provider]} needs permission`,
        subtitle: request.project ? AGENT_APPS[request.provider] : '',
        code: toolLine(request.tool, request.input),
        tone: 'warn',
        // Read as it is drawn: the theme may change while it shows.
        get glow() {
            return Theme.translucent() ? GLASS_ASKING_GLOW : ASKING_GLOW;
        },
        actions,
        // It waits on the user: it stays until answered, or until the agent stops asking.
        sticky: true,
        duration: 600000,
        priority: 'instant',
    };
}

/** An AI agent finished ({provider, project, message: its last words}); `show` brings its window up. */
export function agentDone(event, look, show) {
    const summary = firstSentence(event.message) || 'Finished';
    return {
        key: `agent:${event.provider}:${event.session || event.project}`,
        bot: {look, glyph: 'check', form: 'success'},
        title: summary,
        titleLines: 2,
        subtitle: `${[event.project, AGENT_APPS[event.provider]].filter(Boolean).join(' · ')} finished`,
        tone: 'good',
        get glow() {
            return Theme.translucent() ? GLASS_DONE_GLOW : DONE_GLOW;
        },
        actions: [
            ...show ? [{label: 'Open terminal', callback: show}] : [],
            {label: 'OK', primary: true, callback: () => {}},
        ],
        duration: REMINDER_DURATION,
    };
}

/** The first sentence of `text`, cut to a line's worth. */
function firstSentence(text) {
    // The words first (`{"say":"…"}` is that sentence), then the first line that says something: not a
    // heading alone ("## Summary"), code or a rule, unless that is all there is.
    const words = Format.spoken(text ?? '');
    const linesOf = part => part.split('\n').map(line => line.trim()).filter(Boolean);
    const line = linesOf(words.replace(/```[\s\S]*?(```|$)/g, '')).find(each => !/^(#{1,6}\s|([-*_]\s*){3,}$)/.test(each)) ??
        linesOf(words)[0] ?? '';
    // Markdown's marks only, not the characters of names (`user_id` keeps its underscore).
    const first = Format.answerPlain(line.split(/(?<=[.!?])\s/)[0])
        .replace(/^[#>\s]+/, '')
        .replace(/(^|[^\w])_([^_]+)_(?=[^\w]|$)/g, '$1$2')
        .replace(/(^|[^\w*])\*([^*]+)\*(?=[^\w*]|$)/g, '$1$2')
        .trim();
    return first.length > 140 ? `${first.slice(0, 139).trimEnd()}…` : first;
}

/** Isle's assistant wants to run `card.command` while the island is closed; `answer(run)` decides. */
export function taskAsks(card, look, answer) {
    return {
        key: `task-ask:${card.id}`,
        bot: {look, glyph: '!'},
        title: card.why,
        subtitle: card.risks?.includes('root') ? 'Isle wants to run this · asks for your password' : 'Isle wants to run this',
        code: card.command,
        tone: 'warn',
        glow: look.palette.glow,
        actions: [
            {label: 'Deny', answer: 'deny', callback: () => answer(false)},
            {label: 'Run', answer: 'allow', primary: true, done: 'Running', callback: () => answer(true)},
        ],
        sticky: true,
        duration: 600000,
        priority: 'instant',
    };
}

/** Isle connected to `provider` for the first time; `settings` opens where it can be turned off. */
export function agentConnected(provider, look, settings) {
    return {
        key: `agent-connected:${provider}`,
        bot: {look, glyph: 'check', form: 'success'},
        title: `${AGENT_APPS[provider]} is connected`,
        subtitle: provider === 'codex' ? 'In Codex, type /hooks once and allow Isle' : 'Answer it from here when it asks',
        tone: 'good',
        actions: [
            {label: 'Settings', callback: settings},
            {label: 'OK', primary: true, callback: () => {}},
        ],
        duration: REMINDER_DURATION,
    };
}

/** The model picked for the assistant isn't on `provider`'s plan now (it lapsed, say): `used` answers instead. */
export function modelSwitched(provider, plan, picked, used) {
    const name = {claude: 'Claude', codex: 'ChatGPT', grok: 'Grok', agy: 'Antigravity'}[provider] ?? 'Your AI';
    return {
        key: `model-switched:${provider}`,
        icon: {claude: 'isle-claude', codex: 'isle-openai', grok: 'isle-grok'}[provider] ?? 'isle-sparkle-symbolic',
        title: plan ? `${name} ${plan} doesn’t include ${picked}` : `${picked} isn’t available`,
        // A long model name ("Claude Opus 4.6 (Thinking)") wraps rather than being cut.
        titleLines: 2,
        // The pick comes back by itself once the plan allows it again.
        subtitle: `Using ${used} for now`,
        tone: 'neutral',
        duration: REMINDER_DURATION,
    };
}

/** The alerts from `provider` could not be turned on; `reason` is isled's. */
export function agentRefused(provider, reason) {
    const name = AGENT_NAMES[provider] ?? 'Your AI';
    return {
        key: `agent-refused:${provider}`,
        icon: agentIcon(provider),
        motion: 'shake',
        title: `Couldn’t turn on ${name} alerts`,
        subtitle: reason,
        tone: 'bad',
        duration: REMINDER_DURATION,
    };
}

/** A newer Isle is out; `open` shows Settings' Update. `packaged`: installed system-wide (.deb, .rpm, AUR). */
export function update(version, open, packaged = false) {
    return {
        key: 'update',
        icon: 'software-update-available-symbolic',
        motion: 'bounce',
        title: `Isle ${version} is out`,
        subtitle: packaged ? 'Update its package to get it' : 'Update in a click; your things stay',
        tone: 'good',
        action: {label: 'Update', callback: open},
        duration: REMINDER_DURATION,
    };
}

/** isled is not running: the island's music, timer, reminders and assistant wait for it. */
export function serviceDown(restart) {
    return {
        key: 'service-down',
        icon: 'dialog-warning-symbolic',
        motion: 'shake',
        title: 'Isle’s service isn’t running',
        subtitle: 'Music, timer and reminders need it',
        tone: 'bad',
        action: {label: 'Restart', callback: restart},
        duration: REMINDER_DURATION,
    };
}

/** Several notifications (a Set) that came while the island could not show them, summed up. */
export function notificationsSummary(items) {
    const count = items.size;
    const alert = {
        key: 'notifications-summary',
        items,
        icon: 'isle-bell',
        motion: 'bounce',
        title: count === 1 ? '1 new notification' : `${count} new notifications`,
        subtitle: count === 1 ? 'Open the island to read it' : 'Open the island to read them',
        tone: 'neutral',
        duration: NOTIFICATION_DURATION,
        page: 'notifications',
        // One sound for them all (the newest's), as they stay unread; never shown, none plays.
        onShown: () => [...items].filter(unseen).at(-1)?.playSound?.(),
        // Those read or withdrawn meanwhile no longer count.
        fresh: () => {
            const left = new Set([...items].filter(item => unseen(item) && bannersOn(item)));
            return left.size === count ? alert : left.size ? notificationsSummary(left) : null;
        },
    };
    return alert;
}

/** The voice assistant finished a request the island closed on: its answer, or what went wrong. `open`
 * shows it in full. */
export function assistant(state, open) {
    const failed = state.phase === 'error';
    const text = failed ? state.error || 'Something went wrong' : Format.answerPlain(state.reply ?? '') || 'Done';
    return {
        key: 'assistant',
        icon: failed ? 'dialog-warning-symbolic' : 'isle-mic-symbolic',
        motion: failed ? 'shake' : 'bounce',
        title: text,
        // An answer may take three lines, so a question at its end still shows.
        titleLines: 3,
        subtitle: failed ? state.hint ?? '' : 'Isle Assistant',
        cutSubtitle: failed ? undefined : 'Isle Assistant · Click to read more',
        tone: failed ? 'bad' : 'good',
        // Long enough to read, as the open island gives it.
        duration: Math.min(ANSWER_MAX_DURATION, STATUS_DURATION + 45 * text.length),
        onActivate: open,
    };
}

/** GNOME's screen recorder started. */
export function recordingStarted(stop) {
    return {
        key: 'recording',
        icon: 'media-record-symbolic',
        motion: 'pulse',
        title: 'Recording screen',
        subtitle: 'Stop it from the red dot in the island',
        tone: 'bad',
        action: {label: 'Stop', callback: stop},
        duration: STATUS_DURATION,
    };
}
