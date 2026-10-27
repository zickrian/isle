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

import {VERTICAL, iconSize, onUiScale, px} from '../compat.js';
import * as Format from '../format.js';
import {icon, iconButton, label} from '../widgets.js';
import * as WorldClocks from '../worldClocks.js';
import {Page} from './page.js';
import {onHover} from './tasks.js';

/** The month grid's height, shared by its rows; sizes in CSS pixels (see `px`). */
const GRID_HEIGHT = 108;
const MAX_ROW_HEIGHT = 21;
/** Events of the desktop's calendars (blue), and Isle's own (orange), as RGB. */
const SYSTEM_COLOR = [10, 132, 255];
const OWN_COLOR = [255, 159, 10];
/** How strongly an event's pill is tinted in its colour. */
const PILL_ALPHA = 0.18;

const DAY_MS = 24 * 60 * 60 * 1000;
/** An event's ×: a 10 px icon and 3 px around it. */
const REMOVE_SIZE = 16;
/** Cities the strip under the events names; the rest are counted ("+2"). */
const STRIP_CITIES = 3;

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

/** An alarm's wait is cut into naps this long at most: a sleeping computer stops the time-outs' clock. */
const ALARM_NAP_MS = 30 * 1000;
/** The events already alarmed, by id (or title) and start; kept as the screen locks and Isle starts again. */
const alarmed = new Set();

