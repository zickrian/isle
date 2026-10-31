// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Effects that run a GLSL fragment snippet over what an actor paints, their uniforms set from JS: Shell's GLSL effect
// up to GNOME 50, Clutter's shader effect from 51.

import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GObject from 'gi://GObject';
import Shell from 'gi://Shell';

// GNOME 46 and 47 name their snippet hooks themselves; later ones use Cogl's.
const FRAGMENT = Shell.SnippetHook?.FRAGMENT ?? Cogl.SnippetHook.FRAGMENT;

/** GLSL for where the pixel drawn is on an actor `size` big at whole pixels, in its units: the effect's texture is 3
 * pixels larger than the actor, 2 of them before it (Clutter's `_clutter_actor_box_enlarge_for_effects`). */
export const effectPoint = size => `(cogl_tex_coord_in[0].xy * (${size} + 3.0) - 2.0)`;

/** Sets the uniforms in `values` ({name: a number, or an array for a vec}) that changed; redraws if any did. */
function setUniforms(effect, values) {
    let changed = false;
    for (const [name, value] of Object.entries(values)) {
        const list = typeof value === 'number' ? [value] : value;
        const old = effect._values[name];
        if (old && old.length === list.length && old.every((each, i) => each === list[i]))
            continue;
        effect._values[name] = [...list];
        effect.set_uniform_float(effect._locations?.[name] ?? name, list.length, list);
        changed = true;
    }
    if (changed)
        effect.queue_repaint();
}

/** A class of effect named `name` running `code` per pixel, with `uniforms` ({name: 1 to 4 floats}) and `functions`
 * declared before it. Its `setUniforms` takes the values that may have changed. */
export function shaderEffect(name, uniforms, code, functions = '') {
    const types = Object.entries(uniforms).map(([uniform, size]) => `uniform ${size === 1 ? 'float' : `vec${size}`} ${uniform};`);
    const declarations = `${types.join('\n')}\n${functions}`;
    const GTypeName = `IsleShader${name}`;
    if (Shell.GLSLEffect) {
        return GObject.registerClass({GTypeName}, class extends Shell.GLSLEffect {
            _init() {
                super._init();
                this._values = {};
                this._locations = Object.fromEntries(Object.keys(uniforms).map(uniform => [uniform, this.get_uniform_location(uniform)]));
            }

            vfunc_build_pipeline() {
                this.add_glsl_snippet(FRAGMENT, declarations, code, false);
            }

            setUniforms(values) {
                setUniforms(this, values);
            }
        });
    }
    return GObject.registerClass({GTypeName}, class extends Clutter.ShaderEffect {
        _init() {
            super._init();
            this._values = {};
        }

        vfunc_get_static_snippet() {
            return Cogl.Snippet.new(Cogl.SnippetHook.FRAGMENT, declarations, code);
        }

        setUniforms(values) {
            setUniforms(this, values);
        }
    });
}
