import { homedir } from "node:os";
import { join } from "node:path";
import Configstore from "configstore";

// Preferences persist under ~/.digg/settings.json (same configstore pattern as
// pi's ~/.pi). Per-context we remember the last namespace and resource kind so
// reopening a cluster lands you where you left off.

interface ContextPrefs {
    namespace?: string | null; // null → all namespaces
    kind?: string;
}

interface EditorOptions {
    number: boolean;
    relativenumber: boolean;
}

interface SettingsData {
    lastContext?: string;
    contexts: Record<string, ContextPrefs>;
    editor?: EditorOptions;
}

const DEFAULT_EDITOR: EditorOptions = { number: true, relativenumber: true };

const store = new Configstore(
    "digg",
    { contexts: {} } satisfies SettingsData,
    { configPath: join(homedir(), ".digg", "settings.json") },
);

export function getLastContext(): string | undefined {
    return store.get("lastContext");
}

export function setLastContext(context: string): void {
    store.set("lastContext", context);
}

export function getContextPrefs(context: string): ContextPrefs {
    const all = (store.get("contexts") as Record<string, ContextPrefs>) ?? {};
    return all[context] ?? {};
}

export function setContextPrefs(context: string, prefs: ContextPrefs): void {
    const all = (store.get("contexts") as Record<string, ContextPrefs>) ?? {};
    all[context] = { ...all[context], ...prefs };
    store.set("contexts", all);
}

export function getEditorOptions(): EditorOptions {
    return { ...DEFAULT_EDITOR, ...((store.get("editor") as EditorOptions | undefined) ?? {}) };
}

export function setEditorOptions(options: EditorOptions): void {
    store.set("editor", options);
}