// Signals: `event-soon` (json): an event with a time starts in `alarmLead` minutes, {id, title, start_ms,
// end_ms}; `id` is GNOME's (source, event and recurrence, a line each), null for one of Isle's own.
export const CalendarPage = GObject.registerClass({
    Signals: {'event-soon': {param_types: [GObject.TYPE_STRING]}},
}, class CalendarPage extends Page {
    /** Month on the left, the day's events on the right; follows isled's own events. */
    _init(daemon, {height}) {
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
        /** The day the list shows, to start another day's at the top. */
        this._listedDay = null;

        this.add_child(this._buildMonth());
        this.add_child(this._buildAgenda());
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

    /** Asks the desktop's calendars for the month shown, the day picked, and today and tomorrow for the alarms:
     * GNOME's source keeps only the range asked for last. They answer with `changed`. */
    _requestRange() {
        const today = startOfDay(new Date());
        const monthEnd = new Date(this._month.getFullYear(), this._month.getMonth() + 1, 1);
        const begin = new Date(Math.min(this._month, this._selected, today));
        const end = new Date(Math.max(monthEnd, addDays(this._selected, 1), addDays(today, 2)));
        try {
            this._source?.requestRange(begin, end);
        } catch (e) {
            console.warn(`Isle: could not ask for calendar events: ${e.message}`);
        }
    }

    /** Waits for the next event with a time (today or tomorrow), to emit `event-soon` `alarmLead` before it. */
    _scheduleAlarm() {
        this.cancel('alarm');
        if (!this._alarmLeadMs)
            return;
        const now = Date.now();
        const today = startOfDay(new Date());
        const key = event => `${event.id ?? event.title}@${event.start.getTime()}`;
        // Forget the alarms of events gone by.
        for (const done of alarmed) {
            if (Number(done.slice(done.lastIndexOf('@') + 1)) < now)
                alarmed.delete(done);
        }
        const next = [...this._eventsOn(today), ...this._eventsOn(addDays(today, 1))]
            .filter(event => !event.allDay && event.start.getTime() > now && !alarmed.has(key(event)))
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
            alarmed.add(key(next));
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
        const column = new St.BoxLayout({...VERTICAL, style_class: 'isle-cal-month', y_align: Clutter.ActorAlign.START});

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
        column.add_child(header);

        this._entry = new St.Entry({style_class: 'isle-entry isle-cal-add', can_focus: true, x_expand: true});
        this._entry.set_primary_icon(new St.Icon({gicon: icon('isle-plus-symbolic'), icon_size: iconSize(13), style_class: 'isle-task-add-icon'}));
        const text = this._entry.clutter_text;
        text.connect('activate', () => this._add());
        // Typing needs the keyboard, which the shell only gets on request;
        // ask before the field takes focus, as on the Tasks page.
        text.connect('button-press-event', () => {
            this.emit('request-keyboard', true);
            return Clutter.EVENT_PROPAGATE;
        });
        text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._stopAdding();
            return Clutter.EVENT_STOP;
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
        for (const {timezone, chipTime, meta, time} of this._worldClocks) {
            const shown = Format.timeOfDay(now.to_timezone(timezone));
            set(chipTime, shown);
            set(time, shown);
            set(meta, [WorldClocks.dayText(timezone, now), WorldClocks.offsetText(timezone, now)].filter(Boolean).join(' · '));
        }
        if (this.active)
            this.later('world', (60 - now.get_seconds()) * 1000 + 50, () => this._tickWorld());
    }

    // The desktop's calendars

    /** GNOME Shell's event source; looked up afresh, as it is replaced at the lock screen. */
    _bindSource() {
        const source = Main.panel.statusArea.dateMenu?._eventSource ?? null;
        if (source === this._source)
            return;
        this._unbindSource();
        this._source = source;
        if (source)
            this._sourceChanged = source.connect('changed', () => {
                this._refresh();
                this.markCold();
                this._scheduleAlarm();
            });
    }

    /** Stops listening to the event source. */
    _unbindSource() {
        if (this._sourceChanged)
            this._source.disconnect(this._sourceChanged);
        this._sourceChanged = 0;
        this._source = null;
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
            color: SYSTEM_COLOR,
            ownId: null,
        }));
        const key = dayKey(day);
        for (const event of this.daemon.state.events ?? []) {
            if (event.date !== key)
                continue;
            const at = time => {
                const [hours, minutes] = time.split(':').map(Number);
                return new Date(begin.getFullYear(), begin.getMonth(), begin.getDate(), hours, minutes);
            };
            events.push({
                id: null,
                title: event.title,
                start: event.start ? at(event.start) : begin,
                end: event.end ? at(event.end) : null,
                allDay: !event.start,
                color: OWN_COLOR,
                ownId: event.id,
            });
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
            events.map(e => [e.title, +e.start, +e.end, e.allDay, e.ownId, !e.allDay && (e.end ?? e.start) < now]),
        ]);
        if (agenda !== this._shownAgenda) {
            this._shownAgenda = agenda;
            this._renderAgenda(events);
        }
        this._noAccounts.visible = this._source?.hasCalendars === false;
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
        const rowHeight = px(rows === 6 ? 18 : 20);

        if (rows === 6)
            this._grid.add_style_class_name('six-rows');
        else
            this._grid.remove_style_class_name('six-rows');

        this._grid.destroy_all_children();
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
        this._dayName.text = this._showingWorld ? 'World Clocks' : `${name}, ${dateTime(day).format('%-d %B')}`;
        this._todayButton.visible = !this._showingWorld && (offset !== 0 || this._month.getMonth() !== this._today.getMonth() ||
            this._month.getFullYear() !== this._today.getFullYear());
        // "8:00 PM" or "20:00", as the clock is set; written the way Isle reads it, not the locale's "8:00 p. m.".
        const eight = Format.uses12Hour() ? '8:00 PM' : '20:00';
        this._entry.hint_text = `Add event · e.g. Dinner ${eight}`;
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
        for (const event of events)
            this._list.add_child(this._eventRow(event, now, removable));
        this._syncListShown(events.length);
    }

    /** Either the day's events (or "No events"), or the world clocks. */
    _syncListShown(count = this._list.get_n_children()) {
        this._noEvents.visible = !this._showingWorld && count === 0;
        this._scroll.visible = !this._showingWorld && count > 0;
    }

    /** A tinted pill: colour bar, title, time, and × for Isle's own. */
    _eventRow(event, now, removable) {
        // Only Isle's own events take the pointer (for ×); the desktop's calendars' are to read, not open.
        const row = new St.BoxLayout({style_class: 'isle-cal-event', reactive: event.ownId !== null});
        const [r, g, b] = event.color;
        row.style = `background-color: rgba(${r}, ${g}, ${b}, ${PILL_ALPHA});`;
        // Finished ones recede.
        const over = !event.allDay && (event.end ?? event.start) < now;
        if (over)
            row.opacity = 130;

        row.add_child(new St.Widget({style_class: 'isle-cal-event-bar', style: `background-color: rgb(${r}, ${g}, ${b});`, y_expand: true}));
        const title = label(event.title, 'isle-cal-event-title', {x_expand: true});
        title.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        row.add_child(title);

        let when = 'All day';
        if (!event.allDay) {
            // An event that began on an earlier day shows when it ends.
            const startsToday = event.start >= startOfDay(this._selected);
            when = startsToday ? timeText(event.start) : `until ${timeText(event.end)}`;
            if (startsToday && event.end && event.end > event.start && event.end < addDays(startOfDay(this._selected), 1))
                when += ` – ${timeText(event.end)}`;
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

    /** Sends the typed event to isled for the picked day; isled reads the time from the text. */
    async _add() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        const result = await this.daemon.call('calendar', 'Add', dayKey(this._selected), text);
        // Kept for another try if it was refused (say, a time alone).
        if (result && !this._destroyed)
            this._entry.text = '';
    }

    /** Clears the field and hands the keyboard back. */
    _stopAdding() {
        this._entry.text = '';
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
        this.cancel('world');
    }
});
