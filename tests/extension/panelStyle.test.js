// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Isle's colour in the top bar's inline style beside other extensions': `node --experimental-default-type=module --test tests/extension/*.test.js`.

import assert from 'node:assert/strict';
import {test} from 'node:test';

import {normalized, restyle} from '../../gnome-extension/src/panelStyle.js';

const isle = ['background-color: transparent'];
const ownOf = (...texts) => text => texts.map(normalized).includes(text);

test('a style already showing Isle\'s colour is left as it is, however spelt or ordered', () => {
    const own = ownOf('background-color: transparent');
    for (const style of ['background-color: transparent;', 'background-color: transparent',
        ' background-color: transparent; border-radius: 0px 0px 0px 0px;',
        'border-radius: 0px 0px 0px 0px; background-color:transparent ;', 'BACKGROUND-COLOR: Transparent'])
        assert.equal(restyle(style, isle, own), style);
});

test('Isle adds its colour once, after another\'s, keeping the other\'s text as it is', () => {
    const own = ownOf('background-color: transparent');
    assert.equal(restyle(null, isle, own), 'background-color: transparent;');
    assert.equal(restyle('', isle, own), 'background-color: transparent;');
    assert.equal(restyle('border-radius: 0px 0px 0px 0px', isle, own),
        'border-radius: 0px 0px 0px 0px; background-color: transparent;');
    assert.equal(restyle('background-color: red;  border-radius:4px;', isle, own),
        'background-color: red;  border-radius:4px; background-color: transparent;');
});

test('a new colour takes the old one\'s place, and moves only when another\'s would win', () => {
    const own = ownOf('background-color: transparent', 'background-color: rgba(0, 0, 0, 0.5)');
    const half = ['background-color: rgba(0, 0, 0, 0.5)'];
    assert.equal(restyle(' background-color: transparent; border-radius: 0px 0px 0px 0px;', half, own),
        ' background-color: rgba(0, 0, 0, 0.5); border-radius: 0px 0px 0px 0px;');
    assert.equal(restyle('background-color: transparent; background-color: red;', half, own),
        'background-color: red; background-color: rgba(0, 0, 0, 0.5);');
    // Twice (as 1.5 could leave it): once again.
    assert.equal(restyle('background-color: transparent; color: red; background-color: transparent', half, own),
        'color: red; background-color: rgba(0, 0, 0, 0.5);');
});

test('taking Isle\'s colour out leaves the rest, or nothing', () => {
    const own = ownOf('background-color: transparent');
    assert.equal(restyle('background-color: transparent; border-radius: 0px 0px 0px 0px;', [], own),
        'border-radius: 0px 0px 0px 0px;');
    assert.equal(restyle('background-color: transparent', [], own), null);
    assert.equal(restyle('border-radius: 2px;', [], own), 'border-radius: 2px;');
    assert.equal(restyle(null, [], own), null);
});

test('a ; inside quotes or brackets ends no declaration', () => {
    const own = ownOf('background-color: transparent');
    assert.equal(restyle('background-image: url("a;b.png");', isle, own),
        'background-image: url("a;b.png"); background-color: transparent;');
});

// The top bar with Isle and Blur my Shell writing its style, each as it does in GNOME Shell.
function bar() {
    const panel = {style: null, writes: [], listeners: []};
    panel.set = (style, who) => {
        panel.style = style;
        panel.writes.push(who);
        panel.listeners.forEach(listener => listener(who));
    };
    return panel;
}

// TopBar in shell.js: `_syncColor` and `_onPanelStyle`.
function isleOn(panel, opacity = 0) {
    const own = new Set();
    let writing = false;
    const rule = () => opacity === null ? null
        : opacity <= 0 ? 'background-color: transparent'
            : opacity >= 100 ? 'background-color: #000000' : `background-color: rgba(0, 0, 0, ${opacity / 100})`;
    const wanted = () => {
        const text = rule();
        if (text)
            own.add(normalized(text));
        return restyle(panel.style, text ? [text] : [], t => own.has(t));
    };
    const sync = () => {
        const style = wanted();
        if (style === panel.style)
            return;
        writing = true;
        panel.set(style, 'isle');
        writing = false;
    };
    panel.listeners.push(() => {
        if (!writing && wanted() !== panel.style)
            sync();
    });
    sync();
    return {set opacity(value) {
        opacity = value;
        sync();
    }};
}

// Blur my Shell v76/v77, src/components/panel/panel_style.js `update_panel_border_radius`, as written.
function bms(panel, actors, radius) {
    const newRadiusStyle = radius === null ? null : `border-radius: ${radius}px ${radius}px ${radius}px ${radius}px;`;
    const others = (panel.style ?? '').replace(actors.radius_style ?? '', '').replace(/[\s;]+$/, '');
    actors.radius_style = newRadiusStyle;
    const target = [others, newRadiusStyle].filter(Boolean).join('; ') || null;
    if (panel.style === target)
        return;
    panel.set(target, 'bms');
}

const backgrounds = style => (style ?? '').split(';').filter(text => /background-color/.test(text)).length;

for (const [name, radius] of [['without rounding', null], ['with rounding', 0], ['with round corners', 12]]) {
    test(`Blur my Shell ${name} checking windows 50 times: one write each, then quiet`, () => {
        const panel = bar();
        isleOn(panel);
        const actors = {};
        for (let i = 0; i < 50; i++)
            bms(panel, actors, radius);
        assert.deepEqual(panel.writes, ['isle', 'bms']);
        assert.equal(backgrounds(panel.style), 1);
        assert.match(panel.style, /background-color: transparent/);
    });
}

test('rounding on and off, and new colours: at most one write each per change, nothing piling up', () => {
    const panel = bar();
    const topBar = isleOn(panel);
    const actors = {};
    const steps = [[null, 0], [0, 0], [8, 0], [8, 50], [null, 50], [null, 100], [12, 100], [12, 0], [null, 0]];
    for (const [radius, opacity] of steps) {
        const before = panel.writes.length;
        topBar.opacity = opacity;
        for (let i = 0; i < 10; i++)
            bms(panel, actors, radius);
        assert.ok(panel.writes.length - before <= 2, `${radius}/${opacity}: ${panel.writes.slice(before)}`);
        assert.equal(panel.writes.slice(before).filter(who => who === 'isle').length <= 1, true);
        assert.equal(backgrounds(panel.style), 1);
        assert.equal((panel.style.match(/border-radius/g) ?? []).length, radius === null ? 0 : 1);
        const colour = opacity === 0 ? 'transparent' : opacity === 100 ? '#000000' : `rgba(0, 0, 0, ${opacity / 100})`;
        assert.ok(panel.style.includes(`background-color: ${colour}`), panel.style);
    }
});

test('Isle stopping takes out its colour only; Blur my Shell\'s corners stay', () => {
    const panel = bar();
    const topBar = isleOn(panel, 50);
    const actors = {};
    bms(panel, actors, 8);
    topBar.opacity = null;
    assert.equal(panel.style, 'border-radius: 8px 8px 8px 8px;');
    bms(panel, actors, null);
    assert.equal(panel.style, null);
});

test('an extension replacing the whole style gets Isle\'s colour after its own, once', () => {
    const panel = bar();
    isleOn(panel);
    panel.set('background-color: rgba(20, 20, 20, 0.8); height: 40px', 'other');
    assert.equal(panel.style, 'background-color: rgba(20, 20, 20, 0.8); height: 40px; background-color: transparent;');
    assert.deepEqual(panel.writes, ['isle', 'other', 'isle']);
});
