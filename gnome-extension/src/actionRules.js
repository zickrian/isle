// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The assistant's rules that need nothing of GNOME, kept apart so tests run them anywhere (tests/).

/** What actions run mid-way do, for the island: "Opening Files…", or how many there are. */
export function describeActions(actions = []) {
    const [first] = actions;
    if (!first)
        return 'Working…';
    // On unless the action says off.
    const turning = (name, on) => `Turning ${name} ${on === false ? 'off' : 'on'}…`;
    const what = {
        open_app: `Opening ${first.app ?? 'the app'}…`,
        open_url: 'Opening the page…',
        open_file: 'Opening the file…',
        reveal_file: 'Showing the file in Files…',
        open_folder: 'Opening the folder…',
        chrome_profile: 'Opening Chrome…',
        window: 'Moving the window…',
        arrange: 'Arranging the windows…',
        play_music: 'Playing music…',
        media: 'Controlling the music…',
        close_app: `Closing ${first.app ?? 'the app'}…`,
        volume: Number.isFinite(first.level) ? `Setting the volume to ${first.level}%…` : 'Changing the volume…',
        brightness: Number.isFinite(first.level) ? `Setting the brightness to ${first.level}%…` : 'Changing the brightness…',
        wifi: turning('Wi-Fi', first.on),
        bluetooth: turning('Bluetooth', first.on),
        dnd: turning('Do Not Disturb', first.on),
        dark_mode: turning('dark style', first.on),
        night_light: turning('Night Light', first.on),
        power_mode: 'Switching the power mode…',
        settings: 'Opening Settings…',
        add_task: 'Adding a to-do…',
        done_task: 'Ticking off the to-do…',
        remove_task: 'Removing the to-do…',
        add_event: 'Adding it to your calendar…',
        remove_event: 'Removing the event…',
        remind: 'Setting a reminder…',
        cancel_reminder: 'Cancelling the reminder…',
        focus: 'Starting the timer…',
        terminal: 'Opening a terminal…',
        run: 'Asking to run it…',
        notifications: 'Opening your notifications…',
        screenshot: 'Taking a screenshot…',
        lock: 'Locking the screen…',
        write: 'Typing it out…',
    }[first.type] ?? 'Working on it…';
    return actions.length > 1 ? `${what.replace(/…$/, '')} and ${actions.length - 1} more…` : what;
}

/** What isled's runner wraps each command in (see tasks.rs); a command to start must use exactly this. */
export const RUN_WRAPPER = '( eval "$1" ); printf \'\\n[isle-exit %d]\\n\' "$?"';
/** As root: the same, its output written to the log by the user ($2, $3) rather than root. */
export const ROOT_WRAPPER = `{ ${RUN_WRAPPER}; } 2>&1 | chroot --userspec="$2:$3" / tee -a -- "$4" >/dev/null`;

/** Whether `action` starts exactly what its card shows: `systemd-run` with Isle's own options, its log in Isle's
 * cache, the shown command last. Nothing else starts, even if something posed as isled on the bus. */
export function runnable(action, {home, cache = `${home}/.cache`, uid, gid}) {
    const argv = action?.spawn;
    if (!Array.isArray(argv) || argv[0] !== 'systemd-run' || typeof action.command !== 'string')
        return false;
    const end = argv.indexOf('--');
    const root = !argv.slice(0, end).includes('--user');
    const logPath = new RegExp(`^${literal(`${cache}/isle/runs/`)}run-[\\w-]+\\.log$`);
    if (end < 0 || argv.length !== end + (root ? 9 : 6))
        return false;
    const [bash, flag, wrapper, name, command, ...rest] = argv.slice(end + 1);
    // As root it is shown with `sudo` and runs without it; one line, with nothing hidden (see tasks.rs).
    if (root !== action.command.startsWith('sudo ') || !showsWhole(action.command, MAX_COMMAND + (root ? 5 : 0)))
        return false;
    const shown = root ? action.command.replace(/^sudo /, '') : action.command;
    if (bash !== 'bash' || flag !== '-c' || wrapper !== (root ? ROOT_WRAPPER : RUN_WRAPPER) || name !== 'isle' ||
        command !== shown)
        return false;
    // As root, the output reaches the log through the user, never a file root opens in their home.
    if (root && (rest[0] !== String(uid) || rest[1] !== String(gid) || !logPath.test(rest[2])))
        return false;
    const allowed = [
        /^--user$/, /^--unit=isle-run-[\w-]+$/, /^--collect$/, /^--quiet$/, /^--property=RuntimeMaxSec=\d+$/,
        /^--setenv=(DEBIAN_FRONTEND|LANG)=[\w.-]*$/,
    ];
    return argv.slice(1, end).every(option => allowed.some(rule => rule.test(option)) ||
        pathAllowed(option, root) || (!root && option === `--working-directory=${home}`) ||
        (!root && /^--property=Standard(Output|Error)=append:/.test(option) &&
            logPath.test(option.replace(/^--property=Standard(Output|Error)=append:/, ''))));
}

