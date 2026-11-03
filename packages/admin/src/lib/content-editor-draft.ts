import type { EditorDraftPatchOperation } from "@emdash-cms/blocks";

import {
	portableTextToProsemirror,
	type PluginBlockDef,
} from "../components/PortableTextEditor.js";
import { findUnsupportedPortableTextMarks } from "./portable-text-marks.js";

/** A collection field as the manifest describes it. */
export interface DraftFieldDescriptor {
	kind: string;
	widget?: string;
}

/** What the patch checks read from the editor. */
export interface EditorDraftState {
	fields: Readonly<Record<string, DraftFieldDescriptor>>;
	/** The block types the rich text editor treats as plugin blocks when it mounts. */
	pluginBlocks: readonly PluginBlockDef[];
	/** Whether an available plugin widget renders the field instead of the built-in editor. */
	rendersWidget(field: DraftFieldDescriptor): boolean;
}

/** The writes one patch makes, with a JSON copy of every `set` value. */
export interface DraftChanges {
	/** Keyed by collection field slug; `null` clears the field. */
	fields: Record<string, unknown>;
}

type PatchCheck = { ok: true; changes: DraftChanges } | { ok: false; message: string };

function jsonCopy(value: unknown): unknown {
	return JSON.parse(JSON.stringify(value));
}

function loadsAsRichText(field: DraftFieldDescriptor, state: EditorDraftState): boolean {
	return field.kind === "portableText" && !state.rendersWidget(field);
}

/** Why the rich text editor can't load `value` the way it does when it mounts, or null. */
function richTextProblem(value: unknown, state: EditorDraftState): string | null {
	// The field shows anything but a list without mounting the rich text editor.
	if (!Array.isArray(value)) return null;
	const marks = findUnsupportedPortableTextMarks(value);
	if (marks.length > 0) {
		return `uses marks the rich text editor doesn't support: ${marks.join(", ")}`;
	}
	try {
		portableTextToProsemirror(value, new Set(state.pluginBlocks.map((block) => block.type)));
		return null;
	} catch {
		return "the rich text editor can't load this value";
	}
}

function toDraftChanges(operations: readonly EditorDraftPatchOperation[]): DraftChanges {
	const changes: DraftChanges = { fields: {} };
	for (const operation of operations) {
		changes.fields[operation.field] =
			operation.op === "set" && operation.value !== null ? jsonCopy(operation.value) : null;
	}
	return changes;
}

/**
 * Checks a sandboxed patch the server has already validated against the field
 * schemas. Only the rich text load is left to check, because a patched rich
 * text editor remounts and converts the value then.
 */
export function checkSandboxedPatch(
	operations: readonly EditorDraftPatchOperation[],
	state: EditorDraftState,
): PatchCheck {
	const changes = toDraftChanges(operations);
	for (const [name, value] of Object.entries(changes.fields)) {
		const field = state.fields[name];
		if (!field || !loadsAsRichText(field, state)) continue;
		const problem = richTextProblem(value, state);
		if (problem) return { ok: false, message: `"${name}" ${problem}` };
	}
	return { ok: true, changes };
}
