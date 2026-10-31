// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Text formatting shared by the island's views.

import GLib from 'gi://GLib';
import Gio from 'gi://Gio';

let interfaceSettings = null;
// Isle's own choice (Settings → Appearance → Clock): 'system', '24h' or '12h'.
let clockFormat = 'system';

/** Lets go of GNOME's settings once Isle is turned off; they are read again when needed. */
export function release() {
    interfaceSettings = null;
    clockFormat = 'system';
}

/** Isle's clock setting, as controller.js reads it. */
export function setClockFormat(format) {
    clockFormat = format;
}

/** Whether times show with a 12-hour clock: as Isle's setting says, else as GNOME's. */
export function uses12Hour() {
    if (clockFormat === '24h' || clockFormat === '12h')
        return clockFormat === '12h';
    interfaceSettings ??= new Gio.Settings({schema_id: 'org.gnome.desktop.interface'});
    return interfaceSettings.get_string('clock-format') === '12h';
}

/** The clock's two parts: {time: "14:05"} or, with a 12-hour clock, {time: "2:05", meridiem: "PM"} (none where the
 * language has no such word). Two labels show them, the second smaller and dimmer (see stylesheet.css). */
export function clockParts(dateTime = GLib.DateTime.new_now_local(), twelveHour = uses12Hour()) {
    const time = dateTime.format(twelveHour ? '%l:%M' : '%H:%M').trim();
    const meridiem = twelveHour ? dateTime.format('%p').trim() : '';
    return {time, meridiem};
}

/** "14:05", or "2:05 PM" with a 12-hour clock: a time of day that stands alone. */
export function timeOfDay(dateTime) {
    return dateTime.format(uses12Hour() ? '%l:%M %p' : '%H:%M').trim();
}

/** A shortcut as people write it: "<Super>i" is "Super+I", "<Primary><Alt>space" is "Ctrl+Alt+Space". */
export function shortcutLabel(accelerator) {
    const names = {super: 'Super', primary: 'Ctrl', control: 'Ctrl', ctrl: 'Ctrl', alt: 'Alt', shift: 'Shift', meta: 'Meta'};
    const modifiers = [...(accelerator ?? '').matchAll(/<(\w+)>/g)].map(([, name]) => names[name.toLowerCase()] ?? name);
    const key = (accelerator ?? '').replace(/<\w+>/g, '');
    if (!key)
        return '';
    return [...modifiers, key.length === 1 ? key.toUpperCase() : key[0].toUpperCase() + key.slice(1)].join('+');
}

/** "Tue 20 Oct", short and calm in the top bar. */
export function longDate(dateTime = GLib.DateTime.new_now_local()) {
    return dateTime.format('%a %-d %b');
}

/** Formats a duration as "3:07" or "1:02:07". */
export function duration(ms) {
    const total = Math.max(0, Math.round(ms / 1000));
    const hours = Math.floor(total / 3600);
    const minutes = Math.floor(total / 60) % 60;
    const seconds = String(total % 60).padStart(2, '0');
    return hours > 0
        ? `${hours}:${String(minutes).padStart(2, '0')}:${seconds}`
        : `${minutes}:${seconds}`;
}

/** How long ago a GLib.DateTime was: "now", "5m", "2h", or "Mon". */
export function ago(dateTime) {
    const now = GLib.DateTime.new_now_local();
    const minutes = Math.floor(now.difference(dateTime) / 60e6);
    if (minutes < 1)
        return 'now';
    if (minutes < 60)
        return `${minutes}m`;
    if (minutes < 24 * 60)
        return `${Math.floor(minutes / 60)}h`;
    // Within the week its day; older, the date ("12 Oct").
    return dateTime.format(minutes < 6 * 24 * 60 ? '%a' : '%-d %b');
}

/** A span of time as "1h 15m", "25m", "<1m" or "0m". */
export function hoursMinutes(ms) {
    if (ms < 60000)
        return ms > 0 ? '<1m' : '0m';
    const minutes = Math.round(ms / 60000);
    const hours = Math.floor(minutes / 60);
    if (!hours)
        return `${minutes}m`;
    return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
}

/** Human name for a pomodoro phase. */
export function phaseName(phase) {
    return {
        idle: 'Ready to focus',
        focus: 'Focus',
        short_break: 'Short break',
        long_break: 'Long break',
    }[phase] ?? phase;
}

/** An answer's light Markdown (**bold**, `code`, "- " lists) as plain words on one line, for a single label.
 * A whole answer written as the schema's JSON (`{"say":"…"}`) shows as those words. */
export function answerPlain(text) {
    text = spoken(text);
    return text.split('\n')
        .map(line => line.replace(/^\s*[-*•]\s+/, '• ').replace(/\*\*(.+?)\*\*/g, '$1').replace(/`([^`]+)`/g, '$1').trim())
        .filter(Boolean)
        .join(' ');
}

/** The words of an answer that arrived as `{"say":"…"}`, also inside a ```json fence; else `text`. */
export function spoken(text) {
    const trimmed = text.trim();
    const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(trimmed);
    const body = fenced ? fenced[1] : trimmed;
    if (!body.startsWith('{'))
        return text;
    try {
        const say = JSON.parse(body).say;
        return typeof say === 'string' && say.trim() ? say.trim() : text;
    } catch {
        return text;
    }
}

/** Wall-clock milliseconds, in the same terms as the daemon's timestamps. */
export function nowMs() {
    return Math.floor(GLib.get_real_time() / 1000);
}

/** Days of rest other than Saturday and Sunday, by the region in the locale (0 is Sunday). */
const WEEKENDS = {
    ...Object.fromEntries(['AE', 'BH', 'DZ', 'EG', 'IQ', 'JO', 'KW', 'LY', 'OM', 'QA', 'SA', 'SD', 'SY', 'YE', 'IL']
        .map(region => [region, [5, 6]])),
    IR: [5],
    AF: [4, 5],
};

/** The weekend days (0 is Sunday) where `locale` ("ar_SA.UTF-8") is: Saturday and Sunday unless its region
 * rests otherwise. */
export function weekendDays(locale) {
    const region = locale.match(/^[a-z]{2,3}_([A-Z]{2})/)?.[1];
    return WEEKENDS[region] ?? [0, 6];
}
