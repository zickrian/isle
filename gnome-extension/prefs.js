// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Isle's Settings window: GSettings for the island and the assistant, plus what isled keeps itself
// (timer lengths, clipboard history, AI models), over D-Bus.

import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import Gtk from 'gi://Gtk';
import Pango from 'gi://Pango';
import PangoCairo from 'gi://PangoCairo';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {DesktopAppInfo} from './src/appInfo.js';
import {Bot, COLORS, SHAPES, paletteFor} from './src/bot.js';
import {paintRim} from './src/glow.js';
import * as WorldClocks from './src/worldClocks.js';

const DAEMON = 'io.github.zickrian.isle.Daemon';
const DAEMON_PATH = '/io/github/zickrian/isle/Daemon';
const POMODORO_INTERFACE = 'io.github.zickrian.isle.Pomodoro1';
const CLIPBOARD_INTERFACE = 'io.github.zickrian.isle.Clipboard1';
const AGENTS_INTERFACE = 'io.github.zickrian.isle.Agents1';
const ASSISTANT_INTERFACE = 'io.github.zickrian.isle.Assistant1';
/** Edits to the timer are sent once typing pauses for this long. */
const SAVE_DELAY_MS = 400;

// Runs in a process of its own when Settings opens, never inside GNOME Shell.
export default class IslePreferences extends ExtensionPreferences {
    // Island, Clipboard, Timer, Assistant, AI Usage and About, in that order.
    fillPreferencesWindow(window) {
        const settings = this.getSettings();
        window.set_default_size(560, 680);
        window.add(this._islandPage(settings, window));
        window.add(this._clipboardPage(settings, window));
        window.add(this._timerPage(settings, window));
        window.add(this._voicePage(settings, window));
        window.add(this._usagePage(settings));
        window.add(this._aboutPage(settings, window));
        // A page asked for by the island (its Update button: About), once, also while open.
        const showAsked = () => {
            const asked = settings.get_string('prefs-page');
            if (!asked)
                return false;
            settings.reset('prefs-page');
            window.visible_page_name = asked;
            return true;
        };
        // Asked while open (perhaps behind other windows): brought forward too.
        const asked = settings.connect('changed::prefs-page', () => showAsked() && window.present());
        window.connect('close-request', () => {
            settings.disconnect(asked);
            return false;
        });
        showAsked();
    }

