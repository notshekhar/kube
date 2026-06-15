// The text model behind the modal editor: a list of lines, a cursor, an
// unnamed register, and a snapshot-based undo/redo stack. It knows nothing
// about modes or rendering — VimEditor drives it.

export interface Pos {
    row: number;
    col: number;
}

export interface Register {
    text: string;
    linewise: boolean;
}

interface Snapshot {
    lines: string[];
    cursor: Pos;
}

const MAX_UNDO = 1000;

export class TextBuffer {
    lines: string[];
    cursor: Pos = { row: 0, col: 0 };
    /** Sticky column for vertical motion (j/k remember the widest column). */
    desiredCol = 0;
    register: Register = { text: "", linewise: false };
    modified = false;

    private undoStack: Snapshot[] = [];
    private redoStack: Snapshot[] = [];

    constructor(text: string) {
        this.lines = text.split("\n");
        if (this.lines.length === 0) {
            this.lines = [""];
        }
    }

    text(): string {
        return this.lines.join("\n");
    }

    line(row = this.cursor.row): string {
        return this.lines[row] ?? "";
    }

    lineCount(): number {
        return this.lines.length;
    }

    // ── undo / redo ──────────────────────────────────────────────────────────
    /** Capture the pre-mutation state. Call BEFORE a mutating command. */
    snapshot(): void {
        this.undoStack.push({ lines: [...this.lines], cursor: { ...this.cursor } });
        if (this.undoStack.length > MAX_UNDO) {
            this.undoStack.shift();
        }
        this.redoStack = [];
    }

    undo(): boolean {
        const snap = this.undoStack.pop();
        if (!snap) {
            return false;
        }
        this.redoStack.push({ lines: [...this.lines], cursor: { ...this.cursor } });
        this.lines = snap.lines;
        this.cursor = snap.cursor;
        this.clamp(false);
        return true;
    }

    redo(): boolean {
        const snap = this.redoStack.pop();
        if (!snap) {
            return false;
        }
        this.undoStack.push({ lines: [...this.lines], cursor: { ...this.cursor } });
        this.lines = snap.lines;
        this.cursor = snap.cursor;
        this.clamp(false);
        return true;
    }

    // ── cursor ───────────────────────────────────────────────────────────────
    /** Clamp the cursor into range. `allowEnd` permits col === line.length (insert). */
    clamp(allowEnd: boolean): void {
        this.cursor.row = Math.min(Math.max(0, this.cursor.row), this.lines.length - 1);
        const len = this.line().length;
        const max = allowEnd ? len : Math.max(0, len - 1);
        this.cursor.col = Math.min(Math.max(0, this.cursor.col), max);
    }

    // ── low-level mutators (used by VimEditor + operators) ────────────────────
    /** Insert `str` (may contain newlines) at `pos`; returns the end position. */
    insertTextAt(pos: Pos, str: string): Pos {
        this.modified = true;
        const cur = this.lines[pos.row] ?? "";
        const parts = str.split("\n");
        if (parts.length === 1) {
            this.lines[pos.row] = cur.slice(0, pos.col) + str + cur.slice(pos.col);
            return { row: pos.row, col: pos.col + str.length };
        }
        const before = cur.slice(0, pos.col);
        const after = cur.slice(pos.col);
        const block = [...parts];
        block[0] = before + block[0];
        const last = block.length - 1;
        const endCol = block[last].length;
        block[last] = block[last] + after;
        this.lines.splice(pos.row, 1, ...block);
        return { row: pos.row + last, col: endCol };
    }

    /** Delete the charwise range [start, end) (end exclusive); returns removed text. */
    deleteCharRange(start: Pos, end: Pos): string {
        this.modified = true;
        if (start.row === end.row) {
            const line = this.lines[start.row] ?? "";
            const removed = line.slice(start.col, end.col);
            this.lines[start.row] = line.slice(0, start.col) + line.slice(end.col);
            return removed;
        }
        const first = this.lines[start.row] ?? "";
        const last = this.lines[end.row] ?? "";
        const middle = this.lines.slice(start.row, end.row + 1).join("\n");
        const removed = middle.slice(start.col, middle.length - (last.length - end.col));
        this.lines.splice(start.row, end.row - start.row + 1, first.slice(0, start.col) + last.slice(end.col));
        return removed;
    }

    /** Delete the inclusive line range [r1, r2]; returns the removed lines joined. */
    deleteLineRange(r1: number, r2: number): string {
        this.modified = true;
        const lo = Math.max(0, Math.min(r1, r2));
        const hi = Math.min(this.lines.length - 1, Math.max(r1, r2));
        const removed = this.lines.slice(lo, hi + 1).join("\n");
        this.lines.splice(lo, hi - lo + 1);
        if (this.lines.length === 0) {
            this.lines = [""];
        }
        return removed;
    }

    // ── insert-mode editing at the cursor ─────────────────────────────────────
    insertText(str: string): void {
        const normalized = str.replace(/\r\n?/g, "\n");
        this.cursor = this.insertTextAt(this.cursor, normalized);
    }

    newline(): void {
        this.modified = true;
        const line = this.line();
        const before = line.slice(0, this.cursor.col);
        const after = line.slice(this.cursor.col);
        this.lines.splice(this.cursor.row, 1, before, after);
        this.cursor = { row: this.cursor.row + 1, col: 0 };
    }

    backspace(): void {
        if (this.cursor.col > 0) {
            this.modified = true;
            const line = this.line();
            this.lines[this.cursor.row] = line.slice(0, this.cursor.col - 1) + line.slice(this.cursor.col);
            this.cursor.col -= 1;
        } else if (this.cursor.row > 0) {
            this.modified = true;
            const prev = this.lines[this.cursor.row - 1];
            const cur = this.lines[this.cursor.row];
            const joinCol = prev.length;
            this.lines.splice(this.cursor.row - 1, 2, prev + cur);
            this.cursor = { row: this.cursor.row - 1, col: joinCol };
        }
    }

    /** Delete the char under the cursor (x). */
    deleteCharUnderCursor(): string {
        const line = this.line();
        if (this.cursor.col >= line.length) {
            return "";
        }
        this.modified = true;
        const removed = line[this.cursor.col];
        this.lines[this.cursor.row] = line.slice(0, this.cursor.col) + line.slice(this.cursor.col + 1);
        return removed;
    }

    // ── paste (p / P) ─────────────────────────────────────────────────────────
    paste(after: boolean): void {
        const reg = this.register;
        if (!reg.text && !reg.linewise) {
            return;
        }
        this.modified = true;
        if (reg.linewise) {
            const newLines = reg.text.split("\n");
            const at = after ? this.cursor.row + 1 : this.cursor.row;
            this.lines.splice(at, 0, ...newLines);
            this.cursor = { row: at, col: firstNonBlank(newLines[0] ?? "") };
        } else {
            const at: Pos = after
                ? { row: this.cursor.row, col: Math.min(this.cursor.col + 1, this.line().length) }
                : { ...this.cursor };
            const end = this.insertTextAt(at, reg.text);
            // Vim leaves the cursor on the last pasted character.
            this.cursor = { row: end.row, col: Math.max(0, end.col - 1) };
        }
    }
}

/** Column of the first non-whitespace character, or 0 for a blank line. */
export function firstNonBlank(line: string): number {
    const m = /\S/.exec(line);
    return m ? m.index : 0;
}
