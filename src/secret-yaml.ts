// Secret/ConfigMap-aware YAML transform for the in-app editor.
//
// Kubernetes stores Secret values as base64 and (for binary ConfigMap entries)
// under binaryData. Editing that raw is hostile: base64 is unreadable and a
// value containing a literal "\n" is trivially corrupted by YAML escaping. So
// on display we DECODE clean-text values into literal block scalars (real
// newlines, no escaping) and on save we re-ENCODE them to base64. Values that
// aren't clean UTF-8 text (binary, or containing CR/other control chars) stay
// as base64 and are left untouched — they bypass text editing entirely.

import YAML from "yaml";
import type { K8sObject, ResourceRef } from "./kubectl.ts";

export function isSecretOrConfigMap(obj: K8sObject): boolean {
    return obj.kind === "Secret" || obj.kind === "ConfigMap";
}

/** True for valid UTF-8 with no control chars except tab and newline. */
function asCleanText(bytes: Uint8Array): string | null {
    let text: string;
    try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    } catch {
        return null;
    }
    // Disallow control chars except \t (09) and \n (0a). CR (0d) included, so
    // CRLF values round-trip as base64 rather than losing their \r.
    if (/[\x00-\x08\x0b-\x1f]/.test(text)) {
        return null;
    }
    return text;
}

function decodeBase64(b64: string): Uint8Array {
    return new Uint8Array(Buffer.from(b64, "base64"));
}

function encodeBase64(text: string): string {
    return Buffer.from(text, "utf-8").toString("base64");
}

/** Drop server-managed fields that would only add noise or block `apply`. */
function stripServerFields(obj: K8sObject): void {
    delete obj.status;
    const meta = obj.metadata as Record<string, unknown> | undefined;
    if (meta) {
        for (const f of ["managedFields", "resourceVersion", "uid", "generation", "creationTimestamp", "selfLink"]) {
            delete meta[f];
        }
    }
}

/**
 * Build the editable YAML for a Secret/ConfigMap: clean-text values are decoded
 * into `stringData` (Secret) or left as plain `data` (ConfigMap); binary values
 * stay base64. Returns YAML text for the editor.
 */
export function toEditableYaml(input: K8sObject): string {
    const obj = JSON.parse(JSON.stringify(input)) as K8sObject;
    stripServerFields(obj);

    if (obj.kind === "Secret") {
        const data = (obj.data as Record<string, string> | null) ?? {};
        const binary: Record<string, string> = {};
        const stringData: Record<string, string> = { ...((obj.stringData as Record<string, string> | undefined) ?? {}) };
        for (const [key, b64] of Object.entries(data)) {
            const text = asCleanText(decodeBase64(b64));
            if (text === null) {
                binary[key] = b64;
            } else {
                stringData[key] = text;
            }
        }
        delete obj.data;
        delete obj.stringData;
        if (Object.keys(binary).length > 0) {
            obj.data = binary;
        }
        if (Object.keys(stringData).length > 0) {
            obj.stringData = stringData;
        }
    } else if (obj.kind === "ConfigMap") {
        // `data` is already plain text and edits directly. `binaryData` stays
        // base64 (it's binary by definition); we leave it untouched.
        if (obj.data == null) {
            delete obj.data;
        }
    }

    return YAML.stringify(reorder(obj), { lineWidth: 0 });
}

/**
 * Re-encode an edited Secret/ConfigMap back to an applyable manifest. Throws if
 * the edited identity (kind/name/namespace) no longer matches `ref` — names are
 * immutable and editing them would target the wrong object.
 */
export function fromEditableYaml(text: string, ref: ResourceRef): string {
    const obj = YAML.parse(text) as K8sObject;
    if (!obj || typeof obj !== "object") {
        throw new Error("document is empty or not a mapping");
    }
    assertIdentity(obj, ref);

    if (obj.kind === "Secret") {
        const data: Record<string, string> = { ...((obj.data as Record<string, string> | undefined) ?? {}) };
        const stringData = (obj.stringData as Record<string, string> | undefined) ?? {};
        for (const [key, value] of Object.entries(stringData)) {
            data[key] = encodeBase64(value ?? "");
        }
        delete obj.stringData;
        if (Object.keys(data).length > 0) {
            obj.data = data;
        } else {
            delete obj.data;
        }
    }
    // ConfigMap needs no re-encoding: data stays plain, binaryData stays base64.

    return YAML.stringify(reorder(obj), { lineWidth: 0 });
}

function assertIdentity(obj: K8sObject, ref: ResourceRef): void {
    const name = obj.metadata?.name;
    const namespace = obj.metadata?.namespace;
    if (name && name !== ref.name) {
        throw new Error(`name changed (${ref.name} → ${name}); names are immutable. Revert and re-edit.`);
    }
    if (ref.namespace && namespace && namespace !== ref.namespace) {
        throw new Error(`namespace changed (${ref.namespace} → ${namespace}); revert to apply.`);
    }
}

/** Stable, human-friendly key order for the emitted manifest. */
function reorder(obj: K8sObject): K8sObject {
    const order = ["apiVersion", "kind", "metadata", "type", "stringData", "data", "binaryData"];
    const out: Record<string, unknown> = {};
    for (const key of order) {
        if (obj[key] !== undefined) {
            out[key] = obj[key];
        }
    }
    for (const [key, value] of Object.entries(obj)) {
        if (!(key in out)) {
            out[key] = value;
        }
    }
    return out as K8sObject;
}
