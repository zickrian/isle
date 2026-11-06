// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The connected Bluetooth devices, a card each in a row: the device's icon in a ring of its battery, the level
// under it and its name. Off until its switch in Settings is on; the tab shows only while a device is connected.
// It changes only as isled's state does (BlueZ says when a level moves): nothing is asked or timed here.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, onUiScale} from '../compat.js';
import * as Palette from '../palette.js';
import * as Theme from '../theme.js';
import {LOW_BATTERY, Ring, deviceIcon, icon, label, scrollSideways} from '../widgets.js';
import {Page} from './page.js';

/** Sizes in CSS pixels (see `px`). */
const RING_SIZE = 56;
const RING_LINE = 4;
const ICON_SIZE = 24;

// One device: its icon in its battery's ring (only the icon when it reports no battery), the level, the name.
const DeviceCard = GObject.registerClass(
class DeviceCard extends St.BoxLayout {
    _init() {
        super._init({style_class: 'isle-device', y_expand: true});
        /** The level shown, null with none; undefined until first shown. */
        this._percent = undefined;

        // The ring and the icon stacked, in a slot that keeps its size with no ring.
        const slot = new St.Widget({layout_manager: new Clutter.BinLayout(), x_align: Clutter.ActorAlign.CENTER});
        onUiScale(slot, scale => slot.set_size(RING_SIZE * scale, RING_SIZE * scale));
        this._ring = new Ring({size: RING_SIZE, lineWidth: RING_LINE});
        this._icon = new St.Icon({
            style_class: 'isle-device-icon',
            icon_size: ICON_SIZE,
            x_align: Clutter.ActorAlign.CENTER,
            y_align: Clutter.ActorAlign.CENTER,
        });
        slot.add_child(this._ring);
        slot.add_child(this._icon);

        this._level = label('', 'isle-device-percent', {x_align: Clutter.ActorAlign.CENTER});
        this._name = label('', 'isle-device-name', {x_align: Clutter.ActorAlign.CENTER});
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;

        const column = new St.BoxLayout({...VERTICAL, x_expand: true, y_expand: true, y_align: Clutter.ActorAlign.CENTER});
        for (const child of [slot, this._level, this._name])
            column.add_child(child);
        this.add_child(column);
    }

    /** Shows `device` ({name, icon, battery}) as it is now. */
    update(device) {
        this._icon.gicon = icon(deviceIcon(device.icon));
        this._name.text = device.name;
        const percent = device.battery ?? null;
        if (percent === this._percent)
            return;
        this._percent = percent;
        const known = percent !== null;
        this._ring.visible = this._level.visible = known;
        // With no level, the name comes up to the icon as the level would.
        if (known)
            this._name.remove_style_class_name('alone');
        else
            this._name.add_style_class_name('alone');
        if (!known)
            return;
        this._ring.progress = percent / 100;
        this._level.text = `${percent}%`;
        if (this._low)
            this._level.add_style_class_name('low');
        else
            this._level.remove_style_class_name('low');
        this.syncTheme();
    }

    get _low() {
        return typeof this._percent === 'number' && this._percent <= LOW_BATTERY;
    }

    /** The ring white, or red when low, in the island's look (a signal colour lifted on glass). */
    syncTheme() {
        this._ring.color = Theme.semantic(this._low ? Palette.RED : Palette.WHITE);
    }
});

export const DevicesPage = GObject.registerClass(
class DevicesPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-devices-page',
            layout_manager: new Clutter.BinLayout(),
            height,
        });
        this.name = 'devices';
        /** Cards by the device's BlueZ path, in the row in the order isled lists them. */
        this._cards = new Map();

        // A few cards sit in the middle; more scroll sideways, with no scrollbar.
        this._row = new St.BoxLayout({style_class: 'isle-devices', x_expand: true, x_align: Clutter.ActorAlign.CENTER});
        const content = new St.BoxLayout({y_expand: true});
        content.add_child(this._row);
        this._scroll = new St.ScrollView({
            style_class: 'isle-devices-scroll',
            hscrollbar_policy: St.PolicyType.EXTERNAL,
            vscrollbar_policy: St.PolicyType.NEVER,
            x_expand: true,
            y_expand: true,
        });
        this._scroll.set_child(content);
        this._scroll.connect('scroll-event', (_actor, event) => scrollSideways(this._scroll, event));
        this.add_child(this._scroll);

        this.watch(['system'], () => this._update());
        this._update();
    }

    /** Only while a device is connected, and once turned on in Settings. */
    get available() {
        return !this.hidden && this._cards.size > 0;
    }

    /** A card per connected device, kept and updated in place as their batteries change. */
    _update() {
        const devices = this.daemon.state.system?.bluetooth ?? [];
        const had = this._cards.size > 0;
        const paths = new Set(devices.map(device => device.path));
        for (const [path, card] of this._cards) {
            if (!paths.has(path)) {
                card.destroy();
                this._cards.delete(path);
            }
        }
        devices.forEach((device, index) => {
            let card = this._cards.get(device.path);
            if (!card) {
                card = new DeviceCard();
                this._cards.set(device.path, card);
                this._row.insert_child_at_index(card, index);
            } else if (this._row.get_child_at_index(index) !== card) {
                this._row.set_child_at_index(card, index);
            }
            card.update(device);
        });
        if ((this._cards.size > 0) !== had)
            this.emit('availability-changed');
    }
});