    // The version, where to get help, a bug report to paste, and a way back to the defaults.
    _aboutPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'About', name: 'about', icon_name: 'help-about-symbolic'});
        const about = new Adw.PreferencesGroup({title: `Isle ${this.metadata['version-name'] ?? ''}`.trim(),
            description: 'A notch-style island for GNOME. © 2026 zickrian, free software under the GPL.'});
        const link = (title, subtitle, url) => {
            const row = new Adw.ActionRow({title, subtitle, activatable: true});
            row.add_suffix(new Gtk.Image({icon_name: 'adw-external-link-symbolic'}));
            row.connect('activated', () => new Gtk.UriLauncher({uri: url}).launch(window, null, null));
            return row;
        };
        // Whether a newer Isle is out, as isled last found, and the switch for asking.
        for (const row of updateRows(settings, window, this.metadata['version-name'] ?? '', this.path))
            about.add(row);
        about.add(link('Website', 'Features, installing and updating', 'https://github.com/zickrian/isle'));
        about.add(link('Report a problem', 'On GitHub; paste the report below in it', 'https://github.com/zickrian/isle/issues/new/choose'));
        const report = new Adw.ActionRow({title: 'Copy a bug report', subtitle: 'What’s installed, what works, and recent activity, ready to paste into a report',
            activatable: true});
        report.add_suffix(new Gtk.Image({icon_name: 'edit-copy-symbolic'}));
        report.connect('activated', () => copyReport(window, report));
        about.add(report);
        page.add(about);

        const reset = new Adw.PreferencesGroup({title: 'Settings'});
        const resetRow = new Adw.ActionRow({title: 'Reset all settings', subtitle: 'Back to how Isle came; your data stays',
            activatable: true});
        resetRow.connect('activated', () => confirm(window, {
            heading: 'Reset all of Isle’s settings?',
            body: 'Every option goes back to its default. Your tasks, events, clipboard history and files stay.',
            action: 'Reset',
        }, () => {
            // Not Isle's state: which update was announced, the page asked for, and a focus session's Do Not Disturb.
            const state = ['update-shown', 'prefs-page', 'focus-dnd-owned', 'focus-dnd-declined'];
            for (const key of settings.settings_schema.list_keys().filter(key => !state.includes(key)))
                settings.reset(key);
        }));
        reset.add(resetRow);
        page.add(reset);
        return page;
    }

    // AI plan usage: only the providers signed in on this computer are listed.
    _usagePage(settings) {
        const page = new Adw.PreferencesPage({title: 'AI Usage', icon_name: 'power-profile-performance-symbolic'});
        const found = usageProviders();
        const group = new Adw.PreferencesGroup({
            title: 'AI Usage',
            description: found.length
                ? 'How much of your plans\' limits is used, on a Usage page in the open island, with a warning ' +
                  'as one nears its end. Found from the apps you are signed in to; nothing else to set up.'
                : 'Sign in to Claude Code, Codex or Grok and your plan shows up here.',
        });
        const enabled = switchRow(settings, 'usage-enabled', 'Show AI usage', 'The Usage page and its warnings');
        group.add(enabled);
        const rows = found.map(({key, title, subtitle}) => switchRow(settings, key, title, subtitle));
        const warn = spinRow(settings, 'usage-warn', 'Warn at', 'Share of a limit, in %', 50, 99);
        const critical = spinRow(settings, 'usage-critical', 'Warn again at', 'Share of a limit, in %', 50, 100);
        // The second warning never comes before the first.
        settings.connect('changed::usage-warn', () => {
            if (settings.get_int('usage-critical') < settings.get_int('usage-warn'))
                settings.set_int('usage-critical', settings.get_int('usage-warn'));
        });
        settings.connect('changed::usage-critical', () => {
            if (settings.get_int('usage-critical') < settings.get_int('usage-warn'))
                settings.set_int('usage-warn', settings.get_int('usage-critical'));
        });
        for (const row of found.length ? [...rows, warn, critical] : []) {
            settings.bind('usage-enabled', row, 'sensitive', Gio.SettingsBindFlags.GET);
            group.add(row);
        }
        enabled.sensitive = found.length > 0;
        page.add(group);

        // Only the AIs found on this computer; none, and the group is not there at all.
        const agents = agentsFound();
        if (agents.length) {
            const agentGroup = new Adw.PreferencesGroup({
                title: 'AI Agents',
                description: 'Answer your coding agents from the island when they ask, and know when they are done. ' +
                    'On by default; off, Isle stops getting that agent\'s alerts.',
            });
            for (const {provider, title, subtitle} of agents) {
                agentGroup.add(switchRow(settings, `agent-alerts-${provider}`, title, subtitle));
            }
            page.add(agentGroup);
        }
        return page;
    }

    // The assistant: which AI and model, speech, the conversation, and its look.
    _voicePage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Assistant', icon_name: 'audio-input-microphone-symbolic'});
        const installed = AI_PROVIDERS.filter(provider => findProgram(provider.command));
        const group = new Adw.PreferencesGroup({
            title: 'Voice Assistant',
            description: 'Press the shortcut (or the ✦ in the open island) and speak. Speech is recognised on this ' +
                'computer (Set up downloads it, once); the request goes to the AI you pick, with your ' +
                'own sign-in and plan.',
        });
        group.add(switchRow(settings, 'voice-assistant', 'AI Assistant',
            'The shortcut and the ✦ in the open island. Off: Isle never asks an AI'));
        group.add(shortcutRow(settings, 'voice-shortcut', 'Shortcut', 'Opens the assistant and listens'));

        // Automatic is the first signed in, else the first installed: as isled picks (brain.rs `pick`).
        const automatic = installed.find(p => signedIn(p.id)) ?? installed[0];
        // Only the AIs installed here are offered; with none, the assistant says how to get one.
        const provider = choiceRow(settings, 'voice-provider', 'AI', installed.length
            ? 'Answers with your own sign-in; Isle runs its actions'
            : 'Install Claude Code, Codex, Grok or Antigravity (agy), and sign in', [
            ['auto', automatic ? `Automatic (${automatic.name})` : 'None installed'],
            ...installed.map(({id, name}) => [id, name]),
        ]);
        const model = new Adw.ComboRow({title: 'Model'});
        let modelChoices = [];
        let modelKey = null;
        // Swapping the list moves the selection; that must not write a model of its own.
        let syncing = false;
        const syncModel = () => {
            syncing = true;
            try {
                fillModel();
            } finally {
                syncing = false;
            }
        };
        // Each AI's plan and the models it allows, as isled last found them (`Assistant1.Models`).
        const catalog = new ModelCatalog(settings);
        const fillModel = () => {
            const wanted = settings.get_string('voice-provider');
            const current = installed.find(p => p.id === wanted) ?? automatic;
            model.visible = Boolean(current);
            if (!current)
                return;
            modelKey = current.modelKey;
            const entry = catalog.of(current.id);
            const value = settings.get_string(modelKey);
            // Only what the plan allows; until isled has asked, just the AI's own default.
            const def = entry?.default_name ? `Default (${entry.default_name})` : `${current.name}’s default`;
            modelChoices = [['', def], ...(entry?.models ?? []).map(({id, name}) => [id, name])];
            // A pick the plan no longer allows stays (it comes back once allowed), marked as not used now.
            if (!modelChoices.some(([id]) => id === value)) {
                const known = entry?.models?.length > 0;
                const shown = value[0].toUpperCase() + value.slice(1);
                modelChoices.push([value, known ? `${shown} · not on your plan` : shown]);
            }
            const about = entry?.plan ? `${current.planName} ${entry.plan} · ${current.about}`
                : current.about[0].toUpperCase() + current.about.slice(1);
            model.subtitle = entry || catalog.loaded ? about : 'Checking which models your plan includes…';
            model.model = Gtk.StringList.new(modelChoices.map(([, label]) => label));
            model.selected = Math.max(0, modelChoices.findIndex(([id]) => id === value));
        };
        model.connect('notify::selected', () => {
            if (syncing)
                return;
            const value = modelChoices[model.selected]?.[0];
            if (modelKey && value !== undefined && value !== settings.get_string(modelKey))
                settings.set_string(modelKey, value);
        });
        const changed = settings.connect('changed::voice-provider', syncModel);
        catalog.connect(syncModel);
        // Closed, not just destroyed: the settings' handler would keep the row (and this) alive.
        window.connect('close-request', () => {
            settings.disconnect(changed);
            catalog.destroy();
            return false;
        });
        syncModel();

        const options = [provider, model];
        options.push(choiceRow(settings, 'voice-speech-model', 'Speech recognition', 'Bigger is more accurate, and slower; downloaded once', [
            ['tiny', 'Tiny (44 MB)'],
            ['base', 'Base (82 MB)'],
            ['small', 'Small (265 MB)'],
            ['medium', 'Medium (823 MB)'],
        ]));
        options.push(choiceRow(settings, 'voice-language', 'Language', 'The language you speak', [
            ['', 'Any (detected)'],
            ['id,en', 'Indonesian or English'],
            ['id', 'Indonesian'],
            ['en', 'English'],
        ]));
        options.push(choiceRow(settings, 'voice-keep-chat', 'Keep the conversation', 'Never more than a day; then it is deleted, with the AI\'s copy', [
            ['day', 'Until midnight'],
            ['idle-2h', '2 hours without a word'],
            ['idle-30m', '30 minutes without a word'],
        ]));
        const clearChat = new Adw.ActionRow({title: 'Clear the conversation now', subtitle: 'Deletes it here and the AI\'s copy of it',
            activatable: true});
        clearChat.add_suffix(new Gtk.Image({icon_name: 'user-trash-symbolic'}));
        clearChat.connect('activated', () => confirm(clearChat.get_root(), {
            heading: 'Clear the conversation?',
            body: 'The assistant starts afresh; what was said is deleted here and from the AI\'s own history on this computer.',
            action: 'Clear',
        }, () => Gio.DBus.session.call(DAEMON, DAEMON_PATH, ASSISTANT_INTERFACE, 'ClearChat', null, null,
            Gio.DBusCallFlags.NONE, -1, null, null)));
        options.push(clearChat);
        options.push(switchRow(settings, 'voice-use-selection', 'Use selected text',
            'Send the text you have selected, so the AI can work on it; never from terminals or password managers'));
        options.push(switchRow(settings, 'voice-read-notifications', 'Read notifications',
            'Let the AI read your recent notifications when you ask about them'));
        for (const row of options) {
            settings.bind('voice-assistant', row, 'sensitive', Gio.SettingsBindFlags.GET);
            group.add(row);
        }
        page.add(group);
        const look = lookGroup(settings);
        settings.bind('voice-assistant', look, 'sensitive', Gio.SettingsBindFlags.GET);
        page.add(look);

        const notes = new Adw.PreferencesGroup({
            title: 'About the AIs',
            description: 'Claude Code and Codex answer within your Claude or ChatGPT plan\'s limits. Antigravity\'s ' +
                'terms bar third-party tools from its service; Isle only runs the official agy app, but use it at ' +
                'your own risk. Each runs kept to answering: commands and file changes go through Isle, which ' +
                'asks you first.',
        });
        page.add(notes);
        return page;
    }

    // History on or off, clearing it, and the apps whose copies are never kept.
    _clipboardPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Clipboard', icon_name: 'edit-paste-symbolic'});

        const history = new Adw.PreferencesGroup({
            title: 'Clipboard History',
            description: 'Super+V opens it. Everything stays on this computer.',
        });
        history.add(switchRow(settings, 'clipboard-history', 'Keep clipboard history',
            'Text, links, images and files you copy. Passwords from password managers are never kept.'));
        history.add(choiceRow(settings, 'super-v', 'Super+V', 'GNOME’s calendar shortcut', [
            ['isle', 'Isle’s clipboard history'],
            ['gnome', 'GNOME’s calendar and notifications'],
        ]));
        history.add(choiceRow(settings, 'clipboard-layout', 'Layout', 'How copied items are arranged', [
            ['horizontal', 'Horizontal'],
            ['vertical', 'Vertical'],
        ]));
        const width = Adw.SpinRow.new_with_range(400, 1200, 20);
        width.title = 'Width';
        width.subtitle = 'In pixels';
        settings.bind('clipboard-width', width, 'value', Gio.SettingsBindFlags.DEFAULT);
        history.add(width);
        const height = Adw.SpinRow.new_with_range(150, 800, 20);
        height.title = 'Height';
        height.subtitle = 'In pixels';
        settings.bind('clipboard-height', height, 'value', Gio.SettingsBindFlags.DEFAULT);
        const layoutChanged = settings.connect('changed::clipboard-layout', () => {
            const vertical = settings.get_string('clipboard-layout') === 'vertical';
            const current = settings.get_int('clipboard-height');
            if (vertical && current === 150)
                settings.set_int('clipboard-height', 360);
            else if (!vertical && current === 360)
                settings.reset('clipboard-height');
        });
        height.connect('destroy', () => settings.disconnect(layoutChanged));
        history.add(height);
        history.add(switchRow(settings, 'clipboard-paste-keyboard', 'Auto-paste with keyboard',
            'Pressing Enter pastes into the active window; when off, it only copies'));
        history.add(switchRow(settings, 'clipboard-paste-mouse', 'Auto-paste on click',
            'Clicking an item pastes into the active window; when off, it only copies'));
        const clear = new Adw.ActionRow({title: 'Clear history', subtitle: 'Pinned items are kept'});
        const clearButton = new Gtk.Button({label: 'Clear…', valign: Gtk.Align.CENTER});
        clearButton.connect('clicked', () => confirmClear(window));
        clear.add_suffix(clearButton);
        history.add(clear);
        page.add(history);

        const ignored = new Adw.PreferencesGroup({
            title: 'Never Keep Copies From',
            description: 'Known password managers are on the list from the start.',
        });
        page.add(ignored);
        fillIgnoredApps(ignored, settings);
        return page;
    }

    // Look, pages, world clocks, alerts and calls.
    _islandPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Island', icon_name: 'preferences-desktop-appearance-symbolic'});

        const look = new Adw.PreferencesGroup({title: 'Appearance'});
        look.add(choiceRow(settings, 'island-theme', 'Island', 'Black, or clear glass that shows what is behind it, blurred', [
            ['black', 'Black'],
            ['glass', 'Glass'],
        ]));
        look.add(glassRow(settings, window));
        look.add(topBarRow(settings, window));
        look.add(switchRow(settings, 'compact-top-bar', 'Compact top bar', 'A slimmer top bar that frames the island like a bezel'));
        look.add(switchRow(settings, 'island-in-top-bar', 'Island inside the top bar',
            'Like a notch: the closed island never covers windows'));
        // One of the two, as the island sits: below the bar, or inside it.
        const depth = spinRow(settings, 'notch-depth', 'Island height', 'How far the closed island hangs below the top bar, in pixels', 24, 40);
        settings.bind('island-in-top-bar', depth, 'visible', Gio.SettingsBindFlags.GET | Gio.SettingsBindFlags.INVERT_BOOLEAN);
        look.add(depth);
        const gap = switchRow(settings, 'notch-gap', 'Space below the island',
            'A little room between the closed island and the windows below');
        settings.bind('island-in-top-bar', gap, 'visible', Gio.SettingsBindFlags.GET);
        look.add(gap);
        look.add(switchRow(settings, 'privacy-indicators', 'Privacy indicators', 'Dots when the camera, microphone or screen sharing is in use'));
        look.add(choiceRow(settings, 'island-monitor', 'Display', 'With more than one display, where the island is', [
            ['primary', 'Main display'],
            ['active', 'Display in use'],
        ]));
        look.add(choiceRow(settings, 'open-on', 'Open', 'How the closed island opens', [
            ['hover', 'On hover'],
            ['click', 'On click'],
        ]));
        const delay = Adw.SpinRow.new_with_range(60, 1000, 20);
        delay.title = 'Rest before opening';
        delay.subtitle = 'In milliseconds';
        settings.bind('hover-delay', delay, 'value', Gio.SettingsBindFlags.DEFAULT);
        const byHover = () => (delay.sensitive = settings.get_string('open-on') === 'hover');
        settings.connect('changed::open-on', byHover);
        byHover();
        look.add(delay);
        page.add(look);
        page.add(pagesGroup(settings, window));
        page.add(appUsageGroup(settings, window));
        page.add(worldClocksGroup(settings, window));

        const alerts = new Adw.PreferencesGroup({title: 'Alerts'});
        // On: in the island; off: left to GNOME's own banners (`gnome-banners`).
        const notifications = new Adw.SwitchRow({title: 'Notifications',
            subtitle: 'Apps’ notifications in the island, with their buttons, as GNOME shows them'});
        settings.bind('gnome-banners', notifications, 'active', Gio.SettingsBindFlags.INVERT_BOOLEAN);
        alerts.add(notifications);
        alerts.add(switchRow(settings, 'replace-osd', 'Volume and brightness', 'Show them in the island instead of the centre of the screen'));
        alerts.add(switchRow(settings, 'alert-power', 'Charging and battery', 'Plugged in, unplugged, full and low'));
        alerts.add(switchRow(settings, 'alert-network', 'Network', 'When the connection drops'));
        alerts.add(switchRow(settings, 'alert-bluetooth', 'Bluetooth', 'Devices connecting, with their battery'));
        alerts.add(switchRow(settings, 'alert-caps-lock', 'Caps Lock', 'When it turns on or off'));
        alerts.add(switchRow(settings, 'event-alerts', 'Calendar events',
            'Before each event with a time, with Join for a Meet, Zoom or Teams link'));
        const eventMinutes = spinRow(settings, 'event-alert-minutes', 'Minutes before an event', null, 1, 60);
        settings.bind('event-alerts', eventMinutes, 'sensitive', Gio.SettingsBindFlags.GET);
        alerts.add(eventMinutes);
        alerts.add(switchRow(settings, 'track-peek', 'New song', 'Briefly show the song when the track changes'));
        alerts.add(switchRow(settings, 'lyrics-online', 'Lyrics', 'Look up the playing song’s lyrics on LRCLIB'));
        alerts.add(switchRow(settings, 'chimes', 'Sounds', 'Chime when a focus session or break ends, and for reminders'));
        page.add(alerts);

        const calls = new Adw.PreferencesGroup({
            title: 'Calls',
            description: 'WhatsApp, Telegram, Meet and other calls, in any app or browser.',
        });
        calls.add(switchRow(settings, 'call-activity', 'Calls in the island', 'The call’s length, mute and a way back to it'));
        const preview = switchRow(settings, 'call-preview', 'Live preview',
            'See yourself and whoever you call, live in the open island');
        settings.bind('call-activity', preview, 'sensitive', Gio.SettingsBindFlags.GET);
        calls.add(preview);
        page.add(calls);
        return page;
    }

    // Lengths live in isled, so this page needs it running; changes are saved as typing pauses.
    _timerPage(settings, window) {
        const page = new Adw.PreferencesPage({title: 'Timer', icon_name: 'alarm-symbolic'});
        const focus = new Adw.PreferencesGroup({title: 'While Focusing'});
        focus.add(switchRow(settings, 'focus-dnd', 'Do Not Disturb', 'Silence notifications during focus sessions, and restore them afterwards'));
        page.add(focus);

        const group = new Adw.PreferencesGroup({
            title: 'Pomodoro',
            description: 'Focus sessions with short breaks, and a long break after a few sessions.',
        });
        page.add(group);

        let proxy = null;
        let config = null;
        try {
            proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE,
                null, DAEMON, DAEMON_PATH, POMODORO_INTERFACE, null);
            config = JSON.parse(proxy.get_cached_property('Config')?.unpack() ?? 'null');
        } catch (e) {
            console.warn(`Isle: could not read the timer settings: ${e.message}`);
        }
        if (!config) {
            group.add(new Adw.ActionRow({
                title: 'The timer settings aren’t available right now',
                subtitle: 'Isle isn’t running in the background. Log out and back in, or install Isle again.',
            }));
            return page;
        }

        let saveId = 0;
        const save = () => {
            if (saveId)
                GLib.source_remove(saveId);
            saveId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, SAVE_DELAY_MS, () => {
                saveId = 0;
                proxy.call('SetConfig', new GLib.Variant('(s)', [JSON.stringify(config)]),
                    Gio.DBusCallFlags.NONE, -1, null, null);
                return GLib.SOURCE_REMOVE;
            });
        };
        // Don't lose the last change when the window closes before it is saved.
        window.connect('close-request', () => {
            if (!saveId)
                return false;
            GLib.source_remove(saveId);
            saveId = 0;
            try {
                proxy.call_sync('SetConfig', new GLib.Variant('(s)', [JSON.stringify(config)]),
                    Gio.DBusCallFlags.NONE, -1, null);
            } catch (e) {
                console.warn(`Isle: could not save the timer settings: ${e.message}`);
            }
            return false;
        });
        const number = (key, title, min, max) => {
            const row = Adw.SpinRow.new_with_range(min, max, 1);
            row.title = title;
            row.value = config[key];
            row.connect('notify::value', () => {
                config[key] = row.value;
                save();
            });
            return row;
        };
        const toggle = (key, title, subtitle) => {
            const row = new Adw.SwitchRow({title, subtitle, active: config[key]});
            row.connect('notify::active', () => {
                config[key] = row.active;
                save();
            });
            return row;
        };

        group.add(number('focus_minutes', 'Focus (minutes)', 1, 180));
        group.add(number('short_break_minutes', 'Short break (minutes)', 1, 60));
        group.add(number('long_break_minutes', 'Long break (minutes)', 1, 120));
        group.add(number('sessions_before_long_break', 'Sessions before a long break', 1, 12));
        group.add(toggle('auto_start_breaks', 'Start breaks automatically', null));
        group.add(toggle('auto_start_focus', 'Start focus automatically', 'After a break ends'));
        return page;
    }
}

