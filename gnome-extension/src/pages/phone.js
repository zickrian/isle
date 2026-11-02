// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The Shelf's Phone tab while sharing with a phone: the QR code isled made, what to do with it, the phones
// that ask to connect (Allow or Deny here too) and what to know about the network.

import Clutter from 'gi://Clutter';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import St from 'gi://St';

import {VERTICAL, onUiScale, uiScale} from '../compat.js';
import {icon, iconButton, label, pillButton, wrapLines} from '../widgets.js';

/** The tallest the code may be (CSS px): the page's height less its top padding. */
const CODE_HEIGHT = 144;
/** White modules round the code, as scanners want. */
const QUIET = 2;
const CODE_RADIUS = 10;
/** Phones asking shown at once on the tab, and rows of any kind (one saying goodbye included). */
const MAX_ASKS_SHOWN = 2;
const MAX_ROWS = 3;
/** How long "Copied" shows on the copy button. */
const COPIED_MS = 1500;
/** A phone taken off or gone says so this long in its row, which then fades and folds away. */
const LEAVING_MS = 3000;
const FADE_MS = 200;
const FOLD_MS = 220;

/** What the island says of the network, by isled's `network`. */
const NETWORK_NOTES = {
    public: 'This network looks public · use your phone’s hotspot',
    open: 'Open Wi-Fi: others nearby could see the files · try a hotspot',
    unknown: 'Only share on a network you trust',
};
/** How to connect, one short step a line; the first says where (a network to avoid makes it a warning). */
const STEPS = ['Same Wi-Fi as this computer, or its hotspot', 'Scan the code with the camera', 'Allow it here with the code it shows'];

/** The QR code, black on white, each module whole device pixels so it is sharp at any scale. */
export const PhoneCode = GObject.registerClass(
class PhoneCode extends St.DrawingArea {
    _init() {
        super._init({
            style_class: 'isle-phone-code',
            accessible_name: 'Code to open the Shelf on your phone',
            y_align: Clutter.ActorAlign.START,
        });
        this._rows = [];
        this.connect('repaint', area => this._paint(area));
        onUiScale(this, () => this._resize());
    }

    /** isled's rows of 0s and 1s. */
    set rows(rows) {
        const same = rows.length === this._rows.length && rows.every((row, i) => row === this._rows[i]);
        if (same)
            return;
        this._rows = rows;
        this._resize();
        this.queue_repaint();
    }

    /** As big as fits the page in whole device pixels a module: four at 100%, eight at 200%. */
    _resize() {
        const count = this._rows.length + 2 * QUIET;
        const scale = uiScale();
        this._module = Math.max(1, Math.floor(CODE_HEIGHT * scale / count));
        const size = this._module * count;
        this.set_size(size, size);
    }

    _paint(area) {
        const cr = area.get_context();
        const [width, height] = area.get_surface_size();
        const radius = Math.min(CODE_RADIUS * uiScale(), QUIET * this._module);
        cr.newSubPath();
        cr.arc(width - radius, radius, radius, -Math.PI / 2, 0);
        cr.arc(width - radius, height - radius, radius, 0, Math.PI / 2);
        cr.arc(radius, height - radius, radius, Math.PI / 2, Math.PI);
        cr.arc(radius, radius, radius, Math.PI, 1.5 * Math.PI);
        cr.closePath();
        cr.setSourceRGB(1, 1, 1);
        cr.fill();
        cr.setSourceRGB(0, 0, 0);
        const size = this._module;
        this._rows.forEach((row, y) => {
            for (let x = 0; x < row.length; x++) {
                if (row[x] === '1')
                    cr.rectangle((QUIET + x) * size, (QUIET + y) * size, size, size);
            }
        });
        cr.fill();
        cr.$dispose();
    }
});

