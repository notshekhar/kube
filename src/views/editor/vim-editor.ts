import chalk from "chalk";
import { matchesKey, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { editorUi, syntax } from "./theme.ts";
import { errorText, pad } from "./util.ts";
import { firstNonBlank, type Pos, TextBuffer } from "./buffer.ts";
import { resolveMotion } from "./motions.ts";
import { type Filetype, highlightLine, type StyleFn } from "./highlight.ts";

const TAB = 4;

export interface VimOptions {
    number: boolean;
    relativenumber: boolean;
}

export interface VimEditorOpts {
    title: string;
    text: string;
    filetype: Filetype;
    options: VimOptions;
    /** Persist + apply the edited text. Returns a status message; may throw. */
    onSave: (text: string) => Promise<string> | string;
    /** Close the editor (the host restores the previous view). */
    onQuit: () => void;
    requestRender: () => void;
    onOptionsChange?: (opts: VimOptions) => void;
}

type Mode = "normal" | "insert" | "visual" | "vline" | "command";
type Operator = "d" | "c" | "y";

function posCmp(a: Pos, b: Pos): number {
    return a.row - b.row || a.col - b.col;
}

function escapeRe(s: string): string {
    return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * A modal (vim) text editor rendered inside the TUI. Mirrors ScrollView's shape
 * (handleInput/render) so the host can swap it into a view slot. Implements the
 * practical vim subset documented in the editor plan — not full vi parity.
 */
export class VimEditor {
    private buf: TextBuffer;
    private mode: Mode = "normal";
    private top = 0;
    private left = 0;

    private count = "";
    private operator: Operator | null = null;
    private pendingG = false;
    private visualAnchor: Pos | null = null;

    private cmdKind: ":" | "/" | null = null;
    private cmd = "";
    private lastSearch: { pattern: string; forward: boolean } | null = null;
    private message = "";

    private readonly title: string;
    private readonly filetype: Filetype;
    private readonly options: VimOptions;
    private readonly opts: VimEditorOpts;

    constructor(opts: VimEditorOpts) {
        this.opts = opts;
        this.title = opts.title;
        this.filetype = opts.filetype;
        this.options = { ...opts.options };
        this.buf = new TextBuffer(opts.text);
    }

    // ── input ────────────────────────────────────────────────────────────────
    /** pi-tui Component hook; nothing cached to clear. */
    invalidate(): void {}

    handleInput(data: string): boolean {
        if (data.startsWith("\x1b[<")) {
            this.handleMouse(data);
            return true;
        }
        switch (this.mode) {
            case "command":
                this.handleCommand(data);
                break;
            case "insert":
                this.handleInsert(data);
                break;
            default:
                this.handleNormalOrVisual(data);
                break;
        }
        return true;
    }

    private ctx() {
        return { top: this.top, height: this.bodyHeight() };
    }

    private bodyHeight(): number {
        return Math.max(1, (process.stdout.rows || 24) - 2);
    }

    // ── normal / visual ───────────────────────────────────────────────────────
    private handleNormalOrVisual(data: string): void {
        // Count prefix (0 only continues an existing count; alone it's a motion).
        if (/^[1-9]$/.test(data) || (this.count !== "" && data === "0")) {
            this.count += data;
            return;
        }

        if (this.pendingG) {
            this.pendingG = false;
            if (data === "g") {
                if (this.operator) {
                    this.applyOperatorMotion("gg");
                } else {
                    this.move("gg");
                }
            }
            return;
        }

        // Operator pending: a repeated operator is linewise; otherwise a motion.
        if (this.operator) {
            if (data === this.operator) {
                this.applyOperatorMotion(this.operator === "y" ? "yyLine" : "ddLine");
                return;
            }
            if (data === "g") {
                this.pendingG = true;
                return;
            }
            const id = this.motionId(data);
            if (id) {
                this.applyOperatorMotion(id);
            } else {
                this.clearPending();
            }
            return;
        }

        this.message = "";

        // Visual-mode operators act on the selection immediately.
        if (this.visualAnchor) {
            if (matchesKey(data, "escape")) {
                this.exitVisual();
                return;
            }
            if (data === "d" || data === "x") {
                this.applyVisualOperator("d");
                return;
            }
            if (data === "y") {
                this.applyVisualOperator("y");
                return;
            }
            if (data === "c") {
                this.applyVisualOperator("c");
                return;
            }
            if (data === "v") {
                if (this.mode === "vline") {
                    this.mode = "visual";
                } else {
                    this.exitVisual();
                }
                return;
            }
            if (data === "V") {
                this.mode = "vline";
                return;
            }
            // fall through: motions move the cursor and extend the selection.
        }

        const motion = this.motionId(data);
        if (motion) {
            this.move(motion);
            return;
        }

        this.handleCommandKey(data);
    }

    /** Map a key to a motion id usable both as a cursor move and an operator target. */
    private motionId(data: string): string | null {
        if (matchesKey(data, "h") || matchesKey(data, "left")) return "h";
        if (matchesKey(data, "j") || matchesKey(data, "down")) return "j";
        if (matchesKey(data, "k") || matchesKey(data, "up")) return "k";
        if (matchesKey(data, "l") || matchesKey(data, "right")) return "l";
        if (data === "w") return "w";
        if (data === "b") return "b";
        if (data === "e") return "e";
        if (data === "0" || matchesKey(data, "home")) return "0";
        if (data === "^") return "^";
        if (data === "$" || matchesKey(data, "end")) return "$";
        if (data === "G") return "G";
        if (data === "H") return "H";
        if (data === "M") return "M";
        if (data === "L") return "L";
        return null;
    }

    private handleCommandKey(data: string): void {
        switch (true) {
            case data === "i":
                this.enterInsert(true);
                break;
            case data === "I":
                this.buf.snapshot();
                this.buf.cursor.col = firstNonBlank(this.buf.line());
                this.mode = "insert";
                break;
            case data === "a":
                this.buf.snapshot();
                this.buf.cursor.col = Math.min(this.buf.cursor.col + 1, this.buf.line().length);
                this.mode = "insert";
                break;
            case data === "A":
                this.buf.snapshot();
                this.buf.cursor.col = this.buf.line().length;
                this.mode = "insert";
                break;
            case data === "o":
                this.buf.snapshot();
                this.openLine(true);
                this.mode = "insert";
                break;
            case data === "O":
                this.buf.snapshot();
                this.openLine(false);
                this.mode = "insert";
                break;
            case data === "x":
                this.buf.snapshot();
                this.buf.register = { text: this.buf.deleteCharUnderCursor(), linewise: false };
                this.buf.clamp(false);
                break;
            case data === "D":
                this.deleteToLineEnd(false);
                break;
            case data === "C":
                this.deleteToLineEnd(true);
                break;
            case data === "s":
                this.buf.snapshot();
                this.buf.register = { text: this.buf.deleteCharUnderCursor(), linewise: false };
                this.mode = "insert";
                break;
            case data === "d" || data === "c" || data === "y":
                this.operator = data as Operator;
                break;
            case data === "p":
                this.buf.snapshot();
                this.buf.paste(true);
                this.buf.clamp(false);
                break;
            case data === "P":
                this.buf.snapshot();
                this.buf.paste(false);
                this.buf.clamp(false);
                break;
            case data === "u":
                if (!this.buf.undo()) {
                    this.message = "already at oldest change";
                }
                break;
            case matchesKey(data, "ctrl+r"):
                if (!this.buf.redo()) {
                    this.message = "already at newest change";
                }
                break;
            case data === "v":
                this.mode = "visual";
                this.visualAnchor = { ...this.buf.cursor };
                break;
            case data === "V":
                this.mode = "vline";
                this.visualAnchor = { ...this.buf.cursor };
                break;
            case data === "g":
                this.pendingG = true;
                break;
            case data === "n":
                this.repeatSearch(true);
                break;
            case data === "N":
                this.repeatSearch(false);
                break;
            case data === ":":
                this.cmdKind = ":";
                this.cmd = "";
                this.mode = "command";
                break;
            case data === "/":
                this.cmdKind = "/";
                this.cmd = "";
                this.mode = "command";
                break;
            case matchesKey(data, "ctrl+d") || matchesKey(data, "ctrl+u") || matchesKey(data, "ctrl+f") || matchesKey(data, "ctrl+b") || matchesKey(data, "pageDown") || matchesKey(data, "pageUp"):
                this.scrollPage(data);
                break;
            case matchesKey(data, "escape"):
                this.clearPending();
                break;
        }
    }

    // ── cursor moves & operators ──────────────────────────────────────────────
    private move(id: string): void {
        const count = this.takeCount();
        const m = resolveMotion(this.buf.lines, this.buf.cursor, id, count, this.ctx());
        if (!m) {
            return;
        }
        if (id === "j" || id === "k") {
            const len = (this.buf.lines[m.row] ?? "").length;
            this.buf.cursor = { row: m.row, col: Math.min(this.buf.desiredCol, Math.max(0, len - 1)) };
        } else {
            this.buf.cursor = { row: m.row, col: m.col };
            this.buf.desiredCol = m.col;
        }
        this.buf.clamp(false);
    }

    private applyOperatorMotion(id: string): void {
        const op = this.operator!;
        const count = this.takeCount();
        const anchor = { ...this.buf.cursor };

        if (id === "ddLine" || id === "yyLine") {
            const lines = Math.max(1, count);
            this.applyLinewise(op, anchor.row, Math.min(anchor.row + lines - 1, this.buf.lineCount() - 1));
            this.clearPending();
            return;
        }

        const m = resolveMotion(this.buf.lines, anchor, id, count, this.ctx());
        this.clearPending();
        if (!m) {
            return;
        }
        if (m.linewise) {
            this.applyLinewise(op, anchor.row, m.row);
            return;
        }
        let start = anchor;
        let end: Pos = { row: m.row, col: m.col };
        if (posCmp(start, end) > 0) {
            [start, end] = [end, start];
        }
        const endPos: Pos = m.inclusive ? { row: end.row, col: end.col + 1 } : end;
        const text = this.sliceText(start, endPos);
        if (op === "y") {
            this.buf.register = { text, linewise: false };
            this.buf.cursor = { ...start };
            this.buf.clamp(false);
            return;
        }
        this.buf.snapshot();
        this.buf.deleteCharRange(start, endPos);
        this.buf.register = { text, linewise: false };
        this.buf.cursor = { ...start };
        if (op === "c") {
            this.mode = "insert";
        } else {
            this.buf.clamp(false);
        }
    }

    private applyLinewise(op: Operator, r1: number, r2: number): void {
        const lo = Math.max(0, Math.min(r1, r2));
        const hi = Math.min(this.buf.lineCount() - 1, Math.max(r1, r2));
        const text = this.buf.lines.slice(lo, hi + 1).join("\n");
        if (op === "y") {
            this.buf.register = { text, linewise: true };
            this.buf.cursor = { row: lo, col: this.buf.cursor.col };
            this.buf.clamp(false);
            return;
        }
        this.buf.snapshot();
        this.buf.register = { text, linewise: true };
        this.buf.deleteLineRange(lo, hi);
        if (op === "c") {
            this.buf.lines.splice(lo, 0, "");
            this.buf.cursor = { row: lo, col: 0 };
            this.mode = "insert";
            return;
        }
        this.buf.cursor = { row: Math.min(lo, this.buf.lineCount() - 1), col: 0 };
        this.buf.cursor.col = firstNonBlank(this.buf.line());
        this.buf.clamp(false);
    }

    private applyVisualOperator(op: Operator): void {
        const anchor = this.visualAnchor!;
        const cur = { ...this.buf.cursor };
        if (this.mode === "vline") {
            this.visualAnchor = null;
            this.applyLinewise(op, anchor.row, cur.row);
            if (op !== "c") {
                this.mode = "normal";
            }
            return;
        }
        let start = anchor;
        let end = cur;
        if (posCmp(start, end) > 0) {
            [start, end] = [end, start];
        }
        const endPos: Pos = { row: end.row, col: end.col + 1 };
        const text = this.sliceText(start, endPos);
        this.visualAnchor = null;
        if (op === "y") {
            this.buf.register = { text, linewise: false };
            this.buf.cursor = { ...start };
            this.buf.clamp(false);
            this.mode = "normal";
            return;
        }
        this.buf.snapshot();
        this.buf.deleteCharRange(start, endPos);
        this.buf.register = { text, linewise: false };
        this.buf.cursor = { ...start };
        if (op === "c") {
            this.mode = "insert";
        } else {
            this.buf.clamp(false);
            this.mode = "normal";
        }
    }

    private sliceText(start: Pos, end: Pos): string {
        if (start.row === end.row) {
            return (this.buf.lines[start.row] ?? "").slice(start.col, end.col);
        }
        const parts: string[] = [(this.buf.lines[start.row] ?? "").slice(start.col)];
        for (let r = start.row + 1; r < end.row; r++) {
            parts.push(this.buf.lines[r] ?? "");
        }
        parts.push((this.buf.lines[end.row] ?? "").slice(0, end.col));
        return parts.join("\n");
    }

    private deleteToLineEnd(thenInsert: boolean): void {
        this.buf.snapshot();
        const line = this.buf.line();
        const start = { ...this.buf.cursor };
        const removed = line.slice(start.col);
        this.buf.deleteCharRange(start, { row: start.row, col: line.length });
        this.buf.register = { text: removed, linewise: false };
        if (thenInsert) {
            this.mode = "insert";
        } else {
            this.buf.clamp(false);
        }
    }

    private openLine(below: boolean): void {
        const row = this.buf.cursor.row + (below ? 1 : 0);
        this.buf.lines.splice(row, 0, "");
        this.buf.cursor = { row, col: 0 };
        this.buf.modified = true;
    }

    private enterInsert(snapshot: boolean): void {
        if (snapshot) {
            this.buf.snapshot();
        }
        this.mode = "insert";
    }

    private takeCount(): number {
        const n = this.count ? parseInt(this.count, 10) : 0;
        this.count = "";
        return n;
    }

    private clearPending(): void {
        this.operator = null;
        this.count = "";
        this.pendingG = false;
    }

    private exitVisual(): void {
        this.visualAnchor = null;
        this.mode = "normal";
    }

    // ── insert mode ────────────────────────────────────────────────────────────
    private handleInsert(data: string): void {
        if (matchesKey(data, "escape")) {
            this.mode = "normal";
            this.buf.cursor.col = Math.max(0, this.buf.cursor.col - 1);
            this.buf.clamp(false);
            this.buf.desiredCol = this.buf.cursor.col;
            return;
        }
        if (matchesKey(data, "enter")) {
            this.buf.newline();
            return;
        }
        if (matchesKey(data, "backspace")) {
            this.buf.backspace();
            return;
        }
        if (matchesKey(data, "tab")) {
            this.buf.insertText("  ");
            return;
        }
        if (matchesKey(data, "left")) {
            this.buf.cursor.col = Math.max(0, this.buf.cursor.col - 1);
            return;
        }
        if (matchesKey(data, "right")) {
            this.buf.cursor.col = Math.min(this.buf.line().length, this.buf.cursor.col + 1);
            return;
        }
        if (matchesKey(data, "up")) {
            this.buf.cursor.row = Math.max(0, this.buf.cursor.row - 1);
            this.buf.clamp(true);
            return;
        }
        if (matchesKey(data, "down")) {
            this.buf.cursor.row = Math.min(this.buf.lineCount() - 1, this.buf.cursor.row + 1);
            this.buf.clamp(true);
            return;
        }
        const text = printable(data);
        if (text !== null) {
            this.buf.insertText(text);
        }
    }

    // ── command line ( : and / ) ───────────────────────────────────────────────
    private handleCommand(data: string): void {
        if (matchesKey(data, "escape")) {
            this.exitCommand();
            return;
        }
        if (matchesKey(data, "enter")) {
            const kind = this.cmdKind;
            const cmd = this.cmd;
            this.exitCommand();
            if (kind === "/") {
                this.runSearch(cmd);
            } else {
                this.runExCommand(cmd);
            }
            return;
        }
        if (matchesKey(data, "backspace")) {
            if (this.cmd.length === 0) {
                this.exitCommand();
            } else {
                this.cmd = this.cmd.slice(0, -1);
            }
            return;
        }
        const text = printable(data);
        if (text !== null) {
            this.cmd += text;
        }
    }

    private exitCommand(): void {
        this.cmdKind = null;
        this.cmd = "";
        this.mode = "normal";
    }

    private runSearch(pattern: string): void {
        if (!pattern) {
            return;
        }
        this.lastSearch = { pattern, forward: true };
        this.gotoSearch(pattern, true);
    }

    private repeatSearch(sameDirection: boolean): void {
        if (!this.lastSearch) {
            this.message = "no previous search";
            return;
        }
        const forward = sameDirection ? this.lastSearch.forward : !this.lastSearch.forward;
        this.gotoSearch(this.lastSearch.pattern, forward);
    }

    private gotoSearch(pattern: string, forward: boolean): void {
        let re: RegExp;
        try {
            re = new RegExp(pattern, "g");
        } catch {
            re = new RegExp(escapeRe(pattern), "g");
        }
        const matches: Pos[] = [];
        this.buf.lines.forEach((line, row) => {
            re.lastIndex = 0;
            for (const m of line.matchAll(re)) {
                matches.push({ row, col: m.index! });
            }
        });
        if (matches.length === 0) {
            this.message = `pattern not found: ${pattern}`;
            return;
        }
        const cur = this.buf.cursor;
        let target: Pos;
        if (forward) {
            target = matches.find((p) => posCmp(p, cur) > 0) ?? matches[0];
        } else {
            const earlier = matches.filter((p) => posCmp(p, cur) < 0);
            target = earlier.length ? earlier[earlier.length - 1] : matches[matches.length - 1];
        }
        this.buf.cursor = { ...target };
        this.buf.desiredCol = target.col;
        this.buf.clamp(false);
    }

    private runExCommand(raw: string): void {
        const cmd = raw.trim();
        if (/^\d+$/.test(cmd)) {
            this.buf.cursor = { row: Math.min(parseInt(cmd, 10) - 1, this.buf.lineCount() - 1), col: 0 };
            this.buf.cursor.col = firstNonBlank(this.buf.line());
            this.buf.clamp(false);
            return;
        }
        if (cmd.startsWith("set ") || cmd.startsWith("se ")) {
            this.runSet(cmd.slice(cmd.indexOf(" ") + 1).trim());
            return;
        }
        switch (cmd) {
            case "w":
            case "w!":
                this.save(false);
                break;
            case "wq":
            case "wq!":
            case "x":
                this.save(true);
                break;
            case "q":
                if (this.buf.modified) {
                    this.message = "unsaved changes (:q! to discard, :wq to save)";
                } else {
                    this.opts.onQuit();
                }
                break;
            case "q!":
                this.opts.onQuit();
                break;
            default:
                this.message = `not an editor command: ${cmd}`;
        }
    }

    private runSet(opt: string): void {
        switch (opt) {
            case "number":
            case "nu":
                this.options.number = true;
                break;
            case "nonumber":
            case "nonu":
                this.options.number = false;
                break;
            case "relativenumber":
            case "rnu":
                this.options.relativenumber = true;
                break;
            case "norelativenumber":
            case "nornu":
                this.options.relativenumber = false;
                break;
            default:
                this.message = `unknown option: ${opt}`;
                return;
        }
        this.opts.onOptionsChange?.({ ...this.options });
    }

    private save(quitAfter: boolean): void {
        this.message = "saving…";
        this.opts.requestRender();
        Promise.resolve(this.opts.onSave(this.buf.text()))
            .then((status) => {
                this.buf.modified = false;
                this.message = status || "saved";
                if (quitAfter) {
                    this.opts.onQuit();
                } else {
                    this.opts.requestRender();
                }
            })
            .catch((err) => {
                this.message = errorText(err);
                this.opts.requestRender();
            });
    }

    // ── mouse ──────────────────────────────────────────────────────────────────
    private handleMouse(data: string): void {
        const match = /^\x1b\[<(\d+);(\d+);(\d+)([Mm])$/.exec(data);
        if (!match) {
            return;
        }
        const button = Number(match[1]);
        const col = Number(match[2]);
        const row = Number(match[3]);
        const release = match[4] === "m";
        if (button === 64) {
            this.top = Math.max(0, this.top - 3);
            return;
        }
        if (button === 65) {
            this.top = Math.min(Math.max(0, this.buf.lineCount() - 1), this.top + 3);
            return;
        }
        if (button === 0 && !release) {
            // Click positions the cursor: row 1 is the title bar, so subtract 2.
            const bufRow = this.top + (row - 2);
            if (bufRow >= 0 && bufRow < this.buf.lineCount()) {
                const gutter = this.gutterWidth();
                const wanted = this.left + Math.max(0, col - 1 - gutter);
                this.buf.cursor = { row: bufRow, col: wanted };
                this.buf.desiredCol = wanted;
                this.buf.clamp(this.mode === "insert");
            }
        }
    }

    private scrollPage(data: string): void {
        const half = Math.floor(this.bodyHeight() / 2);
        const full = this.bodyHeight() - 1;
        let delta = 0;
        if (matchesKey(data, "ctrl+d")) delta = half;
        else if (matchesKey(data, "ctrl+u")) delta = -half;
        else if (matchesKey(data, "ctrl+f") || matchesKey(data, "pageDown")) delta = full;
        else if (matchesKey(data, "ctrl+b") || matchesKey(data, "pageUp")) delta = -full;
        this.buf.cursor.row = Math.min(this.buf.lineCount() - 1, Math.max(0, this.buf.cursor.row + delta));
        this.buf.clamp(false);
    }

    // ── rendering ──────────────────────────────────────────────────────────────
    render(width: number): string[] {
        const height = this.bodyHeight();
        this.scrollToCursor(height, width);
        const gutterW = this.gutterWidth();
        const textW = Math.max(1, width - gutterW);

        const out: string[] = [editorUi.title(pad(` ${this.title}`, width))];
        for (let i = 0; i < height; i++) {
            out.push(this.renderRow(this.top + i, gutterW, textW, width));
        }
        out.push(this.renderStatus(width));
        // pi-tui hard-crashes on any line wider than the terminal. Wide glyphs
        // (CJK, arrows, emoji) make exact column math fragile, so clamp here as
        // a final guard — the host (digg) also truncates, but markdown mounts
        // this editor directly with no outer net.
        return out.map((line) => truncateToWidth(line, width));
    }

    private renderRow(row: number, gutterW: number, textW: number, width: number): string {
        if (row >= this.buf.lineCount()) {
            return editorUi.tilde(pad("~", width));
        }
        return this.renderGutter(row, gutterW) + this.renderBody(row, textW);
    }

    private renderGutter(row: number, gutterW: number): string {
        if (gutterW === 0) {
            return "";
        }
        const numW = gutterW - 1;
        const isCur = row === this.buf.cursor.row;
        let label: string;
        let cell: string;
        if (isCur) {
            label = String(row + 1);
            cell = this.options.relativenumber ? label.padEnd(numW) : label.padStart(numW);
        } else if (this.options.relativenumber) {
            label = String(Math.abs(row - this.buf.cursor.row));
            cell = label.padStart(numW);
        } else {
            label = String(row + 1);
            cell = label.padStart(numW);
        }
        const color = isCur ? editorUi.gutterCurrent : editorUi.gutter;
        return color(cell) + " ";
    }

    private renderBody(row: number, textW: number): string {
        const line = this.buf.lines[row] ?? "";
        const styles = highlightLine(line, this.filetype);
        const cells = buildCells(line, styles);
        const cursorOnRow = row === this.buf.cursor.row && this.mode !== "command";
        const cursorDisp = this.displayCol(row, this.buf.cursor.col);
        const sel = this.selectionRange(row);

        // Walk cells by display column so wide glyphs (width 2) advance correctly
        // and the visible width never exceeds textW.
        let s = "";
        let used = 0;
        let col = 0;
        for (const cell of cells) {
            const start = col;
            col += cell.w;
            if (start < this.left) {
                continue;
            }
            if (used + cell.w > textW) {
                break;
            }
            if (cursorOnRow && start === cursorDisp) {
                s += chalk.inverse(cell.ch);
            } else if (sel && start >= sel.start && start <= sel.end) {
                s += chalk.bgBlue(cell.style(cell.ch));
            } else {
                s += cell.style(cell.ch);
            }
            used += cell.w;
        }
        // Cursor sitting just past the last cell (insert at end of line).
        if (cursorOnRow && cursorDisp >= col && cursorDisp >= this.left && used < textW) {
            s += chalk.inverse(" ");
            used += 1;
        }
        return pad(s, textW);
    }

    /** Display-column span [start, end] selected on `row`, or null. */
    private selectionRange(row: number): { start: number; end: number } | null {
        if (!this.visualAnchor) {
            return null;
        }
        const a = this.visualAnchor;
        const c = this.buf.cursor;
        const lo = posCmp(a, c) <= 0 ? a : c;
        const hi = posCmp(a, c) <= 0 ? c : a;
        if (this.mode === "vline") {
            if (row < lo.row || row > hi.row) {
                return null;
            }
            return { start: 0, end: Number.MAX_SAFE_INTEGER };
        }
        if (row < lo.row || row > hi.row) {
            return null;
        }
        const startCol = row === lo.row ? this.displayCol(row, lo.col) : 0;
        const endCol = row === hi.row ? this.displayCol(row, hi.col) : Number.MAX_SAFE_INTEGER;
        return { start: startCol, end: endCol };
    }

    private renderStatus(width: number): string {
        if (this.cmdKind) {
            return editorUi.status(pad(this.cmdKind + this.cmd, width));
        }
        const mode = this.modeLabel();
        const left = mode + (this.message ? `${mode ? "  " : ""}${this.message}` : "");
        const pos = `${this.buf.cursor.row + 1},${this.buf.cursor.col + 1}`;
        const right = `${this.filetype}  ${pos}${this.buf.modified ? "  [+]" : ""}`;
        const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
        return editorUi.status(left + " ".repeat(gap) + right);
    }

    private modeLabel(): string {
        switch (this.mode) {
            case "insert":
                return "-- INSERT --";
            case "visual":
                return "-- VISUAL --";
            case "vline":
                return "-- VISUAL LINE --";
            default:
                return "";
        }
    }

    private gutterWidth(): number {
        if (!this.options.number) {
            return 0;
        }
        return String(this.buf.lineCount()).length + 1;
    }

    private displayCol(row: number, col: number): number {
        const line = this.buf.lines[row] ?? "";
        let d = 0;
        for (let c = 0; c < col && c < line.length; c++) {
            d += line[c] === "\t" ? TAB - (d % TAB) : charWidth(line[c]);
        }
        return d;
    }

    private scrollToCursor(height: number, width: number): void {
        const lastRow = Math.max(0, this.buf.lineCount() - 1);
        if (this.buf.cursor.row < this.top) {
            this.top = this.buf.cursor.row;
        }
        if (this.buf.cursor.row >= this.top + height) {
            this.top = this.buf.cursor.row - height + 1;
        }
        this.top = Math.min(Math.max(0, this.top), lastRow);

        const textW = Math.max(1, width - this.gutterWidth());
        const cdc = this.displayCol(this.buf.cursor.row, this.buf.cursor.col);
        if (cdc < this.left) {
            this.left = cdc;
        }
        if (cdc >= this.left + textW) {
            this.left = cdc - textW + 1;
        }
        this.left = Math.max(0, this.left);
    }
}

interface Cell {
    ch: string;
    style: StyleFn;
    /** Display width: 1, or 2 for wide glyphs; tab expands to a run of 1-wide spaces. */
    w: number;
}

/** Display width of a single character (1, or 2 for wide glyphs). */
function charWidth(ch: string): number {
    return Math.max(1, visibleWidth(ch));
}

/** Expand tabs and pair each display cell with its syntax style + width. */
function buildCells(line: string, styles: StyleFn[]): Cell[] {
    const cells: Cell[] = [];
    let dispCol = 0;
    for (let c = 0; c < line.length; c++) {
        const style = styles[c] ?? syntax.plain;
        if (line[c] === "\t") {
            const width = TAB - (dispCol % TAB);
            for (let i = 0; i < width; i++) {
                cells.push({ ch: " ", style, w: 1 });
            }
            dispCol += width;
        } else {
            const w = charWidth(line[c]);
            cells.push({ ch: line[c], style, w });
            dispCol += w;
        }
    }
    return cells;
}

/** Return insertable text for a key event, or null for non-text keys. */
function printable(data: string): string | null {
    if (data.length === 0 || data.startsWith("\x1b")) {
        return null;
    }
    const ok = [...data].every((ch) => ch === "\n" || ch === "\t" || ch >= " ");
    return ok ? data : null;
}
