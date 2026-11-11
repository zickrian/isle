// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Run through scripts/ci/native-scroll-test.sh; input travels through the private compositor.

import Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import GLib from 'gi://GLib';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';
import St from 'gi://St';
import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as Config from 'resource:///org/gnome/shell/misc/config.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';
import {Island} from 'file:///tmp/isle-repo/gnome-extension/src/island.js';
import {ExpandedView} from 'file:///tmp/isle-repo/gnome-extension/src/expanded.js';
import {Controller} from 'file:///tmp/isle-repo/gnome-extension/src/controller.js';
import {UsagePage} from 'file:///tmp/isle-repo/gnome-extension/src/pages/usage.js';
import {Page} from 'file:///tmp/isle-repo/gnome-extension/src/pages/page.js';
import {setIconDir} from 'file:///tmp/isle-repo/gnome-extension/src/widgets.js';
import {VERTICAL} from 'file:///tmp/isle-repo/gnome-extension/src/compat.js';

const ROOT = '/tmp/proof/evidence';
const run = 'native-scroll';
const records = [];
const failures = [];
let phase = 'setup';
const wait = ms => new Promise(resolve => GLib.timeout_add(GLib.PRIORITY_DEFAULT, ms, () => { resolve(); return GLib.SOURCE_REMOVE; }));
function log(record) { records.push({phase, ...record}); console.log(`ISLE-PROOF ${JSON.stringify(records.at(-1))}`); }
function check(name, condition, detail = {}) { log({assert: name, pass: Boolean(condition), ...detail}); if (!condition) failures.push(name); }
function eventData(event) {
    return {direction: event.get_scroll_direction(), source: event.get_scroll_source(), flags: event.get_flags(), delta: event.get_scroll_direction() === Clutter.ScrollDirection.SMOOTH ? event.get_scroll_delta() : null, finish: event.get_scroll_finish_flags(), device: event.get_source_device()?.get_device_name(), coords: event.get_coords()};
}
const Service = GObject.registerClass({Signals: {'changed': {param_types: [GObject.TYPE_STRING]}}}, class Service extends GObject.Object {
    _init() { super._init(); this.state = {usage: {providers: []}, nowPlaying: {}, pomodoro: {phase: 'idle'}}; }
    call(...args) { log({serviceCall: args}); }
});
function providers(count) {
    return ['claude', 'codex', 'agy', 'agy-claude-gpt', 'agy-argon'].slice(0, count).map((id, i) => ({id, name: ['Claude', 'Codex', 'Antigravity', 'Antigravity', 'Antigravity'][i], plan: ['Test plan', 'Test plan', 'Gemini', 'Claude / GPT', 'Argon'][i], windows: [{label: 'Five hours', percent: 25 + i * 10, resets_at_ms: Date.now() + 3600000}], updated_ms: Date.now()}));
}

