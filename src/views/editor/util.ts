import { visibleWidth } from "@earendil-works/pi-tui";

/** Pad a (possibly ANSI-styled) line with spaces to the given width. */
export function pad(text: string, width: number): string {
    return text + " ".repeat(Math.max(0, width - visibleWidth(text)));
}

/** Best-effort message from a thrown value. */
export function errorText(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