/** The assistant's shape and colours as Settings has them (see bot.js). */
function lookOf(settings) {
    return {shape: settings.get_string('bot-shape'),
        palette: paletteFor(settings.get_string('bot-color'), settings.get_string('bot-glow'))};
}

/** A Gdk.RGBA as "#rrggbb", as the colour keys store it. */
const hexOf = rgba => `#${[rgba.red, rgba.green, rgba.blue].map(v => Math.round(v * 255).toString(16).padStart(2, '0')).join('')}`;

/** A still copy of the assistant `size` px big, redrawn by `update(look)`. */
function botTile(size, look) {
    const area = new Gtk.DrawingArea({content_width: size, content_height: size});
    let bot = null;
    const update = next => {
        bot = new Bot(next);
        bot.holdEyes();
        for (let t = 1 / 30; t <= 0.7; t += 1 / 30)
            bot.step(t, {x: 0.12, y: 0.06});
        area.queue_draw();
    };
    area.set_draw_func((_area, cr) => bot.paint(cr, size));
    update(look);
    return {area, update};
}

// A row of picks (`choices`: [[value, child]…]) as toggles in a flowing grid, `key`'s value pressed.
function pickerRow(settings, key, title, choices, {custom = null, perLine = 8, least = 4} = {}) {
    const row = new Adw.PreferencesRow({activatable: false});
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 8, margin_top: 12, margin_bottom: 12,
        margin_start: 12, margin_end: 12});
    box.append(new Gtk.Label({label: title, xalign: 0, css_classes: ['heading']}));
    // Up to `perLine` on a line, fewer in a narrow window: never wider than the window.
    const flow = new Gtk.FlowBox({selection_mode: Gtk.SelectionMode.NONE, homogeneous: true, max_children_per_line: perLine,
        min_children_per_line: least, column_spacing: 2, row_spacing: 2});
    const buttons = [];
    let syncing = false;
    for (const [value, child, tooltip] of choices) {
        const button = new Gtk.ToggleButton({child, css_classes: ['flat'], tooltip_text: tooltip, halign: Gtk.Align.CENTER,
            group: buttons[0] ?? null});
        button.connect('toggled', () => {
            if (!syncing && button.active && settings.get_string(key) !== value)
                settings.set_string(key, value);
        });
        buttons.push(button);
        flow.append(button);
    }
    if (custom)
        flow.append(custom);
    const sync = () => {
        syncing = true;
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        if (index >= 0)
            buttons[index].active = true;
        else
            buttons.forEach(button => (button.active = false));
        syncing = false;
    };
    const changed = settings.connect(`changed::${key}`, sync);
    row.connect('destroy', () => settings.disconnect(changed));
    sync();
    box.append(flow);
    row.set_child(box);
    return row;
}