export default class Proof extends Extension {
    enable() { this._startId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, 1800, () => { this._run().catch(error => { log({fatal: String(error), stack: error.stack}); this._finish(); }); return GLib.SOURCE_REMOVE; }); }
    disable() { this.tree?.island.destroy(); }
    async _ready(actor) {
        for (let i = 0; i < 100; i++) { if (actor.mapped && actor.width > 0 && actor.height > 0 && !this.tree.island.morphing) { await this._frames(); return; } await wait(30); }
        throw new Error(`Render not ready: ${actor.name} mapped=${actor.mapped} ${actor.width}x${actor.height}`);
    }
    _frames() { return new Promise(resolve => { let frames = 0; const id = global.stage.connect('after-paint', () => { if (++frames === 3) { global.stage.disconnect(id); resolve(); } else global.stage.queue_redraw(); }); global.stage.queue_redraw(); }); }
    async _capture(name) { await this._ready(this.tree.expanded); const path = `${ROOT}/${run}-${name}.png`; const stream = Gio.File.new_for_path(path).replace(null, false, Gio.FileCreateFlags.NONE, null); const shot = new Shell.Screenshot(); await shot.screenshot(false, stream); stream.close(null); log({screenshot: path, renderReady: true, size: [global.stage.width, global.stage.height]}); }
    async _tree(count) {
        this.tree?.island.destroy();
        const daemon = new Service(); daemon.state.usage.providers = providers(count);
        const privacy = new Service(); const call = new Service();
        const usage = new UsagePage(daemon, {height: 150});
        const listPage = new Page(daemon, {height: 150, reactive: true, layout_manager: new Clutter.BinLayout()}); listPage.name = 'notifications';
        const list = new St.ScrollView({height: 150, x_expand: true, reactive: true, vscrollbar_policy: St.PolicyType.AUTOMATIC, hscrollbar_policy: St.PolicyType.NEVER});
        const content = new St.BoxLayout({...VERTICAL});
        for (let i = 0; i < 30; i++) content.add_child(new St.Label({text: `Synthetic notification ${i}`, height: 30}));
        list.set_child(content); listPage.add_child(list);
        const settings = {get_boolean: () => false};
        const expanded = new ExpandedView(daemon, privacy, call, settings, [listPage, usage]);
        const island = new Island();
        const context = {_island: island, _presentation: 'expanded', _expandWanted: true, _alert: null, _dismissAlert() { log({alertAction: 'dismiss'}); this.actions++; }, _openFromClosed() { log({alertAction: 'open'}); this.actions++; }, actions: 0};
        island.connect('captured-event', (_actor, event) => { if (event.type() === Clutter.EventType.SCROLL) log({dispatch: 'island-capture', ...eventData(event), shown: usage._index()}); return Controller.prototype._onFieldPress.call(context, event); });
        island.connect('scroll-event', (_actor, event) => Controller.prototype._onAlertScroll.call(context, event));
        const drop = expanded._dropScrollCopies.bind(expanded);
        expanded._dropScrollCopies = event => { const result = drop(event); if (event.type() === Clutter.EventType.SCROLL) log({dispatch: 'expanded-capture', ...eventData(event), result, latch: expanded._smoothScrolling}); return result; };
        const scroll = usage._onScroll.bind(usage);
        usage._onScroll = event => { const before = usage._index(); const result = scroll(event); log({dispatch: 'usage-arrival', ...eventData(event), before, after: usage._index(), result}); return result; };
        list.connect('scroll-event', (_a, event) => { log({dispatch: 'list-arrival', ...eventData(event)}); return Clutter.EVENT_PROPAGATE; });
        Main.layoutManager.addChrome(island, {trackFullscreen: true});
        island.addView(expanded); island.monitor = Main.layoutManager.primaryMonitor; island.topInset = 40;
        expanded.height = 210;
        expanded.setActive(true);
        expanded.showPage(count ? 'usage' : 'notifications', {animate: false});
        island.morph({width: expanded.width, height: 210, radius: 32, shoulder: 0}, expanded);
        this.tree = {island, expanded, usage, listPage, list, daemon, context};
        await this._ready(expanded); await wait(400);
        log({treeReady: count, chain: [usage.get_parent(), expanded.get_parent(), island.get_parent()].map(a => a?.constructor.name), usageMapped: usage.mapped, bounds: this._bounds(usage)});
    }
    _bounds(actor) { const [x, y] = actor.get_transformed_position(); const [w, h] = actor.get_transformed_size(); return {x, y, w, h}; }
    async _point(actor, device = this.pointer) { const {x, y, w, h} = this._bounds(actor); const target = [x + w / 2, y + h / 2]; for (let i = 0; i < 10; i++) { device.notify_absolute_motion(GLib.get_monotonic_time(), ...target); await wait(60); const actual = global.get_pointer(); if (Math.abs(actual[0] - target[0]) < 1 && Math.abs(actual[1] - target[1]) < 1) break; } const actual = global.get_pointer(); check('pointer-routed', Math.abs(actual[0] - target[0]) < 1 && Math.abs(actual[1] - target[1]) < 1, {actual, target}); log({pointerTarget: actor.constructor.name, actualPointer: actual, picked: global.stage.get_actor_at_pos(Clutter.PickMode.REACTIVE, ...actual.slice(0, 2))?.constructor.name, bounds: {x, y, w, h}}); }
    async _wheel(direction = Clutter.ScrollDirection.DOWN, source = Clutter.ScrollSource.WHEEL, device = this.pointer) { device.notify_discrete_scroll(GLib.get_monotonic_time(), direction, source); await wait(280); }
    async _smooth(dy, source = Clutter.ScrollSource.FINGER, finish = Clutter.ScrollFinishFlags.NONE, device = this.pointer) { device.notify_scroll_continuous(GLib.get_monotonic_time(), 0, dy * 10, source, finish); await wait(80); }
    async _dot(index) { const dot = this.tree.usage._dots.get_child_at_index(index); const accessibleName = dot.accessible_name; await this._point(dot); this.pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.PRESSED); await wait(35); this.pointer.notify_button(GLib.get_monotonic_time(), Clutter.BUTTON_PRIMARY, Clutter.ButtonState.RELEASED); await wait(270); check(`dot-${index}`, this.tree.usage._index() === index && this.tree.usage._dots.get_child_at_index(index).has_style_class_name('shown'), {index: this.tree.usage._index(), accessibleName}); }
    async _run() {
        Main.overview.hide();
        await wait(600);
        const sampleLabel = new St.Label({text: 'ISOLATED INPUT QA · SYNTHETIC QUOTAS · NO ACCOUNT DATA', x: 20, y: 650, style: 'color: white; background-color: black; padding: 8px;'});
        Main.layoutManager.addChrome(sampleLabel);
        setIconDir(Gio.File.new_for_path('/tmp/isle-repo/gnome-extension/icons'));
        St.ThemeContext.get_for_stage(global.stage).get_theme().load_stylesheet(Gio.File.new_for_path('/tmp/isle-repo/gnome-extension/stylesheet.css'));
        this.pointer = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        this.second = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE);
        log({environment: {shell: Config.PACKAGE_VERSION, flag: Clutter.EventFlags.FLAG_POINTER_EMULATED, home: GLib.get_home_dir(), settings: GLib.getenv('GSETTINGS_BACKEND')}});
        for (const count of [3, 5, 2]) {
            phase = `cards-${count}`; await this._tree(count); await this._capture(`cards-${count}`);
            await this._point(this.tree.usage._card); await this._wheel(); check('native-wheel-first', this.tree.usage._index() === 1, {index: this.tree.usage._index()});
            for (let i = 0; i < count; i++) await this._wheel(); check('native-wheel-last-clamp', this.tree.usage._index() === count - 1, {index: this.tree.usage._index()});
            for (let i = 0; i < count; i++) await this._wheel(Clutter.ScrollDirection.UP); check('native-wheel-first-clamp', this.tree.usage._index() === 0, {index: this.tree.usage._index()});
            for (let i = 0; i < count; i++) await this._dot(i);
            await this._dot(0);
            phase = `header-smooth-then-wheel-${count}`; await this._point(this.tree.expanded._header); await this._smooth(-2); await wait(320);
            check('header-navigation', this.tree.expanded.page === this.tree.listPage);
            this.tree.expanded.showPage('usage', {animate: false}); await this._ready(this.tree.usage); await this._point(this.tree.usage._card); await this._wheel();
            check('native-wheel-after-header-smooth', this.tree.usage._index() === 1, {index: this.tree.usage._index(), latch: this.tree.expanded._smoothScrolling}); await this._capture(`header-smooth-${count}`);
            phase = `reopen-${count}`; this.tree.expanded.setActive(false); this.tree.island.hide(); await wait(50); this.tree.island.show(); this.tree.expanded.setActive(true); await this._ready(this.tree.usage); await this._dot(0); await this._point(this.tree.usage._card, this.second); await this._wheel(Clutter.ScrollDirection.DOWN, Clutter.ScrollSource.WHEEL, this.second); check('mixed-device-wheel-after-reopen', this.tree.usage._index() === 1, {index: this.tree.usage._index()});
        }
        phase = 'smooth-pairs'; this.pointer = Clutter.get_default_backend().get_default_seat().create_virtual_device(Clutter.InputDeviceType.POINTER_DEVICE); await this._tree(5); await this._point(this.tree.usage._card);
        const wheelStart = records.length;
        const discreteCount = () => records.slice(wheelStart).filter(record => record.dispatch === 'island-capture' && record.source === Clutter.ScrollSource.WHEEL && record.direction === Clutter.ScrollDirection.DOWN && record.flags === 0).length;
        await this._smooth(0.2, Clutter.ScrollSource.WHEEL); check('wheel-below-threshold', this.tree.usage._index() === 0 && discreteCount() === 0, {index: this.tree.usage._index(), genuineDiscrete: discreteCount()});
        await this._smooth(0.8, Clutter.ScrollSource.WHEEL); check('wheel-threshold-single', this.tree.usage._index() === 1 && discreteCount() === 1, {index: this.tree.usage._index(), genuineDiscrete: discreteCount()});
        await this._smooth(1.2, Clutter.ScrollSource.WHEEL); check('wheel-repeat-single', this.tree.usage._index() === 2 && discreteCount() === 2, {index: this.tree.usage._index(), genuineDiscrete: discreteCount()});
        await wait(220); await this._smooth(2); check('finger-threshold-single', this.tree.usage._index() === 3, {index: this.tree.usage._index()});
        await this._smooth(4); check('finger-long-once', this.tree.usage._index() === 3, {index: this.tree.usage._index()});
        this.pointer.notify_scroll_continuous(GLib.get_monotonic_time(), 20, 0, Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.NONE); await wait(80); check('finger-horizontal-does-not-end', this.tree.usage._index() === 3, {index: this.tree.usage._index()});
        await this._smooth(2); check('finger-horizontal-keeps-one-move', this.tree.usage._index() === 3, {index: this.tree.usage._index()});
        await this._smooth(0, Clutter.ScrollSource.FINGER, Clutter.ScrollFinishFlags.VERTICAL); await this._smooth(-2); check('finger-finish-next-gesture', this.tree.usage._index() === 2, {index: this.tree.usage._index()});
        await this._wheel(); check('native-wheel-after-finger', this.tree.usage._index() === 3, {index: this.tree.usage._index()});
        phase = 'list'; this.tree.expanded.showPage('notifications', {animate: false}); await this._ready(this.tree.list); await this._point(this.tree.list); const adjustment = this.tree.list.vadjustment; const start = adjustment.value; await this._wheel(); check('vertical-list-discrete', adjustment.value > start, {start, after: adjustment.value});
        await this._smooth(1.2, Clutter.ScrollSource.WHEEL); check('vertical-list-smooth-pair', adjustment.value > start, {start, after: adjustment.value});
        await this._point(this.tree.listPage); await this._smooth(0.1); this.tree.expanded.showPage('usage', {animate: false}); await this._ready(this.tree.usage); await this._dot(0); await this._point(this.tree.usage._card); await this._wheel(); check('native-wheel-after-other-page', this.tree.usage._index() === 1);
        for (const count of [0, 1]) { phase = `availability-${count}`; await this._tree(count); check('availability', this.tree.usage.available === (count > 0), {available: this.tree.usage.available}); if (count) { await this._point(this.tree.usage._card); await this._wheel(); check('one-provider-no-move', this.tree.usage._index() === 0 && !this.tree.usage._dots.visible); } await this._capture(`availability-${count}`); }
        phase = 'peek-alert'; await this._tree(3); const {island, expanded, context} = this.tree; expanded.hide(); context._presentation = 'peek'; context._expandWanted = false; context._alert = {key: 'synthetic'}; const peek = new St.Widget({reactive: true, width: 300, height: 80, style_class: 'isle-expanded'}); island.addView(peek); island.morph({width: 300, height: 80, radius: 24, shoulder: 0}, peek); await this._ready(peek); await this._point(peek); await this._smooth(2); check('peek-smooth-once', context.actions === 1, {actions: context.actions}); await wait(220); await this._wheel(); check('peek-native-wheel', context.actions === 2, {actions: context.actions}); context.actions = 0; context._swipe = null; await this._wheel(); await this._wheel(); check('peek-wheel-pairs-once', context.actions === 2, {actions: context.actions});
        this._finish();
    }
    _finish() {
        const assertions = records.filter(record => 'assert' in record).length;
        const passed = assertions === 88 && failures.length === 0 && !records.some(record => 'fatal' in record);
        log({summary: {failures, assertions}});
        GLib.file_set_contents(`${ROOT}/${run}-events.json`, JSON.stringify(records, null, 2));
        GLib.file_set_contents(`${ROOT}/result`, passed ? 'PASS\n' : 'FAIL\n');
        GLib.timeout_add(GLib.PRIORITY_DEFAULT, 200, () => { global.context.terminate(); return GLib.SOURCE_REMOVE; });
    }
}