// Signals: `answer` (id, allow) for a phone asking to connect; `remove` (id) for one let in.
// Everything starts at the top, under the tab bar, on its left edge; blocks and rows 6 px apart.
export const PhoneView = GObject.registerClass({
    Signals: {
        'answer': {param_types: [GObject.TYPE_STRING, GObject.TYPE_BOOLEAN]},
        'remove': {param_types: [GObject.TYPE_STRING]},
    },
}, class PhoneView extends St.BoxLayout {
    _init() {
        super._init({
            ...VERTICAL,
            style_class: 'isle-phone',
            x_expand: true,
            y_expand: true,
            y_align: Clutter.ActorAlign.FILL,
        });
        this._title = label('Scan with your phone', 'isle-phone-title', {y_align: Clutter.ActorAlign.START});
        this.add_child(this._title);

        // Not connected yet: three numbered steps.
        this._steps = new St.BoxLayout({...VERTICAL, style_class: 'isle-phone-steps'});
        this._stepTexts = STEPS.map((text, i) => {
            const step = new St.BoxLayout({style_class: 'isle-phone-step'});
            // The digit centred in its circle: a label as tall as the circle would sit at its top.
            step.add_child(new St.Bin({style_class: 'isle-phone-step-number', y_align: Clutter.ActorAlign.START,
                child: label(String(i + 1), 'isle-phone-step-digit', {x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER})}));
            const words = label(text, 'isle-phone-step-text', {x_expand: true, y_align: Clutter.ActorAlign.START});
            wrapLines(words);
            step.add_child(words);
            this._steps.add_child(step);
            return words;
        });
        this.add_child(this._steps);

        // Phones asking, each with its code and its own Deny and Allow; then those let in, each with ×.
        this._asks = new St.BoxLayout({...VERTICAL, style_class: 'isle-phone-rows'});
        this.add_child(this._asks);
        this._phones = new St.BoxLayout({...VERTICAL, style_class: 'isle-phone-rows'});
        this.add_child(this._phones);
        /** Each row by the phone's id and what it shows, kept while that stays (its buttons under the pointer). */
        this._rows = new Map();
        /** Phones taken off with ×, until isled no longer lists them. */
        this._removing = new Set();

        this._note = new St.BoxLayout({style_class: 'isle-phone-note'});
        this._note.add_child(new St.Icon({gicon: icon('isle-warning-symbolic'), icon_size: 12, y_align: Clutter.ActorAlign.START,
            style_class: 'isle-phone-note-icon'}));
        this._noteText = label('', 'isle-phone-note-text', {x_expand: true});
        wrapLines(this._noteText);
        this._note.add_child(this._noteText);
        this.add_child(this._note);

        // At the bottom, before a phone is in: the link to send another way, or the firewall's fix.
        this.add_child(new St.Widget({y_expand: true}));
        this._copyRow = new St.BoxLayout({style_class: 'isle-phone-copy'});
        this._copyText = label('', 'isle-phone-copy-text', {y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        wrapLines(this._copyText);
        this._copy = pillButton('', 'isle-pill-small', () => this._copyNow());
        this._copyRow.add_child(this._copyText);
        this._copyRow.add_child(this._copy);
        this.add_child(this._copyRow);

        this._state = null;
        this._fix = null;
        this._url = null;
        this.connect('destroy', () => {
            this._cancelCopied();
            for (const row of this._rows.values())
                this._cancelLeaving(row);
        });
    }

    /** The session's address (from Share1.Code), for Copy link. */
    set url(url) {
        this._url = url;
        this._sync();
    }

    /** Shows isled's sharing state (see Share1.State). */
    update(state) {
        this._state = state;
        // A phone taken off with × stays off here, whatever a state from before isled heard of it says;
        // forgotten once isled lists it no more.
        const listed = state?.phones ?? [];
        for (const id of [...this._removing]) {
            if (!listed.some(phone => phone.id === id))
                this._removing.delete(id);
        }
        const phones = listed.filter(phone => !this._removing.has(phone.id));
        // Two at most: more wait their turn here (each has its alert too), so nothing outgrows the page.
        const asks = (state?.asking ?? []).slice(0, MAX_ASKS_SHOWN);
        this._syncRows(this._asks, asks, ask => this._askRow(ask));
        this._syncRows(this._phones, phones, phone => this._phoneRow(phone));
        // Room for the live rows first: a row saying goodbye goes at once when it would crowd them.
        let rows = this._asks.get_n_children() + this._phones.get_n_children();
        for (const [key, row] of [...this._rows]) {
            if (rows <= MAX_ROWS)
                break;
            if (row._leaving) {
                this._drop(key, row);
                rows--;
            }
        }
        this._sync();
    }

    /** Sharing is off: every row goes at once, so a new start shows the steps. */
    reset() {
        this._removing.clear();
        for (const [key, row] of [...this._rows])
            this._drop(key, row);
        this.update(null);
    }

    /** What shows, from the state and the rows still on screen (one leaving counts until it has gone). */
    _sync() {
        const state = this._state;
        const asks = this._asks.get_n_children();
        const phones = this._phones.get_n_children();
        const connected = asks + phones > 0;
        const note = NETWORK_NOTES[state?.network] ?? null;
        // Not connected: the steps, the first a warning on a network to avoid; the copy row at the bottom.
        this._steps.visible = !connected;
        const warn = ['public', 'open'].includes(state?.network);
        this._stepTexts[0].text = warn ? note : STEPS[0];
        if (warn)
            this._stepTexts[0].add_style_class_name('isle-phone-warning');
        else
            this._stepTexts[0].remove_style_class_name('isle-phone-warning');
        // Asked, the rows say it all; with three phones in, the title makes room.
        this._title.visible = asks === 0 && phones < 3;
        this._note.visible = connected && Boolean(note) && asks + phones < 3;
        this._noteText.text = note ?? '';
        this._fix = state?.firewall ?? null;
        this._copyRow.visible = !connected && Boolean(this._fix || this._url);
        this._copyText.text = this._fix ? 'Phone can’t connect? ufw may block it' : 'Can’t scan? Send the link another way';
        if (!this._copiedTimer)
            this._copy.label = this._fix ? 'Copy fix' : 'Copy link';
    }

    /** One row per item, in order, kept while its phone stays (refreshed in place); one whose phone went says
     * so first, and a phone back while its row says goodbye gets a fresh row. */
    _syncRows(box, items, make) {
        const asks = box === this._asks;
        const keyOf = item => asks ? `ask:${item.id}:${item.code}` : `in:${item.id}`;
        const keys = items.map(keyOf);
        for (const [key, row] of [...this._rows]) {
            if (row.get_parent() !== box)
                continue;
            if (keys.includes(key)) {
                if (row._leaving)
                    this._drop(key, row);
            } else if (!row._leaving) {
                if (asks)
                    this._drop(key, row);
                else
                    this._leave(row, `${row._device} left`);
            }
        }
        items.forEach((item, index) => {
            let row = this._rows.get(keys[index]);
            if (!row) {
                row = make(item);
                this._rows.set(keys[index], row);
                box.insert_child_at_index(row, index);
            } else if (!asks) {
                this._refresh(row, item);
            }
        });
        box.visible = box.get_n_children() > 0;
    }

    /** Takes a row away now: its goodbye's timer and easing stop with it. */
    _drop(key, row) {
        this._cancelLeaving(row);
        row.remove_all_transitions();
        this._rows.delete(key);
        row.destroy();
    }

    /** A phone asking: its code, what it is and where from; Deny and Allow answer this phone, whatever
     * else comes or goes meanwhile. */
    _askRow({id, code, device, address}) {
        const row = new St.BoxLayout({style_class: 'isle-phone-row isle-phone-ask'});
        const words = new St.BoxLayout({...VERTICAL, x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        words.add_child(label(`Code ${code}`, 'isle-phone-code-text'));
        const what = label(`${device} · ${address}`, 'isle-phone-hint');
        wrapLines(what);
        words.add_child(what);
        row.add_child(words);
        const deny = pillButton('Deny', 'isle-pill-small', () => this.emit('answer', id, false));
        const allow = pillButton('Allow', 'isle-pill-small isle-pill-white isle-pill-decision', () => this.emit('answer', id, true));
        deny.accessible_name = `Deny ${device} with code ${code}`;
        allow.accessible_name = `Allow ${device} with code ${code}`;
        row.add_child(deny);
        row.add_child(allow);
        return row;
    }

    /** A phone let in, with × to take it off; taken off, the row says so in place, then goes. */
    _phoneRow(phone) {
        const {id, device} = phone;
        const row = new St.BoxLayout({style_class: 'isle-phone-row isle-phone-status'});
        row._dot = new St.Widget({style_class: 'isle-phone-dot', y_align: Clutter.ActorAlign.CENTER});
        row.add_child(row._dot);
        row._text = label('', 'isle-phone-status-text', {x_expand: true});
        wrapLines(row._text);
        row.add_child(row._text);
        row._remove = iconButton('isle-close-symbolic', 'isle-phone-remove', () => {
            this._removing.add(id);
            this.emit('remove', id);
            this._leave(row, `✓ ${row._device} disconnected`);
        }, {size: 10, accessibleName: `Take ${device} off`});
        row.add_child(row._remove);
        this._refresh(row, phone);
        return row;
    }

    /** A phone's row as it stands: here (a green dot), or away (dim, "away"; still in, its × still there). */
    _refresh(row, {device, address, here = true}) {
        if (row._leaving)
            return;
        row._device = device;
        row._text.text = here ? `${device} · ${address}` : `${device} · ${address} · away`;
        if (here) {
            row._dot.add_style_class_name('on');
            row.remove_style_class_name('isle-phone-away');
        } else {
            row._dot.remove_style_class_name('on');
            row.add_style_class_name('isle-phone-away');
        }
    }

    // The row turns into a dim line saying what happened, in place (its × kept as room, out of reach);
    // after a while it fades, then folds away, the rows under it sliding up.
    _leave(row, text) {
        if (row._leaving)
            return;
        row._leaving = true;
        row._text.text = text;
        row.add_style_class_name('isle-phone-leaving');
        row._dot.opacity = 0;
        row._remove.opacity = 0;
        row._remove.reactive = row._remove.can_focus = false;
        row._timer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, LEAVING_MS, () => {
            row._timer = 0;
            row.ease({
                opacity: 0,
                duration: FADE_MS,
                mode: Clutter.AnimationMode.EASE_OUT_QUAD,
                onComplete: () => {
                    // Its height made fixed first, so it folds from where it is.
                    const [, natural] = row.get_preferred_height(row.width);
                    row.height = natural;
                    row.ease({height: 0, duration: FOLD_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD, onComplete: () => this._gone(row)});
                },
            });
            return GLib.SOURCE_REMOVE;
        });
    }

    /** A row that has folded away: the tab shows what is left (the steps again, once the last is gone). */
    _gone(row) {
        for (const [key, kept] of this._rows) {
            if (kept === row)
                this._rows.delete(key);
        }
        const box = row.get_parent();
        row.destroy();
        if (box)
            box.visible = box.get_n_children() > 0;
        this._sync();
    }

    _cancelLeaving(row) {
        if (row._timer)
            GLib.source_remove(row._timer);
        row._timer = 0;
    }

    /** Copies the ufw command, or the link; the button says so a moment. */
    _copyNow() {
        const text = this._fix ?? this._url;
        if (!text)
            return;
        St.Clipboard.get_default().set_text(St.ClipboardType.CLIPBOARD, text);
        this._copy.label = 'Copied';
        this._cancelCopied();
        this._copiedTimer = GLib.timeout_add(GLib.PRIORITY_DEFAULT, COPIED_MS, () => {
            this._copiedTimer = 0;
            this._sync();
            return GLib.SOURCE_REMOVE;
        });
    }

    _cancelCopied() {
        if (this._copiedTimer)
            GLib.source_remove(this._copiedTimer);
        this._copiedTimer = 0;
    }
});