// The assistant's look: a live preview of it in the island's pill (listening, thinking, glad), its shape,
// its colour and the light it brings to the island.
function lookGroup(settings) {
    const group = new Adw.PreferencesGroup({title: 'Look', description: 'How the assistant looks, and the light it brings to the island.'});
    const bot = new Bot(lookOf(settings));
    const cache = {};
    const motion = {time: 0, level: 0};
    const preview = new Gtk.DrawingArea({content_height: 128, hexpand: true});
    preview.set_draw_func((area, cr, width, height) => {
        const w = Math.min(380, width - 32), h = 72, x = Math.round((width - w) / 2), y = Math.round((height - h) / 2);
        cr.translate(x, y);
        const r = 26;
        cr.moveTo(0, 0);
        cr.lineTo(w, 0);
        cr.arc(w - r, h - r, r, 0, Math.PI / 2);
        cr.arc(r, h - r, r, Math.PI / 2, Math.PI);
        cr.closePath();
        cr.setSourceRGBA(0, 0, 0, 1);
        cr.fillPreserve();
        cr.save();
        cr.clip();
        paintRim(cr, {left: 0, right: w, top: 0, radius: r}, h, bot.palette.glow, motion, 1, cache);
        cr.restore();
        cr.save();
        cr.translate(16, (h - 40) / 2 - 3);
        bot.paint(cr, 40);
        cr.restore();
        const layout = PangoCairo.create_layout(cr);
        layout.set_font_description(Pango.FontDescription.from_string('Sans 600 11'));
        layout.set_text(motion.caption, -1);
        const [, extents] = layout.get_pixel_extents();
        cr.moveTo(68, (h - extents.height) / 2 - 3);
        cr.setSourceRGBA(1, 1, 1, motion.dim ? 0.6 : 0.95);
        PangoCairo.show_layout(cr, layout);
    });
    // A little play, over and over: it listens to you speak, thinks, then is glad it got it done.
    let start = null;
    let form = null;
    preview.add_tick_callback((area, clock) => {
        const now = clock.get_frame_time() / 1e6;
        start ??= now;
        const t = now - start, at = t % 10;
        const [next, caption, dim] = at < 4.5 ? ['listening', 'Listening…', true] : at < 7 ? ['thinking', 'Searching the web…', true]
            : ['success', 'LibreOffice is installed.', false];
        if (next !== form) {
            form = next;
            bot.setForm(form);
        }
        const speaking = at > 0.8 && at < 3.6 ? Math.max(0, Math.sin(at * 9) * 0.5 + Math.sin(at * 3.7) * 0.4) : 0;
        motion.level = form === 'listening' ? speaking : form === 'thinking' ? 0.34 + 0.08 * Math.sin(t * 1.8) : 0.15;
        motion.time = t * (form === 'thinking' ? 1.6 : 1);
        motion.caption = caption;
        motion.dim = dim;
        bot.step(t, null, form === 'listening' ? speaking : 0);
        area.queue_draw();
        return GLib.SOURCE_CONTINUE;
    });
    group.add(new Adw.PreferencesRow({child: preview, activatable: false}));

    const tiles = [];
    const shapes = pickerRow(settings, 'bot-shape', 'Shape', Object.entries(SHAPES).map(([shape, {label}]) => {
        const tile = botTile(34, {...lookOf(settings), shape});
        tiles.push([shape, tile]);
        return [shape, tile.area, label];
    }), {perLine: 4, least: 4});
    group.add(shapes);

    // A colour of your own: the picker's own button, showing the colour once there is one.
    const customTile = botTile(26, {shape: 'circle', palette: paletteFor(settings.get_string('bot-color'))});
    const customIcon = new Gtk.Image({icon_name: 'color-select-symbolic', pixel_size: 18});
    const customColor = new Gtk.ToggleButton({css_classes: ['flat'], tooltip_text: 'A colour of your own', halign: Gtk.Align.CENTER});
    const syncCustom = () => {
        const color = settings.get_string('bot-color');
        const own = color.startsWith('#');
        if (own)
            customTile.update({shape: 'circle', palette: paletteFor(color)});
        customColor.child = own ? customTile.area : customIcon;
        customColor.active = own;
    };
    customColor.connect('clicked', () => {
        syncCustom();
        const initial = new Gdk.RGBA();
        initial.parse(settings.get_string('bot-color').startsWith('#') ? settings.get_string('bot-color') : '#8e7dff');
        new Gtk.ColorDialog({title: 'Assistant colour', with_alpha: false}).choose_rgba(customColor.get_root(), initial, null,
            (dialog, result) => {
                try {
                    settings.set_string('bot-color', hexOf(dialog.choose_rgba_finish(result)));
                } catch {
                    // Cancelled: as it was.
                }
            });
    });
    const colors = pickerRow(settings, 'bot-color', 'Colour', Object.entries(COLORS).map(([color, {label}]) =>
        [color, botTile(26, {shape: 'circle', palette: paletteFor(color)}).area, label]), {custom: customColor, perLine: 6, least: 6});
    syncCustom();
    group.add(colors);

    const glow = new Adw.ComboRow({title: 'Glow', subtitle: 'The light along the island\'s edge',
        model: Gtk.StringList.new(['Match', 'Classic', 'Custom'])});
    const glowColor = new Gtk.ColorDialogButton({dialog: new Gtk.ColorDialog({title: 'Glow colour', with_alpha: false}),
        valign: Gtk.Align.CENTER});
    glow.add_suffix(glowColor);
    let syncingGlow = false;
    const syncGlow = () => {
        syncingGlow = true;
        const value = settings.get_string('bot-glow');
        glow.selected = value === 'match' ? 0 : value === 'classic' ? 1 : 2;
        glowColor.visible = glow.selected === 2;
        if (value.startsWith('#')) {
            const rgba = new Gdk.RGBA();
            rgba.parse(value);
            glowColor.rgba = rgba;
        }
        syncingGlow = false;
    };
    glow.connect('notify::selected', () => {
        if (syncingGlow)
            return;
        settings.set_string('bot-glow', ['match', 'classic', hexOf(glowColor.rgba)][glow.selected]);
    });
    glowColor.connect('notify::rgba', () => {
        if (!syncingGlow && glow.selected === 2)
            settings.set_string('bot-glow', hexOf(glowColor.rgba));
    });
    group.add(glow);

    // Each change shows at once: the preview morphs, the tiles take the new colour.
    const changed = ['bot-shape', 'bot-color', 'bot-glow'].map(key => settings.connect(`changed::${key}`, () => {
        const look = lookOf(settings);
        bot.palette = look.palette;
        bot.setShape(look.shape);
        for (const [shape, tile] of tiles)
            tile.update({...look, shape});
        syncCustom();
        syncGlow();
    }));
    group.connect('destroy', () => changed.forEach(id => settings.disconnect(id)));
    syncGlow();
    return group;
}

/** The AI agents isled found installed: `{provider, title, subtitle}` each. */
function agentsFound() {
    let agents = {};
    try {
        const proxy = Gio.DBusProxy.new_for_bus_sync(Gio.BusType.SESSION, Gio.DBusProxyFlags.NONE,
            null, DAEMON, DAEMON_PATH, AGENTS_INTERFACE, null);
        agents = JSON.parse(proxy.get_cached_property('Agents')?.unpack() ?? '{}');
    } catch (e) {
        console.warn(`Isle: could not ask which AI agents are installed: ${e.message}`);
    }
    return [
        {provider: 'claude', title: 'Claude Code', subtitle: 'Allow, deny or always allow, and when it is done'},
        {provider: 'codex', title: 'Codex', subtitle: 'Allow or deny, and when it is done · in Codex, type /hooks once and allow Isle'},
    ].filter(({provider}) => agents[provider]?.found);
}

/** A switch bound to a boolean key. */
function switchRow(settings, key, title, subtitle) {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** The top bar beside the island, from glass to black, on a slider; the island itself stays black. */
/** How dark the Glass look is, Clear to Dark; shown only while the island is glass. */
function glassRow(settings, window) {
    const row = new Adw.ActionRow({title: 'Glass'});
    const scale = new Gtk.Scale({
        adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 25}),
        draw_value: false, width_request: 150, valign: Gtk.Align.CENTER,
    });
    const ends = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
    ends.append(new Gtk.Label({label: 'Clear', css_classes: ['dim-label', 'caption']}));
    ends.append(scale);
    ends.append(new Gtk.Label({label: 'Dark', css_classes: ['dim-label', 'caption']}));
    row.add_suffix(ends);
    row.activatable_widget = scale;
    const describe = value => {
        row.subtitle = value <= 0 ? 'Clear glass: what is behind shows through'
            : value >= 100 ? 'Dark frosted glass' : `${value}% darker`;
    };
    let syncing = false;
    scale.connect('value-changed', () => {
        if (syncing)
            return;
        // Stored in steps of 5; the knob stays under the pointer meanwhile.
        const value = Math.round(scale.get_value() / 5) * 5;
        describe(value);
        if (settings.get_int('glass-tint') !== value)
            settings.set_int('glass-tint', value);
    });
    const sync = () => {
        const value = settings.get_int('glass-tint');
        if (Math.round(scale.get_value() / 5) * 5 !== value) {
            syncing = true;
            scale.set_value(value);
            syncing = false;
        }
        describe(value);
        row.visible = settings.get_string('island-theme') === 'glass';
    };
    const changed = ['glass-tint', 'island-theme'].map(key => settings.connect(`changed::${key}`, sync));
    window.connect('close-request', () => {
        changed.forEach(id => settings.disconnect(id));
        return false;
    });
    sync();
    return row;
}

function topBarRow(settings, window) {
    const row = new Adw.ActionRow({title: 'Top bar'});
    const scale = new Gtk.Scale({
        adjustment: new Gtk.Adjustment({lower: 0, upper: 100, step_increment: 5, page_increment: 25}),
        draw_value: false, width_request: 150, valign: Gtk.Align.CENTER,
    });
    scale.add_mark(50, Gtk.PositionType.BOTTOM, null);
    const ends = new Gtk.Box({spacing: 6, valign: Gtk.Align.CENTER});
    ends.append(new Gtk.Label({label: 'Glass', css_classes: ['dim-label', 'caption']}));
    ends.append(scale);
    ends.append(new Gtk.Label({label: 'Black', css_classes: ['dim-label', 'caption']}));
    row.add_suffix(ends);
    row.activatable_widget = scale;
    // Unset, the older Glass or Black choice says (as TopBar.opacity in shell.js).
    const current = () => settings.get_user_value('top-bar-opacity') ? settings.get_int('top-bar-opacity')
        : settings.get_string('top-bar-style') === 'black' ? 100 : 0;
    const describe = value => {
        row.subtitle = value <= 0 ? 'See-through glass' : value >= 100 ? 'The island blends into the bar'
            : `${value}% black`;
    };
    let syncing = false;
    scale.connect('value-changed', () => {
        if (syncing)
            return;
        // Stored in steps of 5; the knob stays under the pointer meanwhile.
        const value = Math.round(scale.get_value() / 5) * 5;
        describe(value);
        settings.set_int('top-bar-opacity', value);
        // Kept in step, for anything that still reads the older choice.
        const style = value >= 100 ? 'black' : 'glass';
        if (settings.get_string('top-bar-style') !== style)
            settings.set_string('top-bar-style', style);
    });
    const sync = () => {
        // Moved only for a change from elsewhere: the step the knob is in already is this one.
        if (Math.round(scale.get_value() / 5) * 5 !== current()) {
            syncing = true;
            scale.set_value(current());
            syncing = false;
        }
        describe(current());
    };
    const changed = ['top-bar-opacity', 'top-bar-style'].map(key => settings.connect(`changed::${key}`, sync));
    window.connect('close-request', () => {
        changed.forEach(id => settings.disconnect(id));
        return false;
    });
    sync();
    return row;
}

/** The open island's pages that can be left out, in tab order, with what goes with each. */
const PAGES = [
    ['music', 'Music', 'audio-x-generic-symbolic', 'The player and lyrics, and the song in the closed island'],
    ['notifications', 'Notifications', 'preferences-system-notifications-symbolic', 'The list to look back at, and its unread dot; alerts show either way'],
    ['focus', 'Timer', 'alarm-symbolic', 'Pomodoro focus sessions and breaks'],
    ['reminders', 'Reminders', 'object-select-symbolic', 'Your to-do list'],
    ['shelf', 'Shelf', 'edit-paste-symbolic', 'Clipboard history (Super+V) and the files tray'],
    ['calendar', 'Calendar', 'x-office-calendar-symbolic', 'The month, its events and world clocks'],
];

