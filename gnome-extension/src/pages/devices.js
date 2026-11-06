// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// The connected Bluetooth devices, a card each and every card alike: the device's icon on a tile, its name and
// "Connected" (or "Low battery"), then its battery filled to the level, and the level. However many there are, the
// cards start at the page's top: up to three, a row each across the page; from four, two side by side (an odd last
// one across both), three rows to the page and the rest scrolling. Off until its switch in Settings is on; the tab
// shows only while a device is connected. It changes only as isled's state does (BlueZ says when a level moves):
// nothing is asked or timed here.

import Clutter from 'gi://Clutter';
import GObject from 'gi://GObject';
import Pango from 'gi://Pango';
import St from 'gi://St';

import {VERTICAL, px} from '../compat.js';
import {LOW_BATTERY, deviceIcon, icon, label} from '../widgets.js';
import {Page} from './page.js';

/** Sizes in CSS pixels (see `px`): the room between cards, and the page's own top padding (`.isle-page`). */
const GAP = 8;
const PAGE_TOP = 6;
/** Rows of cards the page shows at once; more scroll. */
const ROWS_SHOWN = 3;

/** A card's height (CSS px); three rows to the page take a little less, the same card a touch denser. */
const CARD_HEIGHT = 52;
/** How many cards a row holds for `count`: one each up to three, then two side by side. */
function columnsFor(count) {
    return count <= 3 ? 1 : 2;
}

/** How many cards share the row card `index` of `count` is in: an odd last one has the row to itself. */
function rowmates(index, count) {
    const columns = columnsFor(count);
    const full = Math.floor(count / columns) * columns;
    return index < full ? columns : count - full;
}

// The cards from the page's top, rows as tall as CARD_HEIGHT (three to the page take less; the rest scroll), each
// row's cards sharing its width. On whole pixels, so their edges stay sharp.
const DeviceGrid = GObject.registerClass(
class DeviceGrid extends Clutter.LayoutManager {
    /** `height` is the page's content height, in CSS pixels. */
    _init(height) {
        super._init();
        this._height = height;
    }

    /** The page's content height, in CSS pixels (Settings → Size makes it taller). */
    set height(height) {
        if (height === this._height)
            return;
        this._height = height;
        this.layout_changed();
    }

    _rows(count) {
        return Math.ceil(count / columnsFor(count));
    }

    /** A row's height with `rows` rows: CARD_HEIGHT, or as three share the page's height. */
    _row(rows) {
        if (rows < ROWS_SHOWN)
            return px(CARD_HEIGHT);
        return Math.min(px(CARD_HEIGHT), Math.floor((px(this._height) - px(GAP) * (ROWS_SHOWN - 1)) / ROWS_SHOWN));
    }

    vfunc_get_preferred_width(_container, _forHeight) {
        return [0, 0];
    }

    vfunc_get_preferred_height(container, _forWidth) {
        const rows = this._rows(container.get_n_children());
        const height = rows * this._row(rows) + Math.max(0, rows - 1) * px(GAP);
        return [height, height];
    }

    vfunc_allocate(container, box) {
        const gap = px(GAP);
        const cards = container.get_children();
        const count = cards.length;
        const columns = columnsFor(count);
        const row = this._row(this._rows(count));
        const width = box.get_width();
        cards.forEach((card, index) => {
            const mates = rowmates(index, count);
            const cell = (width - gap * (mates - 1)) / mates;
            const x = box.x1 + (index % columns) * (cell + gap);
            const y = box.y1 + Math.floor(index / columns) * (row + gap);
            card.allocate(Clutter.ActorBox.new(Math.round(x), y, Math.round(x + cell), y + row));
        });
    }
});

// A battery on its side: a rounded outline, a nub at its end, filled from the left to the level.
const BatteryBody = GObject.registerClass(
class BatteryBody extends St.Widget {
    _init() {
        super._init({style_class: 'isle-device-battery-body', y_align: Clutter.ActorAlign.CENTER});
        this._fill = new St.Widget({style_class: 'isle-device-battery-fill'});
        this.add_child(this._fill);
        this._level = 0;
    }

    /** 0 to 1. */
    set level(level) {
        if (level === this._level)
            return;
        this._level = level;
        this.queue_relayout();
    }

    vfunc_allocate(box) {
        this.set_allocation(box);
        const inside = this.get_theme_node().get_content_box(box);
        const [width, height] = inside.get_size();
        // A sliver at least, so a nearly flat battery still shows its red.
        const filled = Math.max(Math.round(width / 8), Math.round(width * this._level));
        this._fill.allocate(Clutter.ActorBox.new(inside.x1, inside.y1, inside.x1 + filled, inside.y1 + height));
    }
});

