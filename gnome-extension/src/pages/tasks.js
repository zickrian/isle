// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Reminders, the right half of the Focus page (focus.js), in dark mode: an orange title and
// count, a ring and a hairline per reminder, and a last row to add one; a ticked one is struck, then goes.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL} from '../compat.js';
import {iconButton, label, wrapLines} from '../widgets.js';
import {Page} from './page.js';

/** How long the dot takes to pop into the ring. */
const TICK_MS = 200;
/** A ticked reminder stays this long, struck through, so a second tap can undo it. */
const LINGER_MS = 900;
/** How long it takes to fade and fold away. */
const LEAVE_MS = 260;
/** The strike drawn across the title, and a new reminder opening its row. */
const STRIKE_MS = 180;
const ARRIVE_MS = 220;

/** Calls `callback(hovered)` as the pointer comes onto `actor` or leaves it, as St's `hover` would, but
 * without the :hover restyle of all inside it (for rows with no :hover style). */
export function onHover(actor, callback) {
    let hovered = false;
    const set = value => {
        if (value === hovered)
            return;
        hovered = value;
        callback(value);
    };
    actor.connect('enter-event', () => {
        set(true);
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('leave-event', (_actor, event) => {
        const related = event.get_related();
        if (!related || !actor.contains(related))
            set(false);
        return Clutter.EVENT_PROPAGATE;
    });
    actor.connect('notify::mapped', () => {
        if (!actor.mapped)
            set(false);
    });
}

/** A reminder's row, never shorter than it wants: the list's scroll view lays rows out at their minimum
 * height, and a box takes a wrapped title's minimum as one line. */
const ReminderRow = GObject.registerClass(
class ReminderRow extends St.BoxLayout {
    /** Natural height as the minimum too. */
    vfunc_get_preferred_height(forWidth) {
        const [, natural] = super.vfunc_get_preferred_height(forWidth);
        return [natural, natural];
    }

    /** Shorter only while opening or folding: its contents keep their full height, cut below. Squeezed,
     * St would draw the ring at that size and keep it, blurred, once the row is whole. */
    vfunc_allocate(box) {
        const [, natural] = super.vfunc_get_preferred_height(box.get_width());
        if (box.get_height() >= natural) {
            super.vfunc_allocate(box);
            return;
        }
        const full = box.copy();
        full.y2 = box.y1 + natural;
        super.vfunc_allocate(full);
        this.set_allocation(box);
    }
});

// The reminder list, kept in isled's todo store.
export const TasksPage = GObject.registerClass(
class TasksPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-reminders',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'reminders';
        /** The reminder being renamed, if any; the list holds still meanwhile. */
        this._renaming = null;
        /** Reminders ticked a moment ago, on their way out; the list holds still meanwhile. */
        this._leaving = new Set();
        /** Ticked and gone, until isled reports them done. */
        this._gone = new Set();
        /** Each shown reminder's row by id, kept while the reminder is unchanged. */
        this._rows = new Map();

        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
        column.add_child(this._buildHeader());
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-reminder-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-reminder-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the list.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);
        this._newRow = this._buildNewRow();
        // Under the new row when there are none.
        this._empty = label('', 'isle-reminders-empty', {x_align: Clutter.ActorAlign.CENTER, y_expand: true});
        const middle = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        middle.add_child(this._scroll);
        middle.add_child(this._empty);
        column.add_child(middle);
        this.add_child(column);

        this.watch(['tasks'], () => this._update());
        this._update();
    }

    /** Open and done alike, as isled has them. */
    _tasks() {
        return this.daemon.state.tasks ?? [];
    }

    // Building

    /** "Reminders", the count of open ones, and +. */
    _buildHeader() {
        const header = new St.BoxLayout({style_class: 'isle-reminders-header'});
        header.add_child(label('Reminders', 'isle-reminders-title', {x_expand: true}));
        this._count = label('', 'isle-reminders-count');
        header.add_child(this._count);
        // A small round button, as the other pages' actions, on the page's right edge.
        const add = iconButton('isle-plus-symbolic', 'isle-button-round isle-button-small isle-reminders-add',
            () => this._focusNew(), {size: 13, accessibleName: 'New reminder'});
        add.y_align = Clutter.ActorAlign.CENTER;
        header.add_child(add);
        return header;
    }

    // The last row: a faint ring and a field, where typing a title and Enter adds it.
    _buildNewRow() {
        // Never y_expand: its column fills the row, and that would pass up (see `_row`).
        const row = new St.BoxLayout({style_class: 'isle-reminder isle-reminder-new', y_expand: false});
        row.add_child(new St.Widget({style_class: 'isle-reminder-check faint', y_align: Clutter.ActorAlign.CENTER}));
        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
        this._entry = new St.Entry({style_class: 'isle-reminder-field', hint_text: 'New reminder', can_focus: true, x_expand: true});
        const content = new St.BoxLayout({style_class: 'isle-reminder-content', y_expand: true});
        content.add_child(this._entry);
        column.add_child(content);
        row.add_child(column);

        const text = this._entry.clutter_text;
        // Enter adds it and leaves the field ready for the next.
        text.connect('activate', () => this._add());
        // A click takes the keyboard (see the controller's `_onFieldPress`); Esc or a click outside gives it back.
        text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            this._stopAdding();
            return Clutter.EVENT_STOP;
        });
        return row;
    }

    /** The + button: into the new row's field, scrolled into view. */
    _focusNew() {
        this.emit('request-keyboard', true);
        this._entry.grab_key_focus();
        this._revealNew();
    }

    /** Scrolls to the bottom once the list has laid out. */
    _revealNew() {
        this.later('reveal-new', 40, () => {
            const adjustment = this._scroll.vadjustment;
            adjustment.ease(adjustment.upper - adjustment.page_size, {duration: 200, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        });
    }

    /** Sends the typed title to isled. */
    async _add() {
        const text = this._entry.text.trim();
        if (!text)
            return;
        this._entry.text = '';
        await this.daemon.call('todo', 'Add', text);
        this._revealNew();
    }

    /** Clears the field and gives the keyboard back if it had it. */
    _stopAdding() {
        this._entry.text = '';
        if (this._entry.clutter_text.has_key_focus())
            this.emit('request-keyboard', false);
    }

    // Showing

    /** Brings the rows in line with isled's list, unless a rename or a tick is under way. */
    _update() {
        if (this._renaming !== null || this._leaving.size > 0)
            return;
        const tasks = this._tasks();
        const open = tasks.filter(task => !task.done);
        // Forgotten once isled has them done, or gone for another reason.
        this._gone = new Set(open.filter(task => this._gone.has(task.id)).map(task => task.id));
        const shown = open.filter(task => !this._gone.has(task.id)).sort((a, b) => a.id - b.id);
        this._count.text = String(shown.length);

        // The field stays in place, with what is typed in it and its focus, while the rows above it are
        // rebuilt: taking it off the stage, even for a moment, would drop the keyboard focus.
        if (!this._newRow.get_parent())
            this._list.add_child(this._newRow);
        // The rows of unchanged reminders stay; those of changed or gone ones go.
        const keys = new Map(shown.map(task => [task.id, JSON.stringify(task)]));
        const going = [...this._rows].filter(([id, row]) => keys.get(id) !== row._key);
        // A row's field losing its focus as it is destroyed upsets the input method: let go of it first.
        const focus = global.stage.get_key_focus();
        if (focus && going.some(([, row]) => row.contains(focus)))
            global.stage.set_key_focus(null);
        for (const [id, row] of going) {
            row.destroy();
            this._rows.delete(id);
        }
        // One added while the list is on screen opens its row; on first showing, all are there.
        const known = this.mapped ? this._known : null;
        let previous = null;
        for (const task of shown) {
            let row = this._rows.get(task.id);
            if (!row) {
                row = this._row(task);
                row._key = keys.get(task.id);
                this._rows.set(task.id, row);
                if (previous)
                    this._list.insert_child_above(row, previous);
                else
                    this._list.insert_child_at_index(row, 0);
                if (known && !known.has(task.id))
                    this._arrive(row);
            } else if (row.get_previous_sibling() !== previous) {
                if (previous)
                    this._list.set_child_above_sibling(row, previous);
                else
                    this._list.set_child_below_sibling(row, null);
            }
            previous = row;
        }
        this._known = new Set(shown.map(task => task.id));
        this._empty.visible = shown.length === 0;
        this._empty.text = tasks.length > shown.length ? 'All done' : 'No reminders';
    }

    /** Opens `row` from nothing to its height, fading in, while the rows below make room. */
    _arrive(row) {
        // At the list's width: a title that wraps is taller.
        const [, height] = row.get_preferred_height(this._list.width || -1);
        row.clip_to_allocation = true;
        row.height = 0;
        row.opacity = 0;
        // Rebuilt by the next update before it ended, it is stopped while torn down: leave it be then.
        let gone = false;
        row.connect('destroy', () => (gone = true));
        row.ease({
            height,
            opacity: 255,
            duration: ARRIVE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
            onStopped: () => {
                if (gone)
                    return;
                row.height = -1;
                row.clip_to_allocation = false;
            },
        });
    }

    /** One reminder: tick ring, title (click to rename), hover × and hairline. */
    _row(task) {
        // Never y_expand: its column fills it, and once a child changes (a rename) the row would ask to
        // expand too and take all the list's room.
        const row = new ReminderRow({style_class: 'isle-reminder', reactive: true, y_expand: false});

        // The tick box: a ring, and a dot that pops into it when ticked.
        const dot = new St.Widget({style_class: 'isle-reminder-dot', scale_x: 0, scale_y: 0, x_expand: true, y_expand: true});
        dot.set_pivot_point(0.5, 0.5);
        // By the first line of a title that wraps.
        const check = new St.Button({
            style_class: 'isle-reminder-check',
            child: dot,
            accessible_name: 'Mark as done',
            y_align: Clutter.ActorAlign.START,
        });
        row.add_child(check);

        // The title over a hairline that runs from the text to the edge.
        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true});
        const content = new St.BoxLayout({style_class: 'isle-reminder-content', y_expand: true});
        const titleBox = new St.Widget({style_class: 'isle-reminder-title-box', layout_manager: new Clutter.BinLayout(),
            x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        const title = label(task.title, 'isle-reminder-title', {reactive: true, x_expand: true});
        // A long one wraps, to be read whole.
        wrapLines(title);
        // Click the title to rename it in place.
        title.connect('button-release-event', () => {
            // One rename at a time: starting another would rebuild the list mid focus change.
            if (this._renaming === null && !this._leaving.has(task.id))
                this._startRenaming(titleBox, title, task);
            return Clutter.EVENT_STOP;
        });
        // As wide as the box, scaled from the left to the text's width when ticked.
        const strike = new St.Widget({style_class: 'isle-reminder-strike', scale_x: 0, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        strike.set_pivot_point(0, 0.5);
        titleBox.add_child(title);
        titleBox.add_child(strike);
        content.add_child(titleBox);

        // × appears while the pointer is on the row.
        // Once: a double click would ask isled to delete what is already gone.
        let removing = false;
        const remove = iconButton('isle-close-symbolic', 'isle-button-flat isle-reminder-remove', () => {
            if (!removing) {
                removing = true;
                this.daemon.call('todo', 'Remove', task.id);
            }
        }, {size: 9, accessibleName: 'Delete reminder'});
        remove.opacity = 0;
        onHover(row, hovered => remove.ease({opacity: hovered ? 255 : 0, duration: 120}));
        content.add_child(remove);
        column.add_child(content);
        column.add_child(new St.Widget({style_class: 'isle-reminder-line'}));
        row.add_child(column);

        check.connect('clicked', () => this._tick(task, {row, check, dot, title, strike}));
        return row;
    }

    // Ticks a reminder: the ring turns orange with a dot in it, the title is struck through, it lingers
    // a moment (a second tap undoes it), then fades and folds away.
    _tick(task, {row, check, dot, title, strike}) {
        // Folding away already: too late to undo. A flag, not `reactive`: that restyles the box (:insensitive).
        if (row._folding)
            return;
        const name = `leave-${task.id}`;
        const pop = shown => {
            dot.remove_all_transitions();
            dot.ease({
                scale_x: shown ? 1 : 0,
                scale_y: shown ? 1 : 0,
                duration: TICK_MS,
                mode: shown ? Clutter.AnimationMode.EASE_OUT_BACK : Clutter.AnimationMode.EASE_OUT_QUAD,
            });
        };
        if (this._leaving.has(task.id)) {
            this.cancel(name);
            this._leaving.delete(task.id);
            check.remove_style_pseudo_class('checked');
            check.accessible_name = 'Mark as done';
            title.remove_style_class_name('done');
            pop(false);
            strike.remove_transition('scale-x');
            strike.ease({scale_x: 0, duration: STRIKE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
            return;
        }
        // The text's own width, as laid out (cut short with … when long); measured before restyling.
        // The strike's box, not the title's: the title is off it while being renamed.
        const box = strike.get_parent()?.width ?? 0;
        const [textWidth] = title.clutter_text.get_layout().get_pixel_size();
        this._leaving.add(task.id);
        check.add_style_pseudo_class('checked');
        check.accessible_name = 'Not done';
        // On the title alone: on the row it restyled every widget in it, in the click's frame.
        title.add_style_class_name('done');
        pop(true);
        // Struck through from the left, as the dot pops in.
        strike.remove_transition('scale-x');
        strike.ease({
            scale_x: box > 0 ? Math.min(1, textWidth / box) : 1,
            duration: STRIKE_MS,
            mode: Clutter.AnimationMode.EASE_OUT_QUAD,
        });
        this.later(name, LINGER_MS, () => {
            // Folds away: the rows below slide up into its place; too late now to undo.
            row._folding = true;
            row.clip_to_allocation = true;
            row.ease({
                opacity: 0,
                height: 0,
                duration: LEAVE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onStopped: () => {
                    // Already settled by `onDeactivate`, whose rebuild is what stopped this; or Isle stopped.
                    if (this._destroyed || !this._leaving.delete(task.id))
                        return;
                    this._gone.add(task.id);
                    this.daemon.call('todo', 'SetDone', task.id, true);
                    this._update();
                },
            });
        });
    }

    // Renaming

    /** Swaps the title for a field; Enter or a click away saves, Esc cancels. */
    _startRenaming(titleBox, title, task) {
        const entry = new St.Entry({style_class: 'isle-reminder-field', text: task.title, x_expand: true, can_focus: true});
        titleBox.replace_child(title, entry);
        this._renaming = task.id;
        // Built anew once renamed, with its title back in place of the field.
        this._rows.get(task.id)._key = null;
        this.emit('request-keyboard', true);
        entry.grab_key_focus();
        entry.clutter_text.set_selection(0, -1);

        let finished = false;
        const finish = save => {
            if (finished)
                return;
            finished = true;
            const text = entry.text.trim();
            if (this._renaming === task.id)
                this._renaming = null;
            if (save && text && text !== task.title)
                this.daemon.call('todo', 'Rename', task.id, text);
            // After this event: it may come as focus moves, and the entry must outlive the move. Kept as the page
            // goes (a click outside closes it): its title must come back in place of the field.
            this.later('renamed', 0, () => {
                this._update();
                this._releaseKeyboard();
            }, {keep: true});
        };
        entry.clutter_text.connect('activate', () => finish(true));
        // Clicking elsewhere keeps the new name, as in Files.
        entry.clutter_text.connect('key-focus-out', () => finish(true));
        entry.clutter_text.connect('key-press-event', (_text, event) => {
            if (event.get_key_symbol() !== Clutter.KEY_Escape)
                return Clutter.EVENT_PROPAGATE;
            finish(false);
            return Clutter.EVENT_STOP;
        });
    }

    /** Gives the keyboard back, unless a field here still has it (focus moved from one to another). */
    _releaseKeyboard() {
        const focus = global.stage.get_key_focus();
        if (!focus || !this.contains(focus))
            this.emit('request-keyboard', false);
    }

    /** Ends whatever was under way, so the list is settled next time. */
    onDeactivate() {
        this._stopAdding();
        // Nothing in the middle of anything: the list stays as it is, with no rebuild as the page goes.
        if (this._renaming === null && this._leaving.size === 0)
            return;
        const renaming = this._renaming !== null;
        this._renaming = null;
        // Closing cancels the linger: ticked ones are done now, so the list never stays frozen.
        for (const id of this._leaving) {
            this._gone.add(id);
            this.daemon.call('todo', 'SetDone', id, true);
        }
        this._leaving.clear();
        this._update();
        // The rename ends with the rebuild, but its own release is cancelled as the page goes.
        if (renaming)
            this.emit('request-keyboard', false);
    }
});