/** A switch per page; the last one on can't be turned off, so the island always has a page. */
function pagesGroup(settings, window) {
    const group = new Adw.PreferencesGroup({title: 'Pages', description: 'The tabs of the open island. Turn off the ones you don’t use.'});
    const rows = PAGES.map(([name, title, iconName, subtitle]) => {
        const row = new Adw.SwitchRow({title, subtitle});
        row.add_prefix(new Gtk.Image({icon_name: iconName}));
        row.connect('notify::active', () => {
            const hidden = settings.get_strv('hidden-pages').filter(other => other !== name);
            if (!row.active)
                hidden.push(name);
            if (hidden.join() !== settings.get_strv('hidden-pages').join())
                settings.set_strv('hidden-pages', hidden);
        });
        group.add(row);
        return [name, row];
    });
    // The Apps and Usage pages' own switches, here too, so every tab is in one place.
    const apps = switchRow(settings, 'app-usage', 'Apps', 'Time spent in each app, kept on this computer for 30 days');
    apps.add_prefix(new Gtk.Image({icon_name: 'view-app-grid-symbolic'}));
    group.add(apps);
    const usage = switchRow(settings, 'usage-enabled', 'AI Usage', 'Your AI plans’ limits, and warnings as one nears its end');
    usage.add_prefix(new Gtk.Image({icon_name: 'power-profile-performance-symbolic'}));
    if (!usageProviders().length) {
        usage.sensitive = false;
        usage.subtitle = 'Sign in to Claude Code, Codex or Grok to see your plan';
    }
    group.add(usage);
    // Not a page but the ✦ beside the tabs: turning it off is how to use Isle without any AI.
    const assistant = switchRow(settings, 'voice-assistant', 'AI Assistant', 'The ✦ in the open island and its shortcut');
    assistant.add_prefix(new Gtk.Image({icon_name: 'audio-input-microphone-symbolic'}));
    group.add(assistant);
    const sync = () => {
        const hidden = settings.get_strv('hidden-pages');
        const shown = rows.filter(([name]) => !hidden.includes(name));
        for (const [name, row] of rows) {
            row.active = !hidden.includes(name);
            const last = shown.length === 1 && row.active;
            row.sensitive = !last;
            row.subtitle = last ? 'The island keeps at least one page' : PAGES.find(([page]) => page === name)[3];
        }
    };
    const changed = settings.connect('changed::hidden-pages', sync);
    window.connect('close-request', () => {
        settings.disconnect(changed);
        return false;
    });
    sync();
    return group;
}

/** What the Apps page keeps, and a way to forget it; its switch is with the other pages. */
function appUsageGroup(settings, window) {
    const group = new Adw.PreferencesGroup({
        title: 'App Usage',
        description: 'With the Apps page on, the app in front is timed. Five minutes without input pause it, unless a video keeps the screen awake.',
    });
    const clear = new Adw.ActionRow({title: 'Clear app usage', subtitle: 'Forget every day recorded so far'});
    const button = new Gtk.Button({label: 'Clear…', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => confirm(window, {
        heading: 'Clear app usage?',
        body: 'Every app’s time recorded so far is removed. This cannot be undone.',
        action: 'Clear',
    }, () => settings.set_boolean('app-usage-clear', true)));
    clear.add_suffix(button);
    group.add(clear);
    return group;
}

/** GNOME's World Clocks: the cities, each with its time and a remove button, and a search to add one. */
function worldClocksGroup(settings, window) {
    const shell = WorldClocks.shellSettings();
    const group = new Adw.PreferencesGroup({
        title: 'World Clocks',
        description: 'The time in other cities on the Calendar page. The same list as GNOME’s calendar menu and Clocks app.',
    });
    const show = switchRow(settings, 'world-clocks', 'Show world clocks', 'Under the day’s events; click them for more');
    group.add(show);
    if (!shell) {
        show.sensitive = false;
        show.subtitle = 'GNOME’s world clocks are not available here';
        return group;
    }
    // ButtonRow since libadwaita 1.6 (GNOME 47).
    const add = Adw.ButtonRow ? new Adw.ButtonRow({title: 'Add a City…', start_icon_name: 'list-add-symbolic'})
        : new Adw.ActionRow({title: 'Add a City…', activatable: true});
    if (!Adw.ButtonRow)
        add.add_prefix(new Gtk.Image({icon_name: 'list-add-symbolic'}));
    add.connect('activated', () => chooseCity(group.get_root(), location => {
        const cities = WorldClocks.readCities(shell).map(city => city.location);
        if (!cities.some(other => other.equal(location)))
            WorldClocks.writeCities(shell, [...cities, location]);
    }));
    let rows = [];
    /** Each row's time and day, written again each minute while Settings is open. */
    let ticks = [];
    const refresh = () => {
        rows.forEach(row => group.remove(row));
        const cities = WorldClocks.readCities(shell);
        ticks = [];
        rows = cities.map(({location, name, timezone}) => {
            const country = location.get_country_name?.() ?? '';
            const row = new Adw.ActionRow({title: name});
            const time = new Gtk.Label({css_classes: ['numeric', 'dim-label'], valign: Gtk.Align.CENTER});
            row.add_suffix(time);
            const tick = () => {
                const now = GLib.DateTime.new_now_local();
                const when = [WorldClocks.dayText(timezone, now), WorldClocks.offsetText(timezone, now) || 'Same time as here']
                    .filter(Boolean).join(' · ');
                row.subtitle = [country, when].filter(Boolean).join(' · ');
                time.label = now.to_timezone(timezone).format(useTwelveHour() ? '%l:%M %p' : '%H:%M').trim();
            };
            tick();
            ticks.push(tick);
            const remove = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat'],
                tooltip_text: 'Remove this city'});
            remove.connect('clicked', () => WorldClocks.writeCities(shell,
                WorldClocks.readCities(shell).map(city => city.location).filter(other => !other.equal(location))));
            row.add_suffix(remove);
            settings.bind('world-clocks', row, 'sensitive', Gio.SettingsBindFlags.GET);
            return row;
        });
        group.remove(add);
        rows.forEach(row => group.add(row));
        group.add(add);
    };
    group.add(add);
    settings.bind('world-clocks', add, 'sensitive', Gio.SettingsBindFlags.GET);
    const changed = shell.connect('changed::locations', refresh);
    // At each minute's turn by the clock, so a suspend or a changed clock is caught up at the next.
    let timer = 0;
    const next = () => {
        timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, (60 - GLib.DateTime.new_now_local().get_second()) * 1000 + 50, () => {
            ticks.forEach(tick => tick());
            next();
            return GLib.SOURCE_REMOVE;
        });
    };
    next();
    window.connect('close-request', () => {
        shell.disconnect(changed);
        GLib.Source.remove(timer);
        return false;
    });
    refresh();
    return group;
}

/** Whether GNOME's clock is set to 12 hours. */
function useTwelveHour() {
    return new Gio.Settings({schema_id: 'org.gnome.desktop.interface'}).get_string('clock-format') === '12h';
}

/** A dialog to search GNOME's list of cities; `onPick` gets the one chosen. */
function chooseCity(window, onPick) {
    const cities = WorldClocks.allCities();
    const dialog = new Adw.Dialog({title: 'Add a City', content_width: 420, content_height: 480});
    const view = new Adw.ToolbarView();
    view.add_top_bar(new Adw.HeaderBar());
    const box = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL, spacing: 12, margin_start: 12, margin_end: 12, margin_bottom: 12});
    const search = new Gtk.SearchEntry({placeholder_text: 'Search for a city'});
    box.append(search);
    const list = new Gtk.ListBox({css_classes: ['boxed-list'], selection_mode: Gtk.SelectionMode.NONE, valign: Gtk.Align.START});
    const scroller = new Gtk.ScrolledWindow({child: list, vexpand: true, hscrollbar_policy: Gtk.PolicyType.NEVER});
    box.append(scroller);
    const empty = new Adw.StatusPage({icon_name: 'find-location-symbolic', title: 'Search for a City',
        description: 'Type a city’s name, like Tokyo or New York', vexpand: true});
    box.append(empty);
    view.set_content(box);
    dialog.set_child(view);
    const fill = () => {
        list.remove_all();
        const query = search.text.trim().toLowerCase();
        // Names starting with what was typed first: "par" finds Paris before Parramatta's suburbs.
        const starts = city => city.name.toLowerCase().startsWith(query);
        const found = query ? cities.filter(city => city.search.includes(query))
            .sort((a, b) => starts(b) - starts(a)).slice(0, 40) : [];
        for (const city of found) {
            const row = new Adw.ActionRow({title: city.name, subtitle: city.place, activatable: true});
            row.connect('activated', () => {
                onPick(city.location);
                dialog.close();
            });
            list.append(row);
        }
        scroller.visible = found.length > 0;
        empty.visible = found.length === 0;
        empty.title = query ? 'No City Found' : 'Search for a City';
        empty.description = query ? 'Try another spelling, or a bigger city nearby' : 'Type a city’s name, like Tokyo or New York';
    };
    search.connect('search-changed', fill);
    fill();
    dialog.present(window);
}

/** The AI CLIs the voice assistant can ask, in the order "Automatic" tries them, signed-in ones first (as isled does). */
const AI_PROVIDERS = [
    {id: 'claude', name: 'Claude Code', planName: 'Claude', command: 'claude', modelKey: 'voice-claude-model',
        about: 'what Claude answers with'},
    {id: 'codex', name: 'Codex (ChatGPT)', planName: 'ChatGPT', command: 'codex', modelKey: 'voice-codex-model',
        about: 'what ChatGPT answers with, quickly'},
    {id: 'grok', name: 'Grok', planName: 'Grok', command: 'grok', modelKey: 'voice-grok-model',
        about: 'what Grok answers with, quickly'},
    {id: 'agy', name: 'Antigravity', planName: 'Antigravity', command: 'agy', modelKey: 'voice-agy-model',
        about: 'what Antigravity answers with'},
];

/** isled's `Models`: per AI `{plan, default, default_name, models: [{id, name}]}`, followed while Settings is open. */
class ModelCatalog {
    /** Reads the property now and follows its changes. */
    constructor(settings) {
        this._settings = settings;
        this._models = {};
        this._callbacks = [];
        this._subscription = Gio.DBus.session.signal_subscribe(DAEMON, 'org.freedesktop.DBus.Properties',
            'PropertiesChanged', DAEMON_PATH, ASSISTANT_INTERFACE, Gio.DBusSignalFlags.NONE,
            (_conn, _sender, _path, _iface, _signal, params) => {
                const models = params.deepUnpack()[1].Models?.deepUnpack();
                if (models !== undefined)
                    this._set(models);
            });
        Gio.DBus.session.call(DAEMON, DAEMON_PATH, 'org.freedesktop.DBus.Properties', 'Get',
            new GLib.Variant('(ss)', [ASSISTANT_INTERFACE, 'Models']), null, Gio.DBusCallFlags.NONE, -1, null,
            (conn, result) => {
                try {
                    this._set(conn.call_finish(result).deepUnpack()[0].deepUnpack());
                } catch {
                    // An isled from before 1.4 (or none): Settings offers only each AI's own default.
                    this._set('{}');
                }
            });
        // The plan may have changed since: isled asks again, and the list follows. With the assistant
        // off Isle asks no AI, so only once it is turned on.
        this._assistantChanged = settings.connect('changed::voice-assistant', () => this._refresh());
        this._refresh();
    }

