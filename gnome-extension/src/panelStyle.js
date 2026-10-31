// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Isle's declarations in the top bar's inline style, needing nothing of GNOME, kept apart so tests run it
// anywhere (tests/). Other extensions write that style too: only Isle's own declarations are ever touched.

/** The declarations of `style`: each one's text without its `;`, and where it starts and ends (`;` and the
 * spaces after it included). A `;` inside quotes or brackets doesn't end one. */
function declarations(style) {
    const found = [];
    let start = 0, quote = null, depth = 0;
    const close = end => {
        const raw = style.slice(start, end);
        const text = raw.trim();
        let to = end < style.length ? end + 1 : end;
        while (to < style.length && /\s/.test(style[to]))
            to++;
        if (text)
            found.push({text, from: start + raw.length - raw.trimStart().length, to});
        start = to;
    };
    for (let i = 0; i < style.length; i++) {
        const char = style[i];
        if (quote)
            quote = char === quote ? null : quote;
        else if (char === '"' || char === '\'')
            quote = char;
        else if (char === '(')
            depth++;
        else if (char === ')')
            depth = Math.max(0, depth - 1);
        else if (char === ';' && depth === 0)
            close(i);
    }
    close(style.length);
    return found;
}

/** A declaration in one spelling, to compare: lower case, no spaces around `:`, `,` and brackets. */
export function normalized(text) {
    return text.trim().toLowerCase().replace(/\s+/g, ' ').replace(/ ?([:,()]) ?/g, '$1');
}

/** The property a declaration sets, lower case. */
function property(text) {
    return text.split(':', 1)[0].trim().toLowerCase();
}

/**
 * `style` with each of `wanted` in effect (the last of its property) and none of Isle's others left: the very
 * same string when it already is so, however the rest is spelt or ordered. `isOwn(normalized)` tells Isle's
 * declarations. Another's text is kept as it is; Isle's moves to the end only when another's would win.
 */
export function restyle(style, wanted, isOwn) {
    const current = style ?? '';
    const found = declarations(current);
    const wantedSpelt = wanted.map(normalized);
    const inEffect = text => normalized(found.findLast(({text: other}) => property(other) === property(text))?.text ?? '') ===
        normalized(text);
    const stale = found.some(({text}) => isOwn(normalized(text)) && !wantedSpelt.includes(normalized(text)));
    if (!stale && wanted.every(inEffect))
        return style;

    // Each wanted one takes the place of Isle's last of its property, if nothing of another's comes after it.
    const replacing = new Map();
    const appended = [];
    for (const text of wanted) {
        const last = found.findLastIndex(({text: other}) => property(other) === property(text));
        if (last >= 0 && isOwn(normalized(found[last].text)) && !replacing.has(last))
            replacing.set(last, text);
        else
            appended.push(text);
    }
    let result = current.slice(0, found[0]?.from ?? current.length);
    found.forEach(({text, from, to}, index) => {
        if (replacing.has(index))
            result += `${replacing.get(index)};${current.slice(from + text.length, to).replace(/^\s*;?/, '')}`;
        else if (!isOwn(normalized(text)))
            result += current.slice(from, to);
    });
    result = result.trimEnd();
    for (const text of appended)
        result = `${result}${result && !result.endsWith(';') ? ';' : ''}${result ? ' ' : ''}${text};`;
    return result || null;
}
