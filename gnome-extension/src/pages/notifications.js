// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Notifications: a heading with Do Not Disturb and Clear (and, while it is on, what still gets through),
// over a list of one-line rows, newest first. Click one to open it. See docs/product-spec.md.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, iconSize} from '../compat.js';
import * as Format from '../format.js';
import {notificationIcon, plainBody} from '../notifications.js';
import {icon, iconButton, isSymbolic, label, ownIcon, pillButton, setButtonIcon} from '../widgets.js';
import {Page} from './page.js';

/** A card offers at most this many of its notification's buttons ("Mark as read", "Accept"). */
const MAX_ACTIONS = 3;

/** The app's icon, small beside its row: a colour one as is, a symbolic one on a grey rounded square. */
function notificationBadge(gicon) {
    gicon = gicon ? ownIcon(gicon) : icon('dialog-information-symbolic');
    if (!isSymbolic(gicon))
        return new St.Icon({gicon, icon_size: iconSize(20), y_align: Clutter.ActorAlign.CENTER});
    return new St.Bin({
        style_class: 'isle-notification-glyph',
        child: new St.Icon({gicon, icon_size: iconSize(12)}),
        y_align: Clutter.ActorAlign.CENTER,
    });
}

/** The page over `center`, which keeps the notifications and Do Not Disturb. */
export const NotificationsPage = GObject.registerClass(
class NotificationsPage extends Page {
    /** The list itself is built late, on the first warm-up or showing. */
    _init(daemon, center, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-notifications',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'notifications';
        this._center = center;

        this.add_child(this._buildBar());
        this.add_child(this._buildDndNote());
        this.add_child(this._buildList());

        this._centerHandlers = [
            // Closed, the list is only rebuilt when next shown (see `onActivate`).
            center.connect('changed', () => this._onListChanged()),
            // Shown anew but not marked seen: its banner does that once shown (see `acknowledge`).
            center.connect('updated', () => this._onListChanged({seen: false})),
            // Seen or not shows only in the tab's dot: the cards stay.
            center.connect('seen-changed', () => this.emit('news-changed')),
            center.connect('dnd-changed', () => this._updateDnd()),
        ];
        // Built when first warmed up or shown (see `warmUp`).
        this._times = [];
        this._stale = true;
        this._updateDnd();
        this.connect('destroy', () => this._onDestroy());
    }

    /** Unseen notifications make it the page to open on. */
    get relevant() {
        return this._center.hasUnseen;
    }

    /** Unseen ones put a dot on the tab. */
    get hasNews() {
        return this._center.hasUnseen;
    }

    /** How many there are, then Do Not Disturb and Clear All as small round buttons. */
    _buildBar() {
        const bar = new St.BoxLayout({style_class: 'isle-notifications-bar'});
        bar.add_child(label('Notifications', 'isle-notifications-heading', {x_expand: true, y_align: Clutter.ActorAlign.CENTER}));
        this._dndButton = iconButton('isle-bell', 'isle-button-flat isle-dnd-toggle', () => {
            this._center.dnd = !this._center.dnd;
        }, {size: 13, accessibleName: 'Do Not Disturb'});
        this._dndButton.y_align = Clutter.ActorAlign.CENTER;
        this._clearButton = pillButton('Clear', 'isle-pill-small isle-notifications-clear', () => this._center.clearAll());
        this._clearButton.y_align = Clutter.ActorAlign.CENTER;
        bar.add_child(this._dndButton);
        bar.add_child(this._clearButton);
        return bar;
    }

    /** While Do Not Disturb is on, what it does: a moon and a line under the heading. */
    _buildDndNote() {
        this._dndNote = new St.BoxLayout({style_class: 'isle-notifications-dnd-note', visible: false});
        // Dimmed as the line beside it: the moon is drawn white, so its colour can't be set.
        this._dndNote.add_child(new St.Icon({gicon: icon('isle-moon'), icon_size: iconSize(10), opacity: 130, y_align: Clutter.ActorAlign.CENTER}));
        const text = label('Do Not Disturb: new ones wait here; urgent ones still show', 'isle-notifications-dnd-text',
            {x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        text.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        this._dndNote.add_child(text);
        return this._dndNote;
    }

    /** The scrolling list of rows, with "No notifications" in its place when empty. */
    _buildList() {
        this._list = new St.BoxLayout({...VERTICAL, style_class: 'isle-notification-list'});
        this._scroll = new St.ScrollView({
            style_class: 'isle-task-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the cards.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(this._list);

        this._empty = new St.BoxLayout({...VERTICAL, style_class: 'isle-empty', x_align: Clutter.ActorAlign.CENTER, y_align: Clutter.ActorAlign.CENTER, x_expand: true});
        this._empty.add_child(new St.Icon({gicon: icon('isle-bell'), icon_size: iconSize(24), style_class: 'isle-empty-icon', x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('No notifications', 'isle-empty-title', {x_align: Clutter.ActorAlign.CENTER}));
        this._empty.add_child(label('You’re all caught up', 'isle-empty-hint', {x_align: Clutter.ActorAlign.CENTER}));

        const column = new St.Widget({layout_manager: new Clutter.BinLayout(), x_expand: true, y_expand: true});
        column.add_child(this._scroll);
        column.add_child(this._empty);
        return column;
    }

    /** Rebuilds now if shown, or marks the list stale for the next showing. */
    _onListChanged({seen = true} = {}) {
        if (this.active)
            this._update({seen});
        else
            this._stale = true;
        this.markCold();
        this.emit('news-changed');
    }

    /** Rebuilds every row; `seen` false leaves them unread even while shown. */
    _update({seen = true} = {}) {
        this._stale = false;
        /** Each row's "5m ago", with when it came, to bring up to date without a rebuild. */
        this._times = [];
        const notifications = this._center.notifications;
        this._clearButton.visible = notifications.some(n => !n.resident);

        // Newest first, one row each, as a list to scroll.
        this._list.destroy_all_children();
        for (const notification of notifications)
            this._list.add_child(this._row(notification));
        this._empty.visible = notifications.length === 0;
        this._scroll.visible = notifications.length > 0;

        // Seen while open: no unread dot for something already on screen.
        if (this.active && seen)
            this._center.acknowledgeAll();
    }

    /** The bell turns into a checked moon, and the note shows, while Do Not Disturb is on. */
    _updateDnd() {
        const on = this._center.dnd;
        if (on)
            this._dndButton.add_style_pseudo_class('checked');
        else
            this._dndButton.remove_style_pseudo_class('checked');
        setButtonIcon(this._dndButton, on ? 'isle-moon' : 'isle-bell');
        this._dndNote.visible = on;
    }

    /** A row: the app's icon, who and what on one line, and when; under the pointer, its buttons and ×. */
    _row(notification) {
        const content = new St.BoxLayout({style_class: 'isle-notification', x_expand: true});
        content.add_child(notificationBadge(notificationIcon(notification)));

        const line = new St.BoxLayout({style_class: 'isle-notification-line', x_expand: true, y_align: Clutter.ActorAlign.CENTER});
        // On one line, as the body: a title may hold line breaks too.
        const title = label((notification.title || notification.source?.title || '').replace(/\s+/g, ' ').trim(), 'isle-notification-title');
        // While the screen is shared, only who wrote, not what.
        const text = this._sharing ? '' : plainBody(notification).replace(/\s+/g, ' ').trim();
        const body = label(text, 'isle-notification-body', {x_expand: true});
        for (const part of [title, body])
            part.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        body.visible = body.text.length > 0;
        line.add_child(title);
        line.add_child(body);
        content.add_child(line);

        // The time, and in its place under the pointer the buttons and ×.
        const corner = new St.Widget({layout_manager: new Clutter.BinLayout(), y_align: Clutter.ActorAlign.CENTER});
        const time = label(Format.ago(notification.datetime), 'isle-notification-time', {x_align: Clutter.ActorAlign.END});
        this._times.push([time, notification.datetime]);
        corner.add_child(time);
        const tools = new St.BoxLayout({style_class: 'isle-notification-tools', x_align: Clutter.ActorAlign.END, opacity: 0, visible: false});
        // Its buttons, as GNOME's banner had them; not while the screen is shared.
        const actions = this._sharing ? [] : (notification.actions ?? []).slice(0, MAX_ACTIONS);
        for (const action of actions) {
            tools.add_child(pillButton(action.label, 'isle-pill-small isle-notification-action', () => {
                action.activate();
                this.emit('request-close');
            }));
        }
        if (!notification.resident) {
            const dismiss = iconButton('isle-close-symbolic', 'isle-button-flat isle-notification-dismiss',
                () => notification.destroy(), {size: 10, accessibleName: 'Dismiss'});
            dismiss.y_align = Clutter.ActorAlign.CENTER;
            tools.add_child(dismiss);
        }
        corner.add_child(tools);
        content.add_child(corner);

        const row = new St.Button({style_class: 'isle-notification-row', child: content, x_expand: true, can_focus: true});
        row.connect('clicked', () => {
            notification.activate();
            this.emit('request-close');
        });
        if (tools.get_n_children() > 0) {
            row.connect('notify::hover', () => {
                tools.show();
                tools.ease({opacity: row.hover ? 255 : 0, duration: 120,
                    onComplete: () => (tools.visible = row.hover)});
                time.ease({opacity: row.hover ? 0 : 255, duration: 120});
            });
        }
        return row;
    }

    /** Builds the list ahead, if it is out of date. */
    warmUp() {
        if (this._stale)
            this._update();
    }

    /** While the screen is shared or recorded, the cards leave out what the notifications say. */
    set sharing(sharing) {
        if (sharing === Boolean(this._sharing))
            return;
        this._sharing = sharing;
        if (this.active)
            this._update();
        else
            this._stale = true;
        this.markCold();
    }

    /** Opening the page counts as seeing them all. */
    onActivate() {
        this._center.acknowledgeAll();
        // Rebuilt only if something came or went while it was closed; else just the times move on.
        if (this._stale)
            this._update();
        else
            this._times.forEach(([time, datetime]) => (time.text = Format.ago(datetime)));
    }

    /** Lets go of the notification center's signals. */
    _onDestroy() {
        this._centerHandlers.forEach(id => this._center.disconnect(id));
    }
});