    /** Has isled ask each AI again, only with the assistant on. */
    _refresh() {
        if (this._settings.get_boolean('voice-assistant')) {
            Gio.DBus.session.call(DAEMON, DAEMON_PATH, ASSISTANT_INTERFACE, 'RefreshModels', null, null,
                Gio.DBusCallFlags.NONE, -1, null, null);
        }
    }

    /** Whether isled answered (or isn't there to): no more waiting for it. */
    get loaded() {
        return this._loaded ?? false;
    }

    /** Bad JSON counts as nothing known. */
    _set(json) {
        this._loaded = true;
        try {
            this._models = JSON.parse(json) ?? {};
        } catch {
            this._models = {};
        }
        this._callbacks.forEach(callback => callback());
    }

    /** AI `id`'s entry, or null. */
    of(id) {
        return this._models[id] ?? null;
    }

    /** Called on every change; no disconnect, `destroy` drops them all. */
    connect(callback) {
        this._callbacks.push(callback);
    }

    /** Must run when the window closes, or the D-Bus handler keeps it alive. */
    destroy() {
        Gio.DBus.session.signal_unsubscribe(this._subscription);
        this._settings.disconnect(this._assistantChanged);
        this._callbacks = [];
    }
}

/** Where Claude Code keeps its settings and sign-in: `$CLAUDE_CONFIG_DIR`, else ~/.claude. */
function claudeConfigDir() {
    return GLib.getenv('CLAUDE_CONFIG_DIR') || GLib.build_filenamev([GLib.get_home_dir(), '.claude']);
}

/** The user's own Codex home: `$CODEX_HOME`, else ~/.codex. */
function codexHome() {
    return GLib.getenv('CODEX_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.codex']);
}

/** The user's own Grok home: `$GROK_HOME`, else ~/.grok. */
function grokHome() {
    return GLib.getenv('GROK_HOME') || GLib.build_filenamev([GLib.get_home_dir(), '.grok']);
}

