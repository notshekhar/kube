// Vim motion resolver. Given the buffer lines, a starting position, a motion
// id and a count, it returns the target position plus how an operator should
// treat the span (linewise vs charwise, and whether the target char is
// included). VimEditor uses the same result for plain cursor moves and for
// d/c/y + motion, so the two paths can't drift.

import { firstNonBlank, type Pos } from "./buffer.ts";

export interface Motion {
    row: number;
    col: number;
    /** Operate on whole lines (j/k/G/gg). */
    linewise: boolean;
    /** Charwise motions that include the target character (e, $). */
    inclusive: boolean;
}

export interface MotionCtx {
    /** First visible buffer row (for H/M/L). */
    top: number;
    /** Visible row count (for H/M/L). */
    height: number;
}

type CharClass = "word" | "punct" | "space";

function classOf(ch: string): CharClass {
    if (/\s/.test(ch)) {
        return "space";
    }
    if (/[A-Za-z0-9_]/.test(ch)) {
        return "word";
    }
    return "punct";
}

interface Token {
    row: number;
    start: number;
    /** Exclusive end column. */
    end: number;
}

/** Split the buffer into word tokens. An empty line is its own stop, matching vim. */
function tokenize(lines: string[]): Token[] {
    const toks: Token[] = [];
    for (let row = 0; row < lines.length; row++) {
        const line = lines[row];
        if (line.length === 0) {
            toks.push({ row, start: 0, end: 0 });
            continue;
        }
        let i = 0;
        while (i < line.length) {
            if (classOf(line[i]) === "space") {
                i++;
                continue;
            }
            const c0 = classOf(line[i]);
            let j = i;
            while (j < line.length && classOf(line[j]) === c0) {
                j++;
            }
            toks.push({ row, start: i, end: j });
            i = j;
        }
    }
    return toks;
}

function before(a: Pos, row: number, col: number): boolean {
    return row < a.row || (row === a.row && col < a.col);
}

function after(a: Pos, row: number, col: number): boolean {
    return row > a.row || (row === a.row && col > a.col);
}

function nextWord(lines: string[], from: Pos, count: number): Pos {
    const toks = tokenize(lines);
    let pos = from;
    for (let n = 0; n < count; n++) {
        const tok = toks.find((t) => after(pos, t.row, t.start));
        if (!tok) {
            const lastRow = lines.length - 1;
            return { row: lastRow, col: Math.max(0, lines[lastRow].length - 1) };
        }
        pos = { row: tok.row, col: tok.start };
    }
    return pos;
}

function prevWord(lines: string[], from: Pos, count: number): Pos {
    const toks = tokenize(lines);
    let pos = from;
    for (let n = 0; n < count; n++) {
        let found: Token | undefined;
        for (const t of toks) {
            if (before(pos, t.row, t.start)) {
                found = t;
            } else {
                break;
            }
        }
        if (!found) {
            return { row: 0, col: 0 };
        }
        pos = { row: found.row, col: found.start };
    }
    return pos;
}

function wordEnd(lines: string[], from: Pos, count: number): Pos {
    const toks = tokenize(lines);
    let pos = from;
    for (let n = 0; n < count; n++) {
        const endCol = (t: Token): number => Math.max(t.start, t.end - 1);
        const tok = toks.find((t) => after(pos, t.row, endCol(t)));
        if (!tok) {
            const lastRow = lines.length - 1;
            return { row: lastRow, col: Math.max(0, lines[lastRow].length - 1) };
        }
        pos = { row: tok.row, col: endCol(tok) };
    }
    return pos;
}

export function resolveMotion(lines: string[], from: Pos, id: string, count: number, ctx: MotionCtx): Motion | null {
    const n = Math.max(1, count);
    const lastRow = lines.length - 1;
    const charMove = (row: number, col: number, inclusive = false): Motion => ({ row, col, linewise: false, inclusive });
    const lineMove = (row: number): Motion => ({ row: Math.min(Math.max(0, row), lastRow), col: 0, linewise: true, inclusive: false });

    switch (id) {
        case "h":
            return charMove(from.row, Math.max(0, from.col - n));
        case "l":
            return charMove(from.row, Math.min((lines[from.row] ?? "").length, from.col + n));
        case "j":
            return lineMove(from.row + n);
        case "k":
            return lineMove(from.row - n);
        case "0":
            return charMove(from.row, 0);
        case "^":
            return charMove(from.row, firstNonBlank(lines[from.row] ?? ""));
        case "$": {
            const line = lines[from.row] ?? "";
            return charMove(from.row, Math.max(0, line.length - 1), true);
        }
        case "w":
            return { ...nextWord(lines, from, n), linewise: false, inclusive: false };
        case "b":
            return { ...prevWord(lines, from, n), linewise: false, inclusive: false };
        case "e":
            return { ...wordEnd(lines, from, n), linewise: false, inclusive: true };
        case "gg":
            return lineMove(count > 0 ? count - 1 : 0);
        case "G":
            return lineMove(count > 0 ? count - 1 : lastRow);
        case "H":
            return lineMove(ctx.top);
        case "M":
            return lineMove(ctx.top + Math.floor(ctx.height / 2));
        case "L":
            return lineMove(Math.min(lastRow, ctx.top + ctx.height - 1));
        default:
            return null;
    }
}
