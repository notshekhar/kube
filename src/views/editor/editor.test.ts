import { describe, expect, test } from "bun:test";
import { TextBuffer } from "./buffer.ts";
import { resolveMotion } from "./motions.ts";

const ctx = { top: 0, height: 10 };

describe("motions", () => {
    test("w jumps to the next word start", () => {
        const lines = ["foo bar baz"];
        const m = resolveMotion(lines, { row: 0, col: 0 }, "w", 0, ctx);
        expect(m).toMatchObject({ row: 0, col: 4 });
    });

    test("3w with count", () => {
        const lines = ["one two three four"];
        const m = resolveMotion(lines, { row: 0, col: 0 }, "w", 3, ctx);
        expect(m?.col).toBe(14); // "four"
    });

    test("e is inclusive of the word end", () => {
        const lines = ["foo bar"];
        const m = resolveMotion(lines, { row: 0, col: 0 }, "e", 0, ctx);
        expect(m).toMatchObject({ row: 0, col: 2, inclusive: true });
    });

    test("$ is inclusive of the last char", () => {
        const m = resolveMotion(["hello"], { row: 0, col: 0 }, "$", 0, ctx);
        expect(m).toMatchObject({ col: 4, inclusive: true });
    });

    test("j is linewise", () => {
        const m = resolveMotion(["a", "b", "c"], { row: 0, col: 0 }, "j", 0, ctx);
        expect(m).toMatchObject({ row: 1, linewise: true });
    });

    test("G goes to the given line", () => {
        const m = resolveMotion(["a", "b", "c", "d"], { row: 0, col: 0 }, "G", 2, ctx);
        expect(m?.row).toBe(1);
    });
});

describe("buffer edits", () => {
    test("delete char range removes text", () => {
        const buf = new TextBuffer("hello world");
        const removed = buf.deleteCharRange({ row: 0, col: 0 }, { row: 0, col: 6 });
        expect(removed).toBe("hello ");
        expect(buf.text()).toBe("world");
    });

    test("delete line range and linewise paste", () => {
        const buf = new TextBuffer("a\nb\nc");
        const removed = buf.deleteLineRange(0, 1);
        expect(removed).toBe("a\nb");
        expect(buf.text()).toBe("c");
        buf.register = { text: "a\nb", linewise: true };
        buf.cursor = { row: 0, col: 0 };
        buf.paste(true);
        expect(buf.text()).toBe("c\na\nb");
    });

    test("undo and redo restore state", () => {
        const buf = new TextBuffer("hello");
        buf.snapshot();
        buf.deleteCharRange({ row: 0, col: 0 }, { row: 0, col: 5 });
        expect(buf.text()).toBe("");
        expect(buf.undo()).toBe(true);
        expect(buf.text()).toBe("hello");
        expect(buf.redo()).toBe(true);
        expect(buf.text()).toBe("");
    });

    test("insert text with newline splits the line", () => {
        const buf = new TextBuffer("ab");
        buf.cursor = { row: 0, col: 1 };
        buf.insertText("X\nY");
        expect(buf.text()).toBe("aX\nYb");
        expect(buf.cursor).toEqual({ row: 1, col: 1 });
    });
});