// The PATH a command gets (tasks.rs `path`): the system's folders, and for the user's own commands
// the folders of their programs first (home, nvm, Homebrew…); as root, nothing the user can write.
const SYSTEM_PATH = ['/usr/local/sbin', '/usr/local/bin', '/usr/sbin', '/usr/bin', '/sbin', '/bin', '/snap/bin'];

/** A PATH option passes only as the system's folders, after the user's own absolute ones (none as root). */
function pathAllowed(option, root) {
    if (!option.startsWith('--setenv=PATH='))
        return false;
    const dirs = option.slice('--setenv=PATH='.length).split(':');
    const own = dirs.slice(0, dirs.length - SYSTEM_PATH.length);
    return dirs.slice(own.length).join(':') === SYSTEM_PATH.join(':') && (root ? !own.length
        : own.every(dir => dir.startsWith('/') && !dir.split('/').includes('..') && !dir.includes('\n')));
}

// The longest command a card offers (tasks.rs MAX_COMMAND), and what may not be in it: line breaks,
// control characters, and characters that hide or reorder text.
const MAX_COMMAND = 400;
const HIDDEN = /[\u00ad\u061c\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/u;

/** Whether `text` shows as it is, whole, on one line of at most `max` characters. */
export function showsWhole(text, max) {
    return [...text].length <= max && !HIDDEN.test(text) &&
        ![...text].some(c => c.charCodeAt(0) < 0x20 || (c.charCodeAt(0) >= 0x7f && c.charCodeAt(0) <= 0x9f));
}

/** The line `command` is typed into a terminal as, its lines joined by `&&` (a newline would be an Enter of its
 * own); null for one the user could not see whole there, as a card would not offer it. */
export function terminalLine(command) {
    const line = command.split('\n').map(part => part.trim()).filter(Boolean).join(' && ');
    return showsWhole(line, MAX_COMMAND) ? line : null;
}

/** Whether a window `title` names `project` as a word of its own: "isle — Terminal", not "WhatsApp" for "app". */
export function namesProject(title, project) {
    if (!project)
        return false;
    const escaped = project.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(^|[^\\p{L}\\p{N}_-])${escaped}($|[^\\p{L}\\p{N}_-])`, 'u').test(title);
}

/** Whether `argv` only stops one of Isle's commands. */
export function stoppable(argv) {
    return Array.isArray(argv) && argv[0] === 'systemctl' &&
        (argv.length === 3 || (argv.length === 4 && argv[1] === '--user')) &&
        argv.at(-2) === 'stop' && /^isle-run-[\w-]+$/.test(argv.at(-1));
}

/** `text` escaped to match itself inside a RegExp. */
const literal = text => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Parts of the screen's work area, as [x, y, width, height] shares of it: where one window goes...
export const TILES = {
    left: [0, 0, 0.5, 1],
    right: [0.5, 0, 0.5, 1],
    top: [0, 0, 1, 0.5],
    bottom: [0, 0.5, 1, 0.5],
    top_left: [0, 0, 0.5, 0.5],
    top_right: [0.5, 0, 0.5, 0.5],
    bottom_left: [0, 0.5, 0.5, 0.5],
    bottom_right: [0.5, 0.5, 0.5, 0.5],
    center: [0.125, 0.1, 0.75, 0.8],
};
// ...and where several go, left to right and top to bottom.
const LAYOUTS = {
    halves: [TILES.left, TILES.right],
    rows: [TILES.top, TILES.bottom],
    quarters: [TILES.top_left, TILES.top_right, TILES.bottom_left, TILES.bottom_right],
    thirds: [[0, 0, 1 / 3, 1], [1 / 3, 0, 1 / 3, 1], [2 / 3, 0, 1 / 3, 1]],
};

/** The places for `count` windows in `layout`, or in a grid that fits them when it names none. */
export function slotsFor(layout, count) {
    if (LAYOUTS[layout])
        return LAYOUTS[layout];
    if (count <= 1)
        return [[0, 0, 1, 1]];
    if (count <= 4)
        return [LAYOUTS.halves, LAYOUTS.thirds, LAYOUTS.quarters][count - 2];
    const columns = 3;
    const rows = Math.ceil(count / columns);
    return Array.from({length: count}, (_, i) =>
        [(i % columns) / columns, Math.floor(i / columns) / rows, 1 / columns, 1 / rows]);
}

/** An action that could not be done, and why. */
export function failed(detail) {
    return {ok: false, detail};
}

// What an action returned, as {ok, detail}: nothing (or a call's reply) is done, a string says what it
// did, an {ok, detail} is taken as it is, and false, '' or null (a failed call) is not done.
export function outcomeOf(outcome) {
    if (typeof outcome?.ok === 'boolean')
        return {ok: outcome.ok, detail: typeof outcome.detail === 'string' ? outcome.detail : ''};
    if (typeof outcome === 'string' && outcome)
        return {ok: true, detail: outcome};
    return {ok: outcome === undefined || outcome === true || Array.isArray(outcome), detail: ''};
}