/** Whether AI `id` has a sign-in, checked as isled does (brain.rs `signed_in`). */
function signedIn(id) {
    const exists = (...parts) => GLib.file_test(GLib.build_filenamev(parts), GLib.FileTest.EXISTS);
    const env = name => Boolean(GLib.getenv(name));
    switch (id) {
    case 'claude': {
        if (exists(claudeConfigDir(), '.credentials.json') ||
            ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_BEDROCK', 'CLAUDE_CODE_USE_VERTEX'].some(env))
            return true;
        // An API key or a cloud set in its settings.json.
        try {
            const [, bytes] = GLib.file_get_contents(GLib.build_filenamev([claudeConfigDir(), 'settings.json']));
            const json = JSON.parse(new TextDecoder().decode(bytes));
            const kept = JSON.stringify(['env', 'apiKeyHelper', 'awsAuthRefresh', 'awsCredentialExport', 'forceLoginMethod']
                .filter(key => key in json).map(key => [key, json[key]]));
            return ['apiKeyHelper', 'ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_USE_'].some(key => kept.includes(key));
        } catch {
            return false;
        }
    }
    case 'codex':
        return exists(codexHome(), 'auth.json') || env('OPENAI_API_KEY');
    case 'grok':
        return exists(grokHome(), 'auth.json') || env('XAI_API_KEY');
    case 'agy':
        return exists(GLib.get_home_dir(), '.gemini/antigravity-cli/antigravity-oauth-token');
    default:
        return false;
    }
}

/** `command` on the PATH or where installers and Node version managers put it, as isled looks; else null. */
// The same places isled looks in (brain.rs `install_dirs`), for an AI installed with npm, nvm, Homebrew…
function findProgram(command) {
    const home = GLib.get_home_dir();
    const env = (name, fallback) => GLib.getenv(name) || fallback;
    const dirs = [
        GLib.build_filenamev([home, '.local/bin']), GLib.build_filenamev([home, '.npm-global/bin']),
        GLib.build_filenamev([env('BUN_INSTALL', `${home}/.bun`), 'bin']),
        GLib.build_filenamev([env('VOLTA_HOME', `${home}/.volta`), 'bin']),
        env('PNPM_HOME', `${home}/.local/share/pnpm`),
        ...['.local/share/fnm/aliases/default/bin', '.fnm/aliases/default/bin', '.claude/local', '.grok/bin',
            '.local/share/mise/shims', '.asdf/shims', '.yarn/bin', '.linuxbrew/bin', '.nix-profile/bin']
            .map(dir => GLib.build_filenamev([home, dir])),
        '/home/linuxbrew/.linuxbrew/bin', '/run/current-system/sw/bin',
    ];
    return GLib.find_program_in_path(command) ?? [...dirs, ...nvmBins(home), '/usr/local/bin']
        .map(dir => GLib.build_filenamev([dir, command]))
        .find(path => GLib.file_test(path, GLib.FileTest.IS_EXECUTABLE)) ?? null;
}

/** nvm's Nodes' bin folders, newest first. */
function nvmBins(home) {
    const xdg = GLib.build_filenamev([GLib.get_user_config_dir(), 'nvm']);
    const dir = GLib.getenv('NVM_DIR') ||
        (GLib.file_test(xdg, GLib.FileTest.IS_DIR) ? xdg : GLib.build_filenamev([home, '.nvm']));
    const root = GLib.build_filenamev([dir, 'versions', 'node']);
    const versions = [];
    try {
        const children = Gio.File.new_for_path(root).enumerate_children('standard::name', Gio.FileQueryInfoFlags.NONE, null);
        for (let info = children.next_file(null); info; info = children.next_file(null))
            versions.push(info.get_name());
    } catch {
        return [];
    }
    const parts = name => name.replace(/^v/, '').split('.').map(Number);
    versions.sort((a, b) => {
        const [x, y] = [parts(a), parts(b)];
        const differ = x.findIndex((n, i) => n !== y[i]);
        return differ < 0 ? 0 : (y[differ] ?? 0) - (x[differ] ?? 0);
    });
    return versions.map(name => GLib.build_filenamev([root, name, 'bin']));
}

/** The AI providers signed in here, as rows to switch: Claude Code's sign-in, Codex's (or its logs), and Grok's. */
// Where isled reads them (usage.rs): Claude Code's config dir, the user's Codex home and Isle's own.
function usageProviders() {
    const providers = [];
    // The plan's name is isled's (Settings → Assistant, the Usage page), as the apps name it.
    if (GLib.file_test(GLib.build_filenamev([claudeConfigDir(), '.credentials.json']), GLib.FileTest.EXISTS))
        providers.push({key: 'usage-claude', title: 'Claude', subtitle: 'Signed in with Claude Code'});
    const signedIn = GLib.file_test(GLib.build_filenamev([codexHome(), 'auth.json']), GLib.FileTest.EXISTS);
    const sessions = [[codexHome(), 'sessions'], [GLib.get_user_data_dir(), 'isle', 'codex', 'sessions']];
    if (signedIn || sessions.some(dir => GLib.file_test(GLib.build_filenamev(dir), GLib.FileTest.IS_DIR)))
        providers.push({key: 'usage-codex', title: 'ChatGPT', subtitle: 'Signed in with Codex'});
    if (GLib.file_test(GLib.build_filenamev([grokHome(), 'auth.json']), GLib.FileTest.EXISTS))
        providers.push({key: 'usage-grok', title: 'Grok', subtitle: 'Signed in with Grok'});
    return providers;
}

/** A drop-down for a string key with `choices`: [[value, label], …]. */
function choiceRow(settings, key, title, subtitle, choices) {
    const row = new Adw.ComboRow({
        title,
        subtitle,
        model: Gtk.StringList.new(choices.map(([, label]) => label)),
    });
    const sync = () => {
        const index = choices.findIndex(([value]) => value === settings.get_string(key));
        row.selected = Math.max(0, index);
    };
    sync();
    const changed = settings.connect(`changed::${key}`, sync);
    row.connect('notify::selected', () => {
        const value = choices[row.selected]?.[0];
        if (value !== undefined && value !== settings.get_string(key))
            settings.set_string(key, value);
    });
    row.connect('destroy', () => settings.disconnect(changed));
    return row;
}

/** Whole numbers from `min` to `max`, bound to an int key. */
function spinRow(settings, key, title, subtitle, min, max) {
    const row = Adw.SpinRow.new_with_range(min, max, 1);
    row.title = title;
    row.subtitle = subtitle;
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** A row showing `key`'s shortcut; clicking it records a new one. */
function shortcutRow(settings, key, title, subtitle) {
    const row = new Adw.ActionRow({title, subtitle, activatable: true});
    const shown = new Gtk.ShortcutLabel({disabled_text: 'Off', valign: Gtk.Align.CENTER});
    const sync = () => (shown.accelerator = settings.get_strv(key)[0] ?? '');
    settings.connect(`changed::${key}`, sync);
    sync();
    row.add_suffix(shown);
    row.connect('activated', () => recordShortcut(row.get_root(), accelerator =>
        settings.set_strv(key, accelerator ? [accelerator] : [])));
    return row;
}

/** Waits for a key combination with a modifier, then hands it to `done`; Esc cancels, Backspace clears it. */
function recordShortcut(window, done) {
    const dialog = new Adw.Window({transient_for: window, modal: true, title: 'Shortcut', default_width: 420, default_height: 240});
    dialog.set_content(new Adw.StatusPage({
        title: 'Press the new shortcut',
        description: 'With Super, Ctrl or Alt. Esc cancels; Backspace turns it off.',
        icon_name: 'preferences-desktop-keyboard-shortcuts-symbolic',
    }));
    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_keys, keyval, keycode, state) => {
        const modifiers = state & Gtk.accelerator_get_default_mod_mask();
        if (!modifiers && keyval === Gdk.KEY_Escape) {
            dialog.close();
        } else if (!modifiers && keyval === Gdk.KEY_BackSpace) {
            done('');
            dialog.close();
        } else if (modifiers & (Gdk.ModifierType.SUPER_MASK | Gdk.ModifierType.CONTROL_MASK | Gdk.ModifierType.ALT_MASK) &&
            Gtk.accelerator_valid(keyval, modifiers)) {
            // Shift alone would take a capital letter from every app.
            done(Gtk.accelerator_name_with_keycode(null, keyval, keycode, modifiers));
            dialog.close();
        }
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(keys);
    dialog.present();
}

/** Asks, then clears everything but pinned items from the clipboard history. */
function confirmClear(window) {
    confirm(window, {
        heading: 'Clear clipboard history?',
        body: 'Everything you copied is removed. Pinned items stay.',
        action: 'Clear',
    }, () => Gio.DBus.session.call(DAEMON, DAEMON_PATH, CLIPBOARD_INTERFACE, 'Clear', null, null,
        Gio.DBusCallFlags.NONE, -1, null, null));
}

/** Asks `heading` (with `body`) and runs `onYes` if the user picks `action`, a destructive one. */
function confirm(window, {heading, body, action}, onYes) {
    // AlertDialog since libadwaita 1.5 (GNOME 46); MessageDialog is its deprecated forerunner.
    const dialog = Adw.AlertDialog ? new Adw.AlertDialog({heading, body})
        : new Adw.MessageDialog({transient_for: window, heading, body});
    dialog.add_response('cancel', 'Cancel');
    dialog.add_response('yes', action);
    dialog.set_response_appearance('yes', Adw.ResponseAppearance.DESTRUCTIVE);
    dialog.connect('response', (_dialog, response) => {
        if (response === 'yes')
            onYes();
    });
    if (Adw.AlertDialog)
        dialog.present(window);
    else
        dialog.present();
}

/** Where updating is explained, and the command that updates a one-line install. */
const UPDATE_HELP = 'https://github.com/zickrian/isle/blob/main/docs/install.md#updating';
const INSTALL_COMMAND = 'curl -fsSL https://raw.githubusercontent.com/zickrian/isle/main/get.sh | bash';
const RELEASES = 'https://github.com/zickrian/isle/releases/latest';
/** Installs version `$1` with that release's own get.sh (no sudo), appending to the log `$2`: first who runs
 * it ("isle-update-pid <pid> <boot id>"), last "isle-update-done <exit status>". */
const UPDATE_SCRIPT = 'exec >>"$2" 2>&1 </dev/null; ' +
    'echo "isle-update-pid $$ $(cat /proc/sys/kernel/random/boot_id 2>/dev/null)"; set -o pipefail; ' +
    'curl -fsSL --retry 2 "https://raw.githubusercontent.com/zickrian/isle/v$1/get.sh" | ISLE_VERSION="$1" bash; ' +
    'echo "isle-update-done $?"';
/** The update's log; its first line names the version ("isle-update 1.5.0"). */
const UPDATE_LOG = GLib.build_filenamev([GLib.get_user_cache_dir(), 'isle', 'update.log']);
/** Longest a started update may take to say who runs it before it counts as never started. */
const UPDATE_START_US = 60 * 1000000;
/** What the installer's output may say about its session; the rest of Settings' own environment is not passed. */
const UPDATE_ENV = ['PATH', 'HOME', 'LANG', 'DBUS_SESSION_BUS_ADDRESS', 'XDG_RUNTIME_DIR', 'XDG_DATA_DIRS',
    'XDG_SESSION_TYPE', 'XDG_CURRENT_DESKTOP'];

/** Whether version `a` ("1.3.0") is newer than `b`, number by number (as isled's updates.rs). */
function isNewer(a, b) {
    const parts = v => v.split('.').map(part => parseInt(part, 10) || 0);
    const [x, y] = [parts(a), parts(b)];
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        if ((x[i] ?? 0) !== (y[i] ?? 0))
            return (x[i] ?? 0) > (y[i] ?? 0);
    }
    return false;
}

/** "today", "yesterday" or the date, for when isled last asked GitHub. */
function checkedWhen(ms) {
    const then = GLib.DateTime.new_from_unix_local(Math.floor(ms / 1000));
    const now = GLib.DateTime.new_now_local();
    const days = now.get_day_of_year() - then.get_day_of_year() + 365 * (now.get_year() - then.get_year());
    return days <= 0 ? 'today' : days === 1 ? 'yesterday' : then.format('%e %b').trim();
}

/** The version in `dir`'s metadata.json, and when it was put there (µs): after an update, the new one,
 * while the old still runs. */
function versionIn(dir) {
    try {
        const file = Gio.File.new_for_path(GLib.build_filenamev([dir, 'metadata.json']));
        const version = JSON.parse(new TextDecoder().decode(file.load_contents(null)[1]))['version-name'] ?? '';
        const at = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time().to_unix_usec();
        return {version, at};
    } catch {
        return {version: '', at: 0};
    }
}

/** Why the installer stopped, in plain words: from its own "Isle: …" line or a program's error, a known
 * reason; anything else is said as a try again (the details stay in the installer's log). */
function updateFailure(output) {
    const escapes = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    // Not Isle's markers, nor the steps ("==> Downloading").
    const lines = output.split('\n').map(line => line.replace(escapes, '').trim())
        .filter(line => line && !/^isle-update(-pid|-done)? /.test(line) && !line.startsWith('==>'));
    const all = lines.join('\n');
    const reasons = [
        // curl: no such host, refused, timed out, TLS or the connection dropped.
        [/could not reach GitHub|^curl: \((6|7|28|35|56)\)/m, 'Isle couldn’t reach GitHub; check the internet connection'],
        [/GitHub limits how often/, 'GitHub limits how often it is asked; try again in an hour'],
        [/GitHub answered|^curl: \(22\)/m, 'GitHub had a problem just now; try again in a while'],
        [/no release .*was found/, 'That version isn’t on GitHub yet; try again later'],
        [/damaged|checksum|unexpected layout|download failed/, 'The download didn’t come through whole; try again'],
        [/made for GNOME Shell (\d+ to \d+)/, 'This version of Isle doesn’t support this GNOME yet; nothing was changed'],
        [/No space left on device|Disk quota exceeded/, 'The disk is full; free some space and try again'],
        [/Permission denied|Read-only file system/, 'Isle couldn’t write its files; try again'],
        [/please install (\S+) first/, null],
        // Failures another try won't fix as it is: no build for this kind of computer, or one install at a time.
        [/no ready-built Isle for/, 'There’s no ready-made Isle for this computer; build it from source instead'],
        [/another install of Isle is running/, 'Another install of Isle is running; wait for it, then try again'],
        // Settings' own line when the installer couldn't be started at all.
        [/the update didn.t start/, 'The update didn’t start; try again'],
    ];
    for (const [pattern, words] of reasons) {
        const found = pattern.exec(all);
        if (found)
            return words ?? `Install ${found[1]}, then try again`;
    }
    return lines.length ? 'The update didn’t finish; try again' : 'the installer stopped';
}

/** The last update per its log, {version, text, done: exit status or null, running}, or null. Running: its
 * installer is alive in this boot, or it just started and hasn't named its pid yet. */
function readUpdateLog() {
    try {
        const file = Gio.File.new_for_path(UPDATE_LOG);
        const text = new TextDecoder().decode(file.load_contents(null)[1]);
        const version = /^isle-update (\S+)/.exec(text)?.[1];
        if (!version)
            return null;
        const done = /^isle-update-done (\d+)$/m.exec(text);
        const [, pid, boot] = /^isle-update-pid (\d+) ?(\S*)$/m.exec(text) ?? [];
        const at = file.query_info('time::modified', Gio.FileQueryInfoFlags.NONE, null).get_modification_date_time().to_unix_usec();
        let running = false;
        if (!done && pid) {
            const [, thisBoot] = GLib.file_get_contents('/proc/sys/kernel/random/boot_id');
            const cmdline = `/proc/${pid}/cmdline`;
            running = boot === new TextDecoder().decode(thisBoot).trim() && GLib.file_test(cmdline, GLib.FileTest.EXISTS) &&
                new TextDecoder().decode(GLib.file_get_contents(cmdline)[1]).includes('isle-installer');
        } else if (!done) {
            running = GLib.get_real_time() - at < UPDATE_START_US;
        }
        return {version, text, done: done ? Number(done[1]) : null, running, at};
    } catch {
        return null;
    }
}

/** Runs the installer for `version` on its own, as a unit of the user's systemd (else a process of its own),
 * so closing Settings doesn't stop it half way; its output goes to UPDATE_LOG. */
function startUpdate(version) {
    GLib.mkdir_with_parents(GLib.path_get_dirname(UPDATE_LOG), 0o700);
    GLib.file_set_contents(UPDATE_LOG, `isle-update ${version}\n`);
    const script = ['bash', '-c', UPDATE_SCRIPT, 'isle-installer', version, UPDATE_LOG];
    const run = argv => Gio.Subprocess.new(argv, Gio.SubprocessFlags.STDOUT_SILENCE | Gio.SubprocessFlags.STDERR_SILENCE);
    if (GLib.find_program_in_path('systemd-run')) {
        const env = UPDATE_ENV.filter(name => GLib.getenv(name)).map(name => `--setenv=${name}=${GLib.getenv(name)}`);
        // systemd reads "$$" in a command as a "$": written twice, the shell gets its own pid.
        const escaped = script.map(arg => arg.split('$$').join('$$$$'));
        const unit = run(['systemd-run', '--user', '--collect', '--quiet', `--unit=isle-update-${GLib.get_real_time()}`,
            ...env, ...escaped]);
        // No user systemd (some containers, other inits): run it directly.
        unit.wait_check_async(null, (proc, result) => {
            try {
                proc.wait_check_finish(result);
            } catch {
                run(script);
            }
        });
    } else {
        run(script);
    }
}

/** Logs out as GNOME's own menu does, asking first; GNOME Shell loads the new Isle at the next login. */
function logOut() {
    Gio.DBus.session.call('org.gnome.SessionManager', '/org/gnome/SessionManager', 'org.gnome.SessionManager',
        'Logout', new GLib.Variant('(u)', [0]), null, Gio.DBusCallFlags.NONE, -1, null, (bus, result) => {
            try {
                bus.call_finish(result);
            } catch {
                GLib.spawn_async(null, ['gnome-session-quit', '--logout'], null, GLib.SpawnFlags.SEARCH_PATH, null);
            }
        });
}

/** The About page's update status and the switch to ask GitHub, following what isled last found (its
 * updates.json). A one-line install updates in a click; a package says how its kind updates. */
function updateRows(settings, window, version, dir) {
    const packaged = dir.startsWith('/usr/');
    // Its words come from the installer's output and GitHub too: shown as they are, never as markup.
    const status = new Adw.ActionRow({use_markup: false});
    const icon = new Gtk.Image({valign: Gtk.Align.CENTER});
    const spinner = new Gtk.Spinner({valign: Gtk.Align.CENTER, spinning: true, visible: false});
    status.add_prefix(icon);
    status.add_prefix(spinner);
    const button = (label, css) => new Gtk.Button({label, valign: Gtk.Align.CENTER, css_classes: css, visible: false});
    const how = button('How', ['flat']);
    how.connect('clicked', () => new Gtk.UriLauncher({uri: UPDATE_HELP}).launch(window, null, null));
    const copy = button('Copy command', []);
    copy.tooltip_text = INSTALL_COMMAND;
    copy.connect('clicked', () => {
        window.get_display().get_clipboard().set(INSTALL_COMMAND);
        copy.label = 'Copied';
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1500, () => {
            copy.label = 'Copy command';
            return GLib.SOURCE_REMOVE;
        });
    });
    const download = button('Download', []);
    download.connect('clicked', () => new Gtk.UriLauncher({uri: RELEASES}).launch(window, null, null));
    const update = button('Update', ['suggested-action']);
    const logOutButton = button('Log Out', ['suggested-action']);
    logOutButton.connect('clicked', () => logOut());
    for (const suffix of [how, copy, download, update, logOutButton])
        status.add_suffix(suffix);
    const check = switchRow(settings, 'check-updates', 'Check for new versions', 'Asks GitHub once a day; nothing else is sent');

    const file = Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'isle', 'updates.json']));
    let updating = false;
    /** The timer looking at a running update again (see `sync`). */
    let watching = 0;
    const show = (iconName, css, title, subtitle, buttons = []) => {
        icon.icon_name = iconName;
        icon.css_classes = css;
        icon.visible = !updating;
        spinner.visible = updating;
        status.title = title;
        status.subtitle = subtitle;
        for (const suffix of [how, copy, download, update, logOutButton])
            suffix.visible = buttons.includes(suffix);
    };
    const readChecked = () => {
        try {
            return JSON.parse(new TextDecoder().decode(file.load_contents(null)[1]));
        } catch {
            return null;
        }
    };
    const sync = () => {
        const checked = readChecked();
        const on = settings.get_boolean('check-updates');
        const {version: installed, at: installedAt} = versionIn(dir);
        const newer = on && Boolean(checked?.latest) && isNewer(checked.latest, version);
        // The last update, also one started before Settings was closed and opened again.
        const last = readUpdateLog();
        updating = Boolean(last?.running);
        // Failed or cut off (a logout or restart ended it). Not when its version is in place (the extension
        // goes in whole, after the programs: what stopped came after) or any install came since (a terminal).
        const failed = last && !last.running && last.done !== 0 && !packaged && last.version === checked?.latest &&
            installed !== last.version && !(installedAt > last.at);
        // While it runs, looked at again now and then: an installer ended by a logout says nothing more.
        if (updating && !watching) {
            watching = GLib.timeout_add_seconds(GLib.PRIORITY_DEFAULT, 3, () => {
                sync();
                if (updating)
                    return GLib.SOURCE_CONTINUE;
                watching = 0;
                return GLib.SOURCE_REMOVE;
            });
        }
        if (updating) {
            show(null, [], `Updating to Isle ${last.version}…`, 'Downloading and installing; Settings can be closed');
        } else if (failed) {
            // Before "installed": one that stopped half way may have put part of it in place.
            update.label = 'Try Again';
            const why = (last.done === null ? 'it was cut off before it finished' : updateFailure(last.text)).replace(/\.+$/, '');
            show('dialog-warning-symbolic', ['warning'], 'Couldn’t update',
                `${why[0].toUpperCase()}${why.slice(1)}. Or paste the command in a terminal`, [copy, update]);
        } else if (installed && isNewer(installed, version)) {
            // Installed, here or from a terminal: the shell runs the old one until the next login.
            show('object-select-symbolic', ['success'], `Isle ${installed} is installed`,
                'Log out and back in to finish', [logOutButton]);
        } else if (!on) {
            show('software-update-available-symbolic', ['dim-label'], 'Not checking for new versions',
                'Turn it on below to hear when one is out');
        } else if (newer && packaged) {
            const arch = GLib.file_test('/etc/arch-release', GLib.FileTest.EXISTS);
            show('software-update-available-symbolic', ['accent'], `Isle ${checked.latest} is out`, arch
                ? 'Update it the way you installed it from the AUR, then log out and back in'
                : `Download its .${GLib.file_test('/etc/debian_version', GLib.FileTest.EXISTS) ? 'deb' : 'rpm'} and open it to install, then log out and back in`,
            arch ? [how] : [how, download]);
        } else if (newer) {
            update.label = 'Update';
            show('software-update-available-symbolic', ['accent'], `Isle ${checked.latest} is out`,
                'Your tasks, events and settings stay', [update]);
        } else if (checked?.at_ms) {
            show('object-select-symbolic', ['success'], 'You’re up to date', `Checked ${checkedWhen(checked.at_ms)}`);
        } else {
            show('software-update-available-symbolic', ['dim-label'], 'Not checked yet', 'Isle asks GitHub once a day');
        }
    };
    update.connect('clicked', () => {
        const latest = readChecked()?.latest;
        // Never two at once: one may still run from before Settings was opened again.
        if (!latest || updating || readUpdateLog()?.running)
            return;
        try {
            startUpdate(latest);
        } catch (e) {
            console.warn(`Isle: could not start the update: ${e.message}`);
            GLib.file_set_contents(UPDATE_LOG, `isle-update ${latest}\nIsle: the update didn’t start\nisle-update-done 1\n`);
        }
        sync();
    });
    // isled writes updates.json after each look (switched on, or once a day), the installer its log as it
    // goes: the row follows while open.
    const monitors = [file, Gio.File.new_for_path(UPDATE_LOG)].map(watched => {
        const monitor = watched.monitor_file(Gio.FileMonitorFlags.NONE, null);
        monitor.connect('changed', () => sync());
        return monitor;
    });
    const changed = settings.connect('changed::check-updates', () => sync());
    window.connect('close-request', () => {
        monitors.forEach(monitor => monitor.cancel());
        settings.disconnect(changed);
        if (watching)
            GLib.Source.remove(watching);
        watching = 0;
        return false;
    });
    sync();
    return [status, check];
}

