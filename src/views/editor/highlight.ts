// Lightweight, line-based syntax highlighting for the editor. Each highlighter
// returns one StyleFn per character of the line; VimEditor composes those with
// the cursor/selection styling at render time. This is deliberately heuristic
// (no full parser) — good enough for YAML/JSON/Markdown config editing.

import { type StyleFn, syntax } from "./theme.ts";

export type { StyleFn };
export type Filetype = "yaml" | "json" | "markdown" | "plaintext";

/** Fill styles[start..end) with `fn`. */
function paint(styles: StyleFn[], start: number, end: number, fn: StyleFn): void {
    for (let i = Math.max(0, start); i < Math.min(styles.length, end); i++) {
        styles[i] = fn;
    }
}

function applyMatches(line: string, styles: StyleFn[], re: RegExp, group: number, fn: StyleFn): void {
    for (const m of line.matchAll(re)) {
        const text = m[group];
        if (text === undefined) {
            continue;
        }
        const start = m.index! + m[0].indexOf(text);
        paint(styles, start, start + text.length, fn);
    }
}

function highlightYaml(line: string): StyleFn[] {
    const styles: StyleFn[] = new Array(line.length).fill(syntax.plain);

    // Whole-line comment or document marker.
    const commentAt = line.indexOf("#");
    const trimmed = line.trim();
    if (trimmed.startsWith("#")) {
        paint(styles, 0, line.length, syntax.comment);
        return styles;
    }
    if (trimmed === "---" || trimmed === "...") {
        paint(styles, 0, line.length, syntax.punct);
        return styles;
    }

    // `key:` (optionally under a `- ` list item).
    const key = /^(\s*-\s+)?([\w.\-/]+)(:)(\s|$)/.exec(line);
    if (key) {
        const keyStart = key[1] ? key[1].length : 0;
        paint(styles, keyStart, keyStart + key[2].length, syntax.key);
    }

    applyMatches(line, styles, /"(?:[^"\\]|\\.)*"|'(?:[^']|'')*'/g, 0, syntax.str);
    applyMatches(line, styles, /\b(true|false|null|yes|no|~)\b/gi, 1, syntax.bool);
    applyMatches(line, styles, /(?<![\w.])-?\d+(?:\.\d+)?\b/g, 0, syntax.num);
    applyMatches(line, styles, /[|>][+-]?\s*$/g, 0, syntax.block);
    applyMatches(line, styles, /[&*][\w.\-]+/g, 0, syntax.anchor);

    // Trailing inline comment (best-effort: a # that isn't inside the matched string spans).
    if (commentAt >= 0 && styles[commentAt] === syntax.plain && (commentAt === 0 || /\s/.test(line[commentAt - 1]))) {
        paint(styles, commentAt, line.length, syntax.comment);
    }
    return styles;
}

function highlightJson(line: string): StyleFn[] {
    const styles: StyleFn[] = new Array(line.length).fill(syntax.plain);
    // Keys: a string immediately followed by a colon.
    applyMatches(line, styles, /("(?:[^"\\]|\\.)*")\s*:/g, 1, syntax.key);
    // Remaining strings (values) — paint after keys so keys keep their color where overlapping doesn't occur.
    for (const m of line.matchAll(/"(?:[^"\\]|\\.)*"/g)) {
        const start = m.index!;
        if (styles[start] === syntax.plain) {
            paint(styles, start, start + m[0].length, syntax.str);
        }
    }
    applyMatches(line, styles, /(?<![\w"])-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b/g, 0, syntax.num);
    applyMatches(line, styles, /\b(true|false|null)\b/g, 1, syntax.bool);
    return styles;
}

function highlightMarkdown(line: string): StyleFn[] {
    const styles: StyleFn[] = new Array(line.length).fill(syntax.plain);
    if (/^\s*#{1,6}\s/.test(line)) {
        paint(styles, 0, line.length, syntax.heading);
        return styles;
    }
    if (/^\s*```/.test(line)) {
        paint(styles, 0, line.length, syntax.block);
        return styles;
    }
    applyMatches(line, styles, /^\s*([-*+]|\d+\.)\s/g, 1, syntax.punct);
    applyMatches(line, styles, /`[^`]+`/g, 0, syntax.code);
    applyMatches(line, styles, /\*\*[^*]+\*\*|__[^_]+__/g, 0, syntax.bool);
    applyMatches(line, styles, /\[[^\]]+\]\([^)]+\)/g, 0, syntax.str);
    return styles;
}

export function highlightLine(line: string, ft: Filetype): StyleFn[] {
    switch (ft) {
        case "yaml":
            return highlightYaml(line);
        case "json":
            return highlightJson(line);
        case "markdown":
            return highlightMarkdown(line);
        default:
            return new Array(line.length).fill(syntax.plain);
    }
}