// One device: its icon on a tile, its name and "Connected" under it ("Low battery" in red when low), then its battery
// and level, red when low; "No battery info" for a device that reports none. The name gives way ("…"): the battery and
// the level keep their room.
const DeviceCard = GObject.registerClass(
class DeviceCard extends St.BoxLayout {
    _init() {
        super._init({style_class: 'isle-device-card'});
        this._tile = new St.Bin({style_class: 'isle-device-tile', y_align: Clutter.ActorAlign.CENTER});
        this._icon = new St.Icon({style_class: 'isle-device-icon'});
        this._tile.set_child(this._icon);

        const texts = new St.BoxLayout({...VERTICAL, style_class: 'isle-device-texts', x_expand: true,
            y_align: Clutter.ActorAlign.CENTER});
        this._name = label('', 'isle-device-name');
        this._name.clutter_text.ellipsize = Pango.EllipsizeMode.END;
        const status = new St.BoxLayout({style_class: 'isle-device-status'});
        status.add_child(new St.Widget({style_class: 'isle-device-dot', y_align: Clutter.ActorAlign.CENTER}));
        this._status = label('Connected', 'isle-device-connected');
        status.add_child(this._status);
        texts.add_child(this._name);
        texts.add_child(status);

        const power = new St.BoxLayout({style_class: 'isle-device-power', y_align: Clutter.ActorAlign.CENTER});
        this._battery = new St.BoxLayout({style_class: 'isle-device-battery', y_align: Clutter.ActorAlign.CENTER});
        this._body = new BatteryBody();
        this._battery.add_child(this._body);
        this._battery.add_child(new St.Widget({style_class: 'isle-device-battery-nub', y_align: Clutter.ActorAlign.CENTER}));
        this._level = label('', 'isle-device-level', {y_align: Clutter.ActorAlign.CENTER});
        this._none = label('No battery info', 'isle-device-none', {y_align: Clutter.ActorAlign.CENTER});
        for (const child of [this._battery, this._level, this._none])
            power.add_child(child);

        for (const child of [this._tile, texts, power])
            this.add_child(child);
        /** The level shown: null with none, undefined at first. */
        this._percent = undefined;
    }

    /** Shows `device` ({name, icon, battery}) as it is now; a new level only moves the fill and the number. */
    update(device) {
        this._icon.gicon = icon(deviceIcon(device.icon));
        this._name.text = device.name;
        const percent = device.battery ?? null;
        if (percent === this._percent)
            return;
        this._percent = percent;
        const known = percent !== null;
        this._battery.visible = this._level.visible = known;
        this._none.visible = !known;
        if (known) {
            this._level.text = `${percent}%`;
            this._body.level = Math.min(100, Math.max(0, percent)) / 100;
        }
        const low = known && percent <= LOW_BATTERY;
        this._status.text = low ? 'Low battery' : 'Connected';
        if (low)
            this.add_style_class_name('low');
        else
            this.remove_style_class_name('low');
    }
});

export const DevicesPage = GObject.registerClass(
class DevicesPage extends Page {
    /** `height` is the expanded island's page height. */
    _init(daemon, {height}) {
        super._init(daemon, {
            style_class: 'isle-page isle-devices-page',
            layout_manager: new Clutter.BoxLayout({orientation: Clutter.Orientation.VERTICAL}),
            height,
        });
        this.name = 'devices';
        /** Cards by the device's BlueZ path, in the order isled lists them. */
        this._cards = new Map();
        this._dense = false;

        this._layout = new DeviceGrid(height - PAGE_TOP);
        this._grid = new St.Viewport({style_class: 'isle-devices', layout_manager: this._layout});
        const scroll = new St.ScrollView({
            style_class: 'isle-devices-scroll',
            hscrollbar_policy: St.PolicyType.NEVER,
            // Scrolls with the wheel or touchpad; no scrollbar over the cards.
            vscrollbar_policy: St.PolicyType.EXTERNAL,
            x_expand: true,
            y_expand: true,
        });
        scroll.set_child(this._grid);
        this.add_child(scroll);

        this.watch(['system'], () => this._update());
        this._update();
    }

    /** Settings → Size: the rows share the taller page. */
    onPageHeight(height) {
        this._layout.height = height - PAGE_TOP;
    }

    /** Only while a device is connected, and once turned on in Settings. */
    get available() {
        return !this.hidden && this._cards.size > 0;
    }

    /** A card per connected device, kept and updated in place as their batteries change; laid out anew only when
     * how many there are changes. */
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
                this._grid.insert_child_at_index(card, index);
            } else if (this._grid.get_child_at_index(index) !== card) {
                this._grid.set_child_at_index(card, index);
            }
            card.update(device);
        });
        // Three rows to the page: the same cards, a touch denser.
        const dense = Math.ceil(devices.length / columnsFor(devices.length)) >= ROWS_SHOWN;
        if (dense !== this._dense) {
            this._dense = dense;
            if (dense)
                this._grid.add_style_class_name('isle-devices-dense');
            else
                this._grid.remove_style_class_name('isle-devices-dense');
        }
        this._layout.layout_changed();
        if ((this._cards.size > 0) !== had)
            this.emit('availability-changed');
    }
});
