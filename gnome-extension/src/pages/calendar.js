// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Calendar as a widget shows it: the month, and the chosen day's events from the desktop's
// calendars (GNOME Shell's event source) and Isle's own (isled, removable).

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {REMINDER_LATE_MS, occurrenceKey, parseReminderId, spanOf, standsInFor} from '../calendarRules.js';
import {VERTICAL, onUiScale, px} from '../compat.js';
import * as Format from '../format.js';
import {icon, iconButton, label} from '../widgets.js';
import * as WorldClocks from '../worldClocks.js';
import {Page} from './page.js';
import {onHover} from './tasks.js';

/** The month grid's height, shared by its rows: what the page has under the title and weekdays (39 of its
 * 144 inside); sizes in CSS pixels (see `px`). Five weeks fill it, six take smaller days (`isle-cal-six-weeks`). */
const GRID_HEIGHT = 105;
const MAX_ROW_HEIGHT = 21;
/** Events of a desktop calendar with no colour of its own (blue), and Isle's own (orange), as RGB. */
const SYSTEM_COLOR = [10, 132, 255];
const OWN_COLOR = [255, 159, 10];
/** An event just added shows at once, faint, until its calendar lists it, or this long (ms) at most. */
const PENDING_MS = 30000;
const PENDING_OPACITY = 140;

const DAY_MS = 24 * 60 * 60 * 1000;
/** An event's ×: a 10 px icon and 3 px around it. */
const REMOVE_SIZE = 16;
/** Cities the strip under the events names; the rest are counted ("+2"). */
const STRIP_CITIES = 3;
/** The time the line typed reads as shows this long (ms) after the last key. */
const PREVIEW_DELAY_MS = 120;
/** How long the field says an event was kept on this computer instead (ms). */
const SAVED_HERE_MS = 4000;

/** An [r, g, b] colour, each 0 to 255, as CSS. */
const cssColor = ([r, g, b]) => `rgb(${r}, ${g}, ${b})`;

/** "#9fe1e7" as [r, g, b], or null. */
function rgbOf(hex) {
    const match = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex ?? '');
    return match ? match.slice(1).map(part => parseInt(part, 16)) : null;
}

/** `day` at "HH:MM". */
function atTime(day, time) {
    const [hours, minutes] = time.split(':').map(Number);
    return new Date(day.getFullYear(), day.getMonth(), day.getDate(), hours, minutes);
}

/** Whether two of a day's events are one: the same title at the same time, or both all day. */
function sameEvent(a, b) {
    return a.title === b.title && a.allDay === b.allDay && (a.allDay || Math.abs(a.start - b.start) < 60000);
}

/** A calendar's or account's name for the chip: an address without its domain ("someone@gmail.com" → "someone"). */
function shortName(name) {
    return /^[^@\s]+@[^@\s]+$/.test(name) ? name.split('@')[0] : name;
}

