// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// What the island shows while a setting is being changed (Controller._previewSetting), for every key of Isle's settings.
// A target is {page, mode?}: the island opens on that page (null: where it opens by itself) and, for the music page,
// on that mode. `null` is nothing to open for: the change shows live on the closed island and the top bar, or it is not
// something to look at (a shortcut, a provider's model), or the shell writes the key itself, which would open the island
// with no one at Settings. Every key of the schema has an entry (a test holds that).

const LYRICS = {page: 'music', mode: 'lyrics'};
const LOOK = {page: null};
const page = name => ({page: name});

export const PREVIEWS = {
    // How the open island looks: shown by opening it.
    'island-theme': LOOK,
    'open-size': LOOK,
    'glass-tint': LOOK,
    'island-shape': LOOK,
    'page-order': LOOK,

    // The lyrics and what is behind them: the lyrics open, with the music playing.
    'lyrics-online': LYRICS,
    'lyrics-provider-order': LYRICS,
    'lyrics-providers-off': LYRICS,
    'musixmatch-api-key': LYRICS,
    'cava-enabled': LYRICS,
    'cava-height-pct': LYRICS,
    'cava-opacity': LYRICS,
    'cava-zoom': LYRICS,
    'cava-offset-x': LYRICS,
    'cava-offset-y': LYRICS,
    'cava-sensitivity': LYRICS,
    'cava-bars': LYRICS,
    'cava-smoothness': LYRICS,
    'cava-source': LYRICS,

    // A page's own settings: that page.
    'devices-page': page('devices'),
    'app-usage': page('apps'),
    'usage-enabled': page('usage'),
    'usage-claude': page('usage'),
    'usage-codex': page('usage'),
    'usage-grok': page('usage'),
    'usage-warn': page('usage'),
    'usage-critical': page('usage'),
    'clipboard-history': page('shelf'),
    'focus-dnd': page('focus'),
    'gnome-banners': page('notifications'),

    // Live on the closed island and the top bar, already in sight.
    'top-bar-style': null,
    'top-bar-opacity': null,
    'top-bar-black-with-windows': null,
    'compact-top-bar': null,
    'island-in-top-bar': null,
    'notch-depth': null,
    'notch-gap': null,
    'top-bar-color': null,
    'island-clock': null,
    'top-bar-clock': null,
    'top-bar-clock-shows': null,
    'clock-date': null,
    'clock-format': null,
    'compact-song-title': null,
    'compact-title-width': null,
    'dnd-icon': null,
    'mini-bars-cover-color': null,
    'privacy-indicators': null,
    'call-activity': null,
    'call-preview': null,

    // Alerts that are a moment's popups, behaviour, shortcuts and the assistant: nothing to open the island for.
    'track-peek': null,
    'system-alerts': null,
    'alert-power': null,
    'alert-network': null,
    'alert-bluetooth': null,
    'alert-bluetooth-battery': null,
    'alert-caps-lock': null,
    'event-alerts': null,
    'event-alert-minutes': null,
    'replace-osd': null,
    'alerts-over-fullscreen': null,
    'agent-alerts-claude': null,
    'agent-alerts-codex': null,
    'open-on': null,
    'hover-delay': null,
    'auto-hide': null,
    'auto-hide-delay': null,
    'island-monitor': null,
    'super-v': null,
    'chimes': null,
    'clipboard-ignored-apps': null,
    'shortcut-music': null,
    'shortcut-notifications': null,
    'shortcut-focus': null,
    'shortcut-reminders': null,
    'shortcut-shelf': null,
    'shortcut-calendar': null,
    'shortcut-apps': null,
    'shortcut-devices': null,
    'shortcut-usage': null,
    'voice-assistant': null,
    'voice-shortcut': null,
    'voice-provider': null,
    'voice-claude-model': null,
    'voice-codex-model': null,
    'voice-grok-model': null,
    'voice-opencode-model': null,
    'voice-pi-model': null,
    'voice-agy-model': null,
    'voice-speech-model': null,
    'voice-language': null,
    'voice-keep-chat': null,
    'voice-use-selection': null,
    'voice-read-notifications': null,
    'bot-shape': null,
    'bot-color': null,
    'bot-glow': null,

    // Written by the shell itself (a page remembered, a question answered once, a count cleared): never a preview.
    'check-updates': null,
    'update-shown': null,
    'prefs-page': null,
    'hidden-pages': null,
    'app-usage-clear': null,
    'agents-announced': null,
    'world-clocks': null,
    'event-calendar': null,
    'focus-dnd-owned': null,
    'focus-dnd-declined': null,

    // The preview itself.
    'preview-settings': null,
};

/** What opens for a change of `key`: {page, mode?}, or null for nothing. */
export function previewTarget(key) {
    return PREVIEWS[key] ?? null;
}

/** The keys a change of which opens the island. */
export const PREVIEWED_KEYS = Object.keys(PREVIEWS).filter(key => PREVIEWS[key] !== null);