/** Runs `isled --report` and puts what it says on the clipboard, saying so on `row`. */
function copyReport(window, row) {
    const isled = findProgram('isled');
    if (!isled) {
        row.subtitle = 'Isle isn’t fully installed; install it again, then try this';
        return;
    }
    const process = Gio.Subprocess.new([isled, '--report'], Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE);
    process.communicate_utf8_async(null, null, (_process, result) => {
        try {
            const [, output] = process.communicate_utf8_finish(result);
            window.get_display().get_clipboard().set(output);
            row.subtitle = 'Copied: paste it into the report on GitHub';
        } catch (e) {
            console.warn(`Isle: could not make the report: ${e.message}`);
            row.subtitle = 'Couldn’t make the report; try again';
        }
    });
}

/** Lists the ignored apps, each with a remove button, and a search to add one. */
function fillIgnoredApps(group, settings) {
    const key = 'clipboard-ignored-apps';
    const apps = Gio.AppInfo.get_all()
        .filter(app => app.should_show() && app.get_id())
        .sort((a, b) => a.get_display_name().localeCompare(b.get_display_name()));
    let rows = [];

    const add = new Adw.ComboRow({
        title: 'Add an app',
        model: Gtk.StringList.new(['Choose…', ...apps.map(app => app.get_display_name())]),
        // Search needs to know what text to match.
        expression: new Gtk.PropertyExpression(Gtk.StringObject, null, 'string'),
        enable_search: true,
    });
    add.connect('notify::selected', () => {
        const app = apps[add.selected - 1];
        if (!app)
            return;
        const ids = settings.get_strv(key);
        if (!ids.includes(app.get_id()))
            settings.set_strv(key, [...ids, app.get_id()]);
        add.selected = 0;
    });

    const refresh = () => {
        rows.forEach(row => group.remove(row));
        // Only apps on this computer; the built-in list names others too.
        rows = settings.get_strv(key).map(id => [id, DesktopAppInfo.new(id)]).filter(([, app]) => app).map(([id, app]) => {
            const row = new Adw.ActionRow({title: app.get_display_name()});
            if (app.get_icon())
                row.add_prefix(new Gtk.Image({gicon: app.get_icon(), pixel_size: 24}));
            const remove = new Gtk.Button({icon_name: 'list-remove-symbolic', valign: Gtk.Align.CENTER, css_classes: ['flat']});
            remove.set_tooltip_text('Keep copies from this app again');
            remove.connect('clicked', () => settings.set_strv(key, settings.get_strv(key).filter(other => other !== id)));
            row.add_suffix(remove);
            return row;
        });
        // Keep "Add an app" last.
        group.remove(add);
        rows.forEach(row => group.add(row));
        group.add(add);
    };
    group.add(add);
    const changed = settings.connect(`changed::${key}`, refresh);
    group.connect('destroy', () => settings.disconnect(changed));
    refresh();
}