/** "2026-10-21" for a local Date. */
function dayKey(date) {
    const pad = n => String(n).padStart(2, '0');
    return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Local midnight starting `date`'s day. */
function startOfDay(date) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

/** Midnight `days` later; by date, so a daylight saving change cannot shift it. */
function addDays(date, days) {
    return new Date(date.getFullYear(), date.getMonth(), date.getDate() + days);
}

/** A Date as a GLib.DateTime, to format it the locale's way. */
function dateTime(date) {
    return GLib.DateTime.new_from_unix_local(Math.floor(date.getTime() / 1000));
}

/** "09:30", or "9:30 AM" with a 12-hour clock. */
function timeText(date) {
    return Format.timeOfDay(dateTime(date));
}

/** "09:00 – 10:00", or "9:00 – 10:00 AM" with a 12-hour clock: AM or PM once when both have it. */
function rangeText(start, end) {
    const [from, to] = [timeText(start), timeText(end)];
    const mark = text => text.replace(/^[\d:.\s]+/, '');
    return mark(from) && mark(from) === mark(to) ? `${from.slice(0, -mark(from).length).trim()} – ${to}` : `${from} – ${to}`;
}

/** A city's sky at `hour`, as its World Clock row shows it: day, evening (16:00 to 18:59) or night (19:00 to 5:59). */
function skyIcon(hour) {
    if (hour >= 19 || hour < 6)
        return 'isle-moon';
    return hour >= 16 ? 'isle-sunset-symbolic' : 'isle-sun-symbolic';
}

/** An alarm's wait is cut into naps this long at most: a sleeping computer stops the time-outs' clock. */
const ALARM_NAP_MS = 30 * 1000;
/** Longer than GNOME's month grid ever asks for (six weeks): a span Isle itself asked for before. */
const GRID_SPAN_MS = 50 * 24 * 3600 * 1000;
/** The occurrences already alarmed, and those whose alert was on screen (see `occurrenceKey`); kept as the
 * screen locks and Isle starts again. */
const alarmed = new Set();
const shown = new Set();

// Signals: `event-soon` (json): an event with a time starts in `alarmLead` minutes, {id, title, start_ms,
// end_ms}; `id` is GNOME's (source, event and recurrence, a line each), null for one of Isle's own.
export const CalendarPage = GObject.registerClass({
    Signals: {'event-soon': {param_types: [GObject.TYPE_STRING]}},
}, class CalendarPage extends Page {
    /** Month on the left, the day's events on the right; follows isled's own events. */
    _init(daemon, settings, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-calendar',
            layout_manager: new Clutter.BoxLayout(),
            height,
        });
        this.name = 'calendar';
        onUiScale(this, scale => (this.layout_manager.spacing = 24 * scale));
        this._today = startOfDay(new Date());
        /** The day whose events are listed. */
        this._selected = this._today;
        /** The first of the month shown. */
        this._month = new Date(this._today.getFullYear(), this._today.getMonth(), 1);
        this._source = null;
        this._sourceChanged = 0;
        /** The [begin, end) of the desktop's events GNOME's month grid wants, and Isle's (see `_askRange`). */
        this._gnomeRange = null;
        this._isleRange = null;
        /** The day the list shows, to start another day's at the top. */
        this._listedDay = null;

        this._settings = settings;
        /** The desktop's calendars a new event can go to ({uid, name, account, color}), from isled. */
        this._calendars = [];
        /** Every desktop calendar's colour as [r, g, b], by uid, read only ones too. */
        this._colors = new Map();
        /** Events just added, shown until their calendar lists them (see `_showPending`). */
        this._pending = [];
        /** Whether the list shows where new events go, in place of the events. */
        this._picking = false;

        this.add_child(this._buildMonth());
        this.add_child(this._buildAgenda());
        this._targetChanged = settings.connect('changed::event-calendar', () => this._syncTarget());
        this.connect('destroy', () => settings.disconnect(this._targetChanged));
        this._loadCalendars();
        /** GNOME's World Clocks: a strip under the events, and in full in their place while the globe is on. */
        this._worldEnabled = false;
        this._showingWorld = false;
        this._cities = [];
        /** Each city's labels whose text changes with the time (see `_buildWorld`). */
        this._worldClocks = [];
        this._worldSettings = WorldClocks.shellSettings();
        this._worldChanged = this._worldSettings?.connect('changed::locations', () => this._syncWorld()) ?? 0;
        this.connect('destroy', () => this._worldChanged && this._worldSettings.disconnect(this._worldChanged));

        this.watch(['events'], () => {
            this._refresh();
            this._scheduleAlarm();
        });
        this.connect('destroy', () => this._unbindSource());
        /** How long before an event its alarm goes, in ms; 0: none. */
        this._alarmLeadMs = 0;
        this._refresh();
        // Another scale: the month and the day's list are made again at its size.
        onUiScale(this, () => {
            this._shownMonth = this._shownAgenda = null;
            this._refresh();
        }, {now: false});
    }

    /** Whether the page shows GNOME's World Clocks (only while it has cities). */
    set worldClocks(enabled) {
        this._worldEnabled = enabled;
        this._syncWorld();
    }

    /** Minutes before an event with a time that `event-soon` is emitted; 0 turns it off. */
    set alarmLead(minutes) {
        this._alarmLeadMs = Math.max(0, minutes) * 60000;
        // The desktop's events of today and tomorrow, to know what comes even if the page never opens.
        this._bindSource();
        this._requestRange();
        this._scheduleAlarm();
        // Each new day (and month) asked for, opened or not.
        this._scheduleMidnight();
    }

    /** Asks the desktop's calendars for the month shown, the day picked, and today and tomorrow for the alarms,
     * along with what GNOME's own month grid asks for (see `_askRange`). They answer with `changed`. */
    _requestRange() {
        const today = startOfDay(new Date());
        const monthEnd = new Date(this._month.getFullYear(), this._month.getMonth() + 1, 1);
        this._isleRange = [new Date(Math.min(this._month, this._selected, today)),
            new Date(Math.max(monthEnd, addDays(this._selected, 1), addDays(today, 2)))];
        this._turnGnomeGrid();
        this._askRange();
    }

    /** GNOME's calendar server keeps one range for everyone, and asking for another drops the events outside
     * it: so GNOME's grid's weeks and Isle's days are asked as one span, again only when it changes. */
    _askRange() {
        const span = spanOf([this._gnomeRange, this._isleRange]);
        if (!this._source || !span)
            return;
        try {
            this._sourceRequest.call(this._source, ...span);
        } catch (e) {
            console.warn(`Isle: could not ask for calendar events: ${e.message}`);
        }
    }

    /** GNOME's grid, out of sight, stays on the month the shell started in: turned to today, as its menu does
     * on opening, so the span asked for stays short. Left alone while its menu is open. */
    _turnGnomeGrid() {
        const dateMenu = Main.panel.statusArea.dateMenu;
        if (!dateMenu?.menu?.isOpen && typeof dateMenu?._calendar?.setDate === 'function')
            dateMenu._calendar.setDate(new Date());
    }

    /** Whether Isle's own alert stands in for the desktop's reminder with GNotification id `id`:
     * see `standsInFor`. All-day events, earlier heads-ups and tasks are left to the desktop. */
    remindsOf(id) {
        const today = startOfDay(new Date());
        const events = [...this._eventsOn(today), ...this._eventsOn(addDays(today, 1))];
        return standsInFor(parseReminderId(id), events, {leadMs: this._alarmLeadMs, now: Date.now(), alarmed, shown});
    }

    /** Isle's alert for `event` (as `event-soon` gave it) was on screen: the desktop's reminder of it can go. */
    alertShown(event) {
        shown.add(occurrenceKey({id: event.id, title: event.title, start: new Date(event.start_ms)}));
    }

    /** Waits for the next event with a time (today or tomorrow), to emit `event-soon` `alarmLead` before it. */
    _scheduleAlarm() {
        this.cancel('alarm');
        const now = Date.now();
        // Forget the alarms of events gone by; an alert shown, once no reminder of it would count (see `remindsOf`).
        const startOf = key => Number(key.slice(key.lastIndexOf('@') + 1));
        for (const done of alarmed) {
            if (startOf(done) < now)
                alarmed.delete(done);
        }
        for (const done of shown) {
            if (startOf(done) + REMINDER_LATE_MS < now)
                shown.delete(done);
        }
        if (!this._alarmLeadMs)
            return;
        const today = startOfDay(new Date());
        const next = [...this._eventsOn(today), ...this._eventsOn(addDays(today, 1))]
            .filter(event => !event.allDay && !event.pending && event.start.getTime() > now && !alarmed.has(occurrenceKey(event)))
            .sort((a, b) => a.start - b.start)[0];
        if (!next)
            return;
        const at = next.start.getTime() - this._alarmLeadMs;
        // Kept while the page is closed: the alarms are for the desktop, not the page.
        this.later('alarm', Math.min(Math.max(0, at - now), ALARM_NAP_MS), () => {
            // Not yet: after a nap, planned again from the events as they are now.
            if (at > Date.now()) {
                this._scheduleAlarm();
                return;
            }
            alarmed.add(occurrenceKey(next));
            // Late past its start (the computer slept): too late to remind of it.
            if (next.start.getTime() > Date.now()) {
                this.emit('event-soon', JSON.stringify({id: next.id, title: next.title,
                    start_ms: next.start.getTime(), end_ms: next.end?.getTime() ?? null}));
            }
            this._scheduleAlarm();
        }, {keep: true});
    }

    // Building

    /** Header with month, year and arrows, the weekday letters, and the empty grid. */
    _buildMonth() {
        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-month', y_align: Clutter.ActorAlign.CENTER});

        // "OCTOBER 2026" in red; click it for today.
        const header = new St.BoxLayout({style_class: 'isle-cal-month-header'});
        const title = new St.BoxLayout({style_class: 'isle-cal-month-title-box'});
        this._monthName = label('', 'isle-cal-month-name');
        this._year = label('', 'isle-cal-year');
        title.add_child(this._monthName);
        title.add_child(this._year);
        const titleButton = new St.Button({style_class: 'isle-cal-month-title', child: title, can_focus: true, accessible_name: 'Go to today', x_expand: true, x_align: Clutter.ActorAlign.START});
        titleButton.connect('clicked', () => this._goToToday());
        // Its text on the page's edge, as the other pages' titles; the pill it lights on hover reaches past it.
        onUiScale(titleButton, scale => (titleButton.translation_x = -4 * scale));
        header.add_child(titleButton);
        header.add_child(iconButton('isle-chevron-left-symbolic', 'isle-button-flat isle-cal-arrow',
            () => this._moveMonth(-1), {size: 11, accessibleName: 'Previous month'}));
        header.add_child(iconButton('isle-chevron-right-symbolic', 'isle-button-flat isle-cal-arrow',
            () => this._moveMonth(1), {size: 11, accessibleName: 'Next month'}));
        column.add_child(header);

        const weekdays = new St.BoxLayout({style_class: 'isle-cal-weekdays'});
        this._weekStart = Shell.util_get_week_start();
        this._weekend = Format.weekendDays(GLib.getenv('LC_ALL') || GLib.getenv('LC_TIME') || GLib.getenv('LANG') || '');
        // 4 Jan 1970 was a Sunday.
        const days = [...Array(7).keys()].map(i => new Date(1970, 0, 4 + (this._weekStart + i) % 7));
        const names = days.map(day => dateTime(day).format('%a'));
        // A letter each, unless that says too little: two where most days share one ("CN T2 T3" in Vietnamese).
        const initials = names.map(name => name.slice(0, 1).toUpperCase());
        const short = new Set(initials).size < 4 ? names.map(name => name.slice(0, 2).toUpperCase()) : initials;
        days.forEach((day, i) => {
            const weekend = this._weekend.includes(day.getDay());
            weekdays.add_child(label(short[i], `isle-cal-weekday${weekend ? ' weekend' : ''}`, {x_align: Clutter.ActorAlign.CENTER}));
        });
        column.add_child(weekdays);

        this._grid = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-grid', y_align: Clutter.ActorAlign.START});
        onUiScale(this._grid, scale => (this._grid.height = GRID_HEIGHT * scale));
        column.add_child(this._grid);
        return column;
    }

    /** Day header, the add field, the event list with its empty state, and the world clocks. */
    _buildAgenda() {
        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-agenda', x_expand: true, y_expand: true});

        const header = new St.BoxLayout({style_class: 'isle-cal-day-header'});
        this._dayName = label('', 'isle-cal-day-name', {x_expand: true});
        this._dayName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        header.add_child(this._dayName);
        this._worldButton = iconButton('isle-globe', 'isle-button-flat isle-cal-world-toggle',
            () => this._setShowingWorld(!this._showingWorld), {size: 13, accessibleName: 'World clocks'});
        this._worldButton.y_align = Clutter.ActorAlign.CENTER;
        this._worldButton.visible = false;
        // Drawn white: dimmed while off, as the tabs' icons.
        this._worldButton.child.opacity = 150;
        header.add_child(this._worldButton);
        this._todayButton = new St.Button({style_class: 'isle-cal-today', label: 'Today', can_focus: true, y_align: Clutter.ActorAlign.CENTER});
        this._todayButton.connect('clicked', () => this._goToToday());
        header.add_child(this._todayButton);
        // While picking where new events go: back to the day, the field with them.
        this._doneButton = new St.Button({style_class: 'isle-cal-today', label: 'Done', can_focus: true,
            y_align: Clutter.ActorAlign.CENTER, visible: false});
        this._doneButton.connect('clicked', () => this._setPicking(false));
        header.add_child(this._doneButton);
        column.add_child(header);

        this._entry = new St.Entry({style_class: 'isle-entry isle-cal-add', can_focus: true, x_expand: true});
        this._entry.set_primary_icon(new St.Icon({gicon: icon('isle-plus-symbolic'), icon_size: 13, style_class: 'isle-task-add-icon'}));
        const text = this._entry.clutter_text;
        text.connect('activate', () => this._add());
        // How the line reads, as it is typed (see `_previewLine`).
        text.connect('text-changed', () => this.later('preview', PREVIEW_DELAY_MS, () => this._previewLine()));
        text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._stopAdding();
            return Clutter.EVENT_STOP;
        });
        // Where the event goes, in the field: an account's calendar or Isle's own, once there is a choice.
        // Shown once isled lists a calendar to pick (see `_syncTarget`).
        this._target = new St.BoxLayout({style_class: 'isle-cal-target', reactive: true, track_hover: true,
            y_align: Clutter.ActorAlign.CENTER, accessible_name: 'Calendar for new events', visible: false});
        this._targetDot = new St.Widget({style_class: 'isle-cal-target-dot', y_align: Clutter.ActorAlign.CENTER});
        this._targetName = label('', 'isle-cal-target-name');
        this._targetName.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._target.add_child(this._targetDot);
        this._target.add_child(this._targetName);
        this._target.add_child(new St.Icon({gicon: icon('isle-chevron-down-symbolic'), icon_size: 10,
            style_class: 'isle-cal-target-arrow', y_align: Clutter.ActorAlign.CENTER}));
        // The end of the field: when the line typed takes place, then the chip (once there is a choice).
        this._preview = label('', 'isle-cal-preview', {y_align: Clutter.ActorAlign.CENTER, visible: false});
        const end = new St.BoxLayout({style_class: 'isle-cal-field-end', y_align: Clutter.ActorAlign.CENTER});
        end.add_child(this._preview);
        end.add_child(this._target);
        this._entry.set_secondary_icon(end);
        // The chip alone picks the calendar, not the time beside it.
        this._entry.connect('secondary-icon-clicked', () => {
            if (this._target.visible && this._target.hover)
                this._setPicking(!this._picking);
        });
        column.add_child(this._entry);

        const listArea = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-events'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-cal-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the rows.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);
        listArea.add_child(this._scroll);
        this._noEvents = new St.BoxLayout({...VERTICAL, x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER,
            x_expand: true, y_expand: true});
        this._noEvents.add_child(label('No events', 'isle-cal-empty', {x_align: Clutter.ActorAlign.CENTER}));
        // With no calendar account at all, where to add one.
        this._noAccounts = new St.Button({style_class: 'isle-cal-accounts', label: 'Add calendars in Online Accounts',
            can_focus: true, x_align: Clutter.ActorAlign.CENTER, visible: false});
        this._noAccounts.connect('clicked', () => {
            GLib.spawn_async(null, ['gnome-control-center', 'online-accounts'], null, GLib.SpawnFlags.SEARCH_PATH, null);
            this.emit('request-close');
        });
        this._noEvents.add_child(this._noAccounts);
        listArea.add_child(this._noEvents);
        this._worldList = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-events isle-cal-world', x_expand: true});
        this._worldScroll = new St.ScrollView({style_class: 'isle-cal-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL, x_expand: true, y_expand: true, visible: false});
        this._worldScroll.set_child(this._worldList);
        listArea.add_child(this._worldScroll);
        this._targetList = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-events isle-cal-targets', x_expand: true});
        this._targetScroll = new St.ScrollView({style_class: 'isle-cal-scroll', hscrollbar_policy: St.PolicyType.NEVER,
            vscrollbar_policy: St.PolicyType.EXTERNAL, x_expand: true, y_expand: true, visible: false});
        this._targetScroll.set_child(this._targetList);
        listArea.add_child(this._targetScroll);
        column.add_child(listArea);

        // The cities at a glance, as GNOME's calendar menu lists them; a click shows them in full.
        this._worldStrip = new St.Button({style_class: 'isle-cal-world-strip', can_focus: true, x_expand: true,
            visible: false, accessible_name: 'World clocks'});
        this._worldStrip.set_child(new St.BoxLayout({style_class: 'isle-cal-world-strip-box'}));
        this._worldStrip.connect('clicked', () => this._setShowingWorld(true));
        column.add_child(this._worldStrip);
        return column;
    }

    // World clocks

    /** The globe and the strip while there are cities; with none left, back to the events. */
    _syncWorld() {
        this._cities = this._worldEnabled ? WorldClocks.readCities(this._worldSettings) : [];
        this._worldButton.visible = this._cities.length > 0;
        if (!this._cities.length && this._showingWorld)
            this._setShowingWorld(false);
        this._worldStrip.visible = this._cities.length > 0 && !this._showingWorld;
        this._buildWorld();
        this.markCold();
    }

    /** Swaps the events for the world clocks, or back; the globe button follows. */
    _setShowingWorld(showing) {
        if (showing)
            this._setPicking(false);
        this._showingWorld = showing;
        this._worldButton.checked = showing;
        this._worldButton.child.opacity = showing ? 255 : 150;
        if (showing)
            this._stopAdding();
        this._entry.visible = !showing;
        this._worldScroll.visible = showing;
        this._worldStrip.visible = !showing && this._cities.length > 0;
        this._tickWorld();
        this._renderDayHeader();
        this._refresh();
    }

    /** The strip, and in full a row per city: its name, its day when not today's, how far ahead and its time.
     * Made when the cities change; opening the page and each minute only set their text (`_tickWorld`). */
    _buildWorld() {
        this._worldStrip.child.destroy_all_children();
        this._worldList.destroy_all_children();
        this._worldClocks = [];
        for (const [i, {name, timezone}] of this._cities.entries()) {
            const clock = {timezone};
            if (i < STRIP_CITIES) {
                const chip = new St.BoxLayout({style_class: 'isle-cal-world-chip'});
                chip.add_child(label(name, 'isle-cal-world-chip-city'));
                clock.chipTime = label('', 'isle-cal-world-chip-time');
                chip.add_child(clock.chipTime);
                this._worldStrip.child.add_child(chip);
            }
            const row = new St.BoxLayout({style_class: 'isle-cal-world-row'});
            clock.icon = new St.Icon({style_class: 'isle-cal-world-icon', y_align: Clutter.ActorAlign.CENTER});
            row.add_child(clock.icon);
            const city = label(name, 'isle-cal-world-city', {x_expand: true});
            city.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            row.add_child(city);
            clock.meta = label('', 'isle-cal-world-meta');
            row.add_child(clock.meta);
            clock.time = label('', 'isle-cal-world-time');
            row.add_child(clock.time);
            this._worldList.add_child(row);
            this._worldClocks.push(clock);
        }
        if (this._cities.length > STRIP_CITIES)
            this._worldStrip.child.add_child(label(`+${this._cities.length - STRIP_CITIES}`, 'isle-cal-world-chip-city'));
        this._tickWorld();
    }

    /** The clocks' times now; again each minute while the page is open. */
    _tickWorld() {
        if (!this._worldClocks.length) {
            this.cancel('world');
            return;
        }
        const now = GLib.DateTime.new_now_local();
        // Only what changed: the same text again would still lay the label out anew.
        const set = (text, value) => {
            if (text && text.text !== value)
                text.text = value;
        };
        for (const clock of this._worldClocks) {
            const {timezone, chipTime, meta, time} = clock;
            const there = now.to_timezone(timezone);
            const shown = Format.timeOfDay(there);
            set(chipTime, shown);
            set(time, shown);
            set(meta, [WorldClocks.dayText(timezone, now), WorldClocks.offsetText(timezone, now)].filter(Boolean).join(' · '));
            const sky = skyIcon(there.get_hour());
            if (clock.icon && clock.sky !== sky) {
                clock.sky = sky;
                clock.icon.gicon = icon(sky);
            }
        }
        if (this.active)
            this.later('world', (60 - now.get_seconds()) * 1000 + 50, () => this._tickWorld());
    }

    // The desktop's calendars

    /** GNOME Shell's event source; looked up afresh, as it is replaced at the lock screen. While bound, the
     * range its month grid asks for (again on each `changed`) is asked together with Isle's (see `_askRange`). */
    _bindSource() {
        const source = Main.panel.statusArea.dateMenu?._eventSource ?? null;
        if (source === this._source)
            return;
        this._unbindSource();
        if (typeof source?.requestRange !== 'function')
            return;
        this._source = source;
        this._sourceChanged = source.connect('changed', () => {
            this._refresh();
            this.markCold();
            this._scheduleAlarm();
        });
        // What the grid asked for before Isle came (its six weeks, not a span Isle asked for before).
        const [lastBegin, lastEnd] = [source._lastRequestBegin, source._lastRequestEnd];
        if (lastBegin && lastEnd && lastEnd - lastBegin <= GRID_SPAN_MS)
            this._gnomeRange = [lastBegin, lastEnd];
        // Another extension's own `requestRange` is kept under Isle's.
        this._priorRequest = Object.hasOwn(source, 'requestRange') ? source.requestRange : null;
        const request = this._sourceRequest = source.requestRange;
        this._sharedRequest = (begin, end) => {
            // Unbound, but still called (another extension's put on top of Isle's): straight through.
            if (this._source !== source)
                return request.call(source, begin, end);
            this._gnomeRange = [begin, end];
            return this._askRange();
        };
        source.requestRange = this._sharedRequest;
    }

    /** Stops listening to the event source, and gives its `requestRange` back. */
    _unbindSource() {
        const source = this._source;
        if (source && source.requestRange === this._sharedRequest) {
            if (this._priorRequest)
                source.requestRange = this._priorRequest;
            else
                delete source.requestRange;
        }
        if (this._sourceChanged)
            source.disconnect(this._sourceChanged);
        this._sourceChanged = 0;
        this._source = this._sharedRequest = this._gnomeRange = null;
    }

    /** The desktop's events overlapping [begin, end). */
    _systemEvents(begin, end) {
        try {
            return this._source?.getEvents(begin, end) ?? [];
        } catch (e) {
            console.warn(`Isle: could not read calendar events: ${e.message}`);
            return [];
        }
    }

    // Events of a day, from both places

    /** `{title, start, end, allDay, color, ownId}` for each event on `day`, by time. */
    _eventsOn(day) {
        const begin = startOfDay(day);
        const end = addDays(begin, 1);
        const events = this._systemEvents(begin, end).map(event => ({
            id: event.id ?? null,
            title: event.summary || 'Untitled',
            start: event.date,
            end: event.end,
            allDay: event.date <= begin && event.end >= end,
            // GNOME's id: the calendar, the event and its recurrence, a line each.
            color: this._colors.get(event.id?.split('\n')[0]) ?? SYSTEM_COLOR,
            ownId: null,
        }));
        const key = dayKey(day);
        for (const event of this.daemon.state.events ?? []) {
            if (event.date !== key)
                continue;
            // One waiting to go to a calendar out of reach: in that one's colour, as a ring until sent.
            const waiting = Boolean(event.send);
            events.push({
                id: null,
                title: event.title,
                start: event.start ? atTime(begin, event.start) : begin,
                end: event.end ? atTime(begin, event.end) : null,
                allDay: !event.start,
                color: waiting ? this._colors.get(event.send.calendar) ?? SYSTEM_COLOR : OWN_COLOR,
                waiting,
                ownId: event.id,
            });
        }
        // Just added: shown until its calendar lists it, then that one is.
        const now = Date.now();
        this._pending = this._pending.filter(pending => pending.until > now &&
            (pending.date !== key || !events.some(event => sameEvent(event, pending))));
        for (const pending of this._pending) {
            if (pending.date === key)
                events.push({...pending, id: null, ownId: null, pending});
        }
        // All-day events first, then by start time.
        return events.sort((a, b) => (b.allDay - a.allDay) || (a.start - b.start));
    }

    /** The days of the month shown that have events, as day numbers. */
    _busyDays() {
        const begin = this._month;
        const end = new Date(begin.getFullYear(), begin.getMonth() + 1, 1);
        const busy = new Set();
        for (const event of this._systemEvents(begin, end)) {
            // Each day the event touches, within the month.
            for (let day = startOfDay(event.date < begin ? begin : event.date);
                day < end && day < event.end; day = addDays(day, 1))
                busy.add(day.getDate());
        }
        const prefix = dayKey(begin).slice(0, 8);
        for (const event of this.daemon.state.events ?? []) {
            if (event.date.startsWith(prefix))
                busy.add(Number(event.date.slice(8)));
        }
        return busy;
    }

    // Showing

    /** Draws the month ahead, so the first time the page opens costs no frames. */
    warmUp() {
        this._bindSource();
        this._followToday();
        this._requestRange();
        this._refresh(true);
        this._tickWorld();
    }

    /** A new day since it was drawn: today is picked, unless another day was. */
    _followToday() {
        const today = startOfDay(new Date());
        if (today.getTime() === this._today.getTime() || this._selected.getTime() !== this._today.getTime())
            return false;
        // Not a pick of the user's: the World Clocks they read stay.
        this._select(today, {keepWorld: true});
        return true;
    }

    /** Brings month and list up to date; `force` draws while closed (see `warmUp`). */
    _refresh(force = false) {
        if (!this.active && !force)
            return; // drawn when the page opens
        this._today = startOfDay(new Date());
        // Redrawn only when what it shows changed: opening the page, or the desktop's calendars
        // answering again with the same events, must not rebuild it while it slides in.
        const busy = this._busyDays();
        const month = JSON.stringify([this._today.getTime(), this._month.getTime(), [...busy]]);
        if (month !== this._shownMonth) {
            this._shownMonth = month;
            this._renderMonth(busy);
        } else {
            // Another day picked in the same month: only two days change.
            this._dayButtons.forEach(button => (button.style_class = this._dayClass(button._day)));
        }
        this._renderDayHeader();
        const now = new Date();
        const events = this._eventsOn(this._selected);
        const agenda = JSON.stringify([
            this._selected.getTime(),
            Format.uses12Hour(),
            events.map(e => [e.title, +e.start, +e.end, e.allDay, e.ownId, !e.allDay && (e.end ?? e.start) < now,
                cssColor(e.color), Boolean(e.pending), Boolean(e.waiting)]),
        ]);
        if (agenda !== this._shownAgenda) {
            this._shownAgenda = agenda;
            this._renderAgenda(events);
        }
        this._syncNoAccounts();
        this._syncListShown();
    }

    /** Rebuilds the grid, with a dot under each day in `busy`. */
    _renderMonth(busy) {
        const month = this._month;
        const now = GLib.DateTime.new_local(month.getFullYear(), month.getMonth() + 1, 1, 0, 0, 0);
        // The month's name standing alone, as some languages write it apart from a date.
        this._monthName.text = now.format('%OB').toUpperCase();
        this._year.text = String(month.getFullYear());

        const daysInMonth = new Date(month.getFullYear(), month.getMonth() + 1, 0).getDate();
        const lead = (month.getDay() - this._weekStart + 7) % 7;
        const rows = Math.ceil((lead + daysInMonth) / 7);
        const rowHeight = px(Math.min(MAX_ROW_HEIGHT, Math.floor(GRID_HEIGHT / rows)));

        this._grid.destroy_all_children();
        this._grid.set_style_class_name(rows > 5 ? 'isle-cal-grid isle-cal-six-weeks' : 'isle-cal-grid');
        this._dayButtons = [];
        for (let row = 0; row < rows; row++) {
            const week = new St.BoxLayout({style_class: 'isle-cal-week', height: rowHeight});
            for (let column = 0; column < 7; column++) {
                const number = row * 7 + column - lead + 1;
                week.add_child(number >= 1 && number <= daysInMonth
                    ? this._dayCell(new Date(month.getFullYear(), month.getMonth(), number), busy.has(number))
                    : new St.Widget({style_class: 'isle-cal-cell'}));
            }
            this._grid.add_child(week);
        }
    }

    /** A day's style: today, picked, or a weekend day. */
    _dayClass(day) {
        const classes = ['isle-cal-day'];
        if (day.getTime() === this._today.getTime())
            classes.push('today');
        else if (day.getTime() === this._selected.getTime())
            classes.push('selected');
        else if (this._weekend.includes(day.getDay()))
            classes.push('weekend');
        return classes.join(' ');
    }

    /** One day's button, with the busy dot under it. */
    _dayCell(day, busy) {
        const today = day.getTime() === this._today.getTime();
        const cell = new St.Widget({layout_manager: new Clutter.BinLayout(), style_class: 'isle-cal-cell'});
        const button = new St.Button({
            style_class: this._dayClass(day),
            label: String(day.getDate()),
            can_focus: true,
            accessible_name: dateTime(day).format('%A %-d %B'),
            x_expand: true,
            y_expand: true,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        button.connect('clicked', () => this._select(day));
        button._day = day;
        this._dayButtons.push(button);
        cell.add_child(button);
        if (busy) {
            // Under the number, in the circle's bottom edge.
            cell.add_child(new St.Widget({
                style_class: `isle-cal-dot${today ? ' on-today' : ''}`,
                x_expand: true,
                y_expand: true,
                x_align: Clutter.ActorAlign.CENTER,
                y_align: Clutter.ActorAlign.END,
            }));
        }
        return cell;
    }

    /** "Today, 21 October", and the Today button when another day or month is shown. */
    _renderDayHeader() {
        const day = this._selected;
        const offset = Math.round((day - this._today) / DAY_MS);
        const name = {'-1': 'Yesterday', 0: 'Today', 1: 'Tomorrow'}[offset] ?? dateTime(day).format('%A');
        this._dayName.text = this._picking ? 'New events go to'
            : this._showingWorld ? 'World Clocks' : `${name}, ${dateTime(day).format('%-d %B')}`;
        this._todayButton.visible = !this._showingWorld && !this._picking && (offset !== 0 || this._month.getMonth() !== this._today.getMonth() ||
            this._month.getFullYear() !== this._today.getFullYear());
        // "8:00 PM" or "20:00", as the clock is set; written the way Isle reads it, not the locale's "8:00 p. m.".
        const eight = Format.uses12Hour() ? '8:00 PM' : '20:00';
        // Shorter beside the calendar's chip, so it isn't cut; for a moment, where an event just went instead.
        // Kept here as its calendar was out of reach, it goes there once in reach (see isled's `send_waiting`).
        const waiting = (this.daemon.state.events ?? []).some(event => event.send && event.title === this._savedHereTitle &&
            event.date === dayKey(day));
        const hint = Date.now() >= (this._savedHereUntil ?? 0)
            ? this._calendars.length ? `e.g. Dinner ${eight}` : `Add event · e.g. Dinner ${eight}`
            : waiting ? 'Offline · syncs once online' : 'Saved in Isle instead';
        // Set only when it changes: St makes the hint's label anew each time.
        if (this._entry.hint_text !== hint)
            this._entry.hint_text = hint;
    }

    /** Rebuilds the list for the picked day. */
    _renderAgenda(events) {
        const day = this._selected;
        this._list.destroy_all_children();
        // Another day's list starts at its top.
        if (day.getTime() !== this._listedDay?.getTime())
            this._scroll.vadjustment.value = 0;
        this._listedDay = day;
        const now = new Date();
        // With Isle's own events (×) among them, the others keep the ×'s room, so all their times line up.
        const removable = events.some(event => event.ownId !== null);
        // The one just added, scrolled to once laid out: as added, or as its calendar lists it already.
        const reveal = this._reveal && (events.find(event => event.pending === this._reveal) ??
            events.find(event => !event.pending && sameEvent(event, this._reveal)));
        for (const event of events) {
            const row = this._eventRow(event, now, removable);
            this._list.add_child(row);
            if (event === reveal) {
                this._reveal = null;
                // Drawn again meanwhile (its calendar answered), the row is gone: nothing to scroll to.
                let gone = false;
                row.connect('destroy', () => (gone = true));
                this.later('reveal', 40, () => !gone && this._scrollTo(row));
            }
        }
        this._syncListShown(events.length);
    }

    /** Scrolls the list just enough to show `row` whole. */
    _scrollTo(row) {
        if (row.get_parent() !== this._list)
            return;
        const adjustment = this._scroll.vadjustment;
        const top = row.y, bottom = row.y + row.height;
        const value = Math.min(Math.max(adjustment.value, bottom - adjustment.page_size), top);
        if (value !== adjustment.value)
            adjustment.ease(value, {duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    /** Either the day's events (or "No events"), the world clocks, or where new events go. */
    _syncListShown(count = this._list.get_n_children()) {
        const events = !this._showingWorld && !this._picking;
        this._noEvents.visible = events && count === 0;
        this._scroll.visible = events && count > 0;
    }

    // Where new events go

    /** The desktop's calendars a new event can go to, asked of isled (it reads Evolution Data Server). */
    async _loadCalendars() {
        // The colours at once; the list once isled knows which calendars only read, which can take seconds.
        // Quiet: without Evolution Data Server yet, there is no word, which is no failure.
        const calendars = this.daemon.attemptQuietly('calendar', 'Calendars').then(({result}) => result);
        const colors = await this.daemon.call('calendar', 'Colors');
        if (this._destroyed)
            return;
        this._loadColors(colors?.[0]);
        const result = await calendars;
        // No word (isled or Evolution Data Server not there yet): what was known stays.
        if (this._destroyed || !result)
            return;
        // isled answered: an empty list is no account at all, not one still on its way.
        this._calendarsKnown = true;
        if (result[0] === this._calendarsJson)
            return;
        this._calendarsJson = result[0];
        try {
            this._calendars = JSON.parse(result[0]);
        } catch {
            this._calendars = [];
        }
        this._syncTarget();
    }

    /** The calendars' colours from isled's JSON; the list is drawn again if they changed. */
    _loadColors(json) {
        if (!json || json === this._colorsJson)
            return;
        this._colorsJson = json;
        let colors = {};
        try {
            colors = JSON.parse(json);
        } catch {}
        this._colors = new Map(Object.entries(colors).map(([uid, hex]) => [uid, rgbOf(hex)]).filter(([, rgb]) => rgb));
        this._shownAgenda = null;
        this._refresh();
    }

    /** Where the next event goes: one of `_calendars`, or null for Isle's own. A calendar picked but gone
     * (its account removed) counts as no pick: the first account's calendar. */
    get _targetCalendar() {
        const picked = this._settings.get_string('event-calendar');
        if (picked === 'isle')
            return null;
        return this._calendars.find(calendar => calendar.uid === picked) ?? this._calendars[0] ?? null;
    }

    /** Where to add a calendar account, under "No events" while there is none at all. */
    _syncNoAccounts() {
        this._noAccounts.visible = this._source?.hasCalendars === false && !this._calendars.length;
    }

    /** The chip in the field, shown once there is a calendar to pick besides Isle's own. */
    _syncTarget() {
        const target = this._targetCalendar;
        this._target.visible = this._calendars.length > 0;
        this._renderDayHeader();
        this._syncNoAccounts();
        this._targetName.text = target ? shortName(target.name) : 'Isle';
        this._targetDot.style = `background-color: ${target?.color || cssColor(target ? SYSTEM_COLOR : OWN_COLOR)};`;
        if (!this._calendars.length && this._picking)
            this._setPicking(false);
        else if (this._picking)
            this._buildTargets();
    }

    /** Swaps the events for the calendars to add to, or back. */
    _setPicking(picking) {
        if (picking === this._picking)
            return;
        this._picking = picking;
        if (picking) {
            // The field goes: what was typed, and the keyboard, with it.
            this._stopAdding();
            this._setShowingWorld(false);
            this._buildTargets();
            // The list as isled sees it now: an account added or removed meanwhile.
            this._loadCalendars();
        }
        if (picking)
            this._target.add_style_pseudo_class('checked');
        else
            this._target.remove_style_pseudo_class('checked');
        this._targetScroll.visible = picking;
        // The list takes the field's room too, so more calendars show at once.
        this._entry.visible = !picking && !this._showingWorld;
        this._doneButton.visible = picking;
        this._worldStrip.visible = !picking && this._cities.length > 0;
        this._renderDayHeader();
        this._syncListShown();
    }

    /** A row per calendar, by account, then Isle's own on this computer; a tick on the one in use. */
    _buildTargets() {
        this._targetList.destroy_all_children();
        const chosen = this._targetCalendar?.uid ?? 'isle';
        const own = {uid: 'isle', name: 'Isle', account: 'On this computer', color: cssColor(OWN_COLOR)};
        for (const calendar of [...this._calendars, own])
            this._targetList.add_child(this._targetRow(calendar, calendar.uid === chosen));
    }

    /** A calendar to pick: its colour, its name, its account (unless that is its name), and a tick when new
     * events go there. */
    _targetRow(calendar, chosen) {
        const box = new St.BoxLayout({style_class: 'isle-cal-target-row-box', x_expand: true});
        box.add_child(new St.Widget({style_class: 'isle-cal-target-dot', y_align: Clutter.ActorAlign.CENTER,
            style: `background-color: ${calendar.color || cssColor(SYSTEM_COLOR)};`}));
        const name = label(calendar.name, 'isle-cal-target-row-name', {x_expand: true});
        name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        box.add_child(name);
        if (calendar.account && calendar.account !== calendar.name) {
            const account = label(calendar.account, 'isle-cal-target-row-account');
            account.clutter_text.ellipsize = Pango.EllipsizeMode.END;
            box.add_child(account);
        }
        const tick = new St.Icon({gicon: icon('isle-check-symbolic'), icon_size: 12, style_class: 'isle-cal-target-tick',
            y_align: Clutter.ActorAlign.CENTER, opacity: chosen ? 255 : 0});
        box.add_child(tick);
        const row = new St.Button({style_class: 'isle-cal-target-row', child: box, x_expand: true, can_focus: true});
        row.connect('clicked', () => {
            this._settings.set_string('event-calendar', calendar.uid);
            this._setPicking(false);
        });
        return row;
    }

    /** A row: its calendar's colour as a dot, title, time, and × for Isle's own. */
    _eventRow(event, now, removable) {
        // Only Isle's own events take the pointer (for ×); the desktop's calendars' are to read, not open.
        const row = new St.BoxLayout({style_class: 'isle-cal-event', reactive: event.ownId !== null});
        // Finished ones recede; one just added is faint until its calendar has it.
        const over = !event.allDay && (event.end ?? event.start) < now;
        if (event.pending)
            row.opacity = PENDING_OPACITY;
        else if (over)
            row.opacity = 130;

        row.add_child(new St.Widget({style_class: `isle-cal-event-dot${event.waiting ? ' waiting' : ''}`,
            style: `${event.waiting ? 'border-color' : 'background-color'}: ${cssColor(event.color)};`,
            y_align: Clutter.ActorAlign.CENTER}));
        const title = label(event.title, 'isle-cal-event-title', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(title);

        let when = 'All day';
        if (!event.allDay) {
            // An event that began on an earlier day shows when it ends.
            const startsToday = event.start >= startOfDay(this._selected);
            when = startsToday ? timeText(event.start) : `until ${timeText(event.end)}`;
            if (startsToday && event.end && event.end > event.start && event.end < addDays(startOfDay(this._selected), 1))
                when = rangeText(event.start, event.end);
        }
        row.add_child(label(when, 'isle-cal-event-time'));

        if (event.ownId !== null) {
            // × while the pointer is on the row, as on the Tasks page; once, as there.
            let removing = false;
            const remove = iconButton('isle-close-symbolic', 'isle-button-flat isle-task-remove', () => {
                if (!removing) {
                    removing = true;
                    this.daemon.call('calendar', 'Remove', event.ownId);
                }
            }, {size: REMOVE_SIZE - 6, accessibleName: 'Remove event'});
            remove.opacity = 0;
            onHover(row, hovered => remove.ease({opacity: hovered ? 255 : 0, duration: 120}));
            row.add_child(remove);
        } else if (removable) {
            // As wide as the ×: its icon and padding (see .isle-task-remove).
            row.add_child(new St.Widget({width: px(REMOVE_SIZE)}));
        }
        return row;
    }

    // Doing

    /** Picks `day`, turning to its month if needed. */
    _select(day, {keepWorld = false} = {}) {
        // Picking a day is about its events.
        if (this._showingWorld && !keepWorld)
            this._setShowingWorld(false);
        this._setPicking(false);
        this._selected = day;
        if (day.getMonth() !== this._month.getMonth() || day.getFullYear() !== this._month.getFullYear())
            this._month = new Date(day.getFullYear(), day.getMonth(), 1);
        this._requestRange();
        this._refresh();
    }

    /** The month before (-1) or after (1). */
    _moveMonth(step) {
        this._month = new Date(this._month.getFullYear(), this._month.getMonth() + step, 1);
        this._requestRange();
        this._refresh();
    }

    /** Today, in its month. */
    _goToToday() {
        this._select(startOfDay(new Date()));
    }

    /** Sends the typed event to isled for the picked day and calendar; isled reads the time from the text. */
    async _add() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        const day = this._selected;
        const target = this._targetCalendar;
        // No account at all: Isle's own at once, not asked of Evolution again. The list not in yet (isled
        // starting, EDS slow): the setting as it is, as the assistant sends it.
        const calendar = this._calendars.length ? target?.uid ?? 'isle'
            : this._calendarsKnown ? 'isle' : this._settings.get_string('event-calendar');
        // Cleared and shown at once, while the calendar's server takes its time: Enter again adds nothing twice.
        this._entry.text = '';
        const adding = this.daemon.addEvent(calendar, dayKey(day), text);
        // To an account's calendar (in its colour), unless to Isle's own: picked, or no account at all.
        const desktop = calendar !== 'isle' && (this._calendars.length > 0 || this._colors.has(calendar));
        const color = desktop ? rgbOf(target?.color) ?? this._colors.get(calendar) ?? SYSTEM_COLOR : OWN_COLOR;
        const pending = await this._showPending(text, day, {desktop, color});
        const result = await adding;
        if (this._destroyed)
            return;
        if (!result) {
            this._dropPending(pending);
            // Refused (say, a time alone): back in the field to fix, unless something else is typed there.
            if (!this._entry.text)
                this._entry.text = text;
            return;
        }
        // Its calendar couldn't take it (offline, signed out): kept on this computer, and said so a moment.
        if (target && !result[0]) {
            this._savedHereUntil = Date.now() + SAVED_HERE_MS;
            this._savedHereTitle = pending?.title ?? null;
            this._renderDayHeader();
            this.later('saved-here', SAVED_HERE_MS, () => this._renderDayHeader());
        }
    }

    /** Shows in the field when the line typed takes place ("8:00 PM", "All day"), as isled reads it, so a
     * time is never taken for another (a 12-hour clock's "8:00" is the morning's). */
    async _previewLine() {
        const typed = this._entry.text.trim();
        const event = typed ? await this._parse(typed) : null;
        // Typed on meanwhile: that line's own answer follows.
        if (this._destroyed || typed !== this._entry.text.trim())
            return;
        const begin = startOfDay(this._selected);
        const at = time => atTime(begin, time);
        this._preview.text = !event ? '' : !event.start ? 'All day'
            : event.end ? rangeText(at(event.start), at(event.end)) : timeText(at(event.start));
        this._preview.visible = Boolean(this._preview.text);
    }

    /** Shows the event `text` reads as on `day` at once, in `color`, until its calendar (a desktop one, or
     * Isle's own) lists it. Returns it, or null when isled can't read it. */
    async _showPending(text, day, {desktop, color}) {
        const event = await this._parse(text);
        if (!event?.title || this._destroyed)
            return null;
        const begin = startOfDay(day);
        const start = event.start ? atTime(begin, event.start) : begin;
        // A desktop calendar gets an hour without an end (see isled's `ical_event`); Isle's own, none.
        const end = event.end ? atTime(begin, event.end)
            : event.start && desktop ? new Date(start.getTime() + 3600000) : null;
        const pending = {date: dayKey(day), title: event.title, start, end, allDay: !event.start, color,
            until: Date.now() + PENDING_MS};
        this._pending.push(pending);
        this._reveal = pending;
        this._refresh();
        // Gone by then if its calendar never listed it.
        this.later(`pending-${pending.until}`, PENDING_MS + 100, () => this._refresh(), {keep: true});
        return pending;
    }

    /** How isled reads `text` ({title, start, end}), or null: no title yet, or an isled without Parse, which
     * is not asked again. Asked at each pause in typing, so a refusal is no failure to log. */
    async _parse(text) {
        if (this._noParse)
            return null;
        const {result, unknownMethod} = await this.daemon.attemptQuietly('calendar', 'Parse', text);
        this._noParse = unknownMethod;
        try {
            return JSON.parse(result?.[0] ?? 'null');
        } catch {
            return null;
        }
    }

    /** Takes back an event shown as just added. */
    _dropPending(pending) {
        if (!pending)
            return;
        this._pending = this._pending.filter(other => other !== pending);
        this._refresh();
    }

    /** Clears the field, and how it reads, and hands the keyboard back. */
    _stopAdding() {
        this._entry.text = '';
        this.cancel('preview');
        this._preview.text = '';
        this._preview.visible = false;
        if (this._entry.clutter_text.has_key_focus())
            this.emit('request-keyboard', false);
    }

    /** Redraws at midnight, so "today" moves on. */
    _scheduleMidnight() {
        const now = new Date();
        this.later('midnight', addDays(startOfDay(now), 1) - now + 1000, () => {
            if (!this._followToday())
                this._refresh();
            // A new day: its events, for the alarms; the same range answers nothing, so plan anew too.
            this._requestRange();
            this._scheduleAlarm();
            this._scheduleMidnight();
        }, {keep: true});
    }

    /** Catches up on a new day and starts the clocks. */
    onActivate() {
        this._bindSource();
        this._loadCalendars();
        this._tickWorld();
        if (!this._followToday()) {
            this._requestRange();
            this._refresh();
        }
        this._scheduleMidnight();
    }

    /** Drops what was typed and stops the clocks' minute tick. */
    onDeactivate() {
        this._stopAdding();
        this._setPicking(false);
        this.cancel('world');
        // Closed, only today and tomorrow are needed (the alerts): a far month looked at is let go.
        const today = startOfDay(new Date());
        this._isleRange = [today, addDays(today, 2)];
        this._askRange();
    }
});
