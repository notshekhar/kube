// Self-contained palette for the editor so the whole `editor/` folder can be
// copied between projects without pulling in a host theme.

import chalk from "chalk";

export type StyleFn = (text: string) => string;

/** Syntax-highlight palette (highlight.ts). */
export const syntax = {
    key: chalk.cyan,
    str: chalk.green,
    num: chalk.yellow,
    bool: chalk.magenta,
    comment: chalk.gray,
    punct: chalk.gray,
    block: chalk.yellow,
    anchor: chalk.magenta,
    heading: chalk.bold.cyan,
    emphasis: chalk.italic,
    code: chalk.green,
    plain: (text: string) => text,
};

/** Editor chrome (title bar, gutter, status line). */
export const editorUi = {
    title: (text: string) => chalk.bgCyan.black.bold(text),
    gutter: (text: string) => chalk.gray(text),
    gutterCurrent: (text: string) => chalk.cyan(text),
    status: (text: string) => chalk.gray(text),
    tilde: (text: string) => chalk.dim.gray(text),
};
