// SPDX-License-Identifier: GPL-3.0-or-later
// Copyright (C) 2026 zickrian

// Synced lyrics in LRC, the de-facto format: a line to a time. The same reading as isled's (isle-core's lrc.rs), for
// the lyrics Isle looks up itself (see lyricsEngine.js).

/** Parses `mm:ss`, `mm:ss.xx` or `mm:ss.xxx` into milliseconds; null if it is not one, negative or too big. */
function parseTimestamp(tag) {
    const colon = tag.indexOf(':');
    if (colon < 0)
        return null;
    const minutesText = tag.slice(0, colon);
    const seconds = tag.slice(colon + 1);
    if (!/^[+-]?\d+$/.test(minutesText))
        return null;
    const minutes = Number(minutesText);
    // "ss", "ss.xx" or "ss:xx": the first '.' or ':' splits the fraction off.
    const split = seconds.search(/[.:]/);
    const wholeText = split < 0 ? seconds : seconds.slice(0, split);
    const fraction = split < 0 ? '' : seconds.slice(split + 1);
    if (!/^[+-]?\d+$/.test(wholeText))
        return null;
    const whole = Number(wholeText);
    if (minutes < 0 || whole < 0 || whole >= 60 || !/^\d*$/.test(fraction))
        return null;
    // ".5", ".50" and ".500" all scale to 500 ms.
    let fractionMs;
    switch (fraction.length) {
    case 0: fractionMs = 0; break;
    case 1: fractionMs = Number(fraction) * 100; break;
    case 2: fractionMs = Number(fraction) * 10; break;
    default: fractionMs = Number(fraction.slice(0, 3));
    }
    const total = minutes * 60000 + whole * 1000 + fractionMs;
    return Number.isSafeInteger(total) ? total : null;
}

/** Parses synced lyrics into [{time_ms, text}] sorted by time. Lines without a timestamp, metadata tags and timestamps
 * too large to be real are skipped. */
export function parse(source) {
    let offset = 0;
    const lines = [];
    for (const raw of String(source ?? '').split(/\r?\n/)) {
        let rest = raw.trim();
        const times = [];
        while (rest.startsWith('[')) {
            const end = rest.indexOf(']');
            if (end < 0)
                break;
            const tag = rest.slice(1, end);
            const time = parseTimestamp(tag);
            if (time !== null) {
                times.push(time);
            } else if (tag.startsWith('offset:')) {
                // A positive offset makes lyrics appear sooner.
                const value = parseInt(tag.slice('offset:'.length).trim(), 10);
                offset = Number.isFinite(value) ? value : 0;
            }
            rest = rest.slice(end + 1).trimStart();
        }
        const text = rest.trim();
        for (const time of times)
            lines.push({time_ms: Math.max(0, time - offset), text});
    }
    // Stable, like Rust's sort_by_key.
    return lines.map((line, index) => [line, index])
        .sort(([a, i], [b, j]) => a.time_ms - b.time_ms || i - j)
        .map(([line]) => line);
}

/** Splits unsynced lyrics into lines with `time_ms` -1 (no empty line after a last line break, as Rust's `lines`). */
export function plain(source) {
    const lines = String(source ?? '').split(/\r?\n/);
    if (lines.at(-1) === '')
        lines.pop();
    return lines.map(line => ({time_ms: -1, text: line.trim()}));
}
