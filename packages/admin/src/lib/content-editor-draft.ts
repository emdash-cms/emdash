import type { EditorDraftFieldDefinition, EditorDraftPatchOperation } from "@emdash-cms/blocks";
import { i18n, type MessageDescriptor } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import {
	portableTextToProsemirror,
	type PluginBlockDef,
} from "../components/PortableTextEditor.js";
import type { SeoText } from "../components/SeoPanel.js";
import type { ContentEditorDraft, ContentEditorDraftPatchResult } from "./content-editor-panels.js";
import { getFieldLabel } from "./field-label.js";
import { findUnsupportedPortableTextMarks } from "./portable-text-marks.js";

/** A collection field as the manifest describes it. */
export interface DraftFieldDescriptor {
	kind: string;
	/** Schema type. Fields without one stay out of the draft. */
	type?: string;
	label?: string;
	required?: boolean;
	translatable?: boolean;
	validation?: Record<string, unknown>;
	widget?: string;
	unsupportedType?: unknown;
}

/** What the draft reads from the editor, fresh on every call. */
export interface EditorDraftState {
	/** False while the editor is read-only or a version is open in the revision view. */
	acceptsEdits: boolean;
	fields: Readonly<Record<string, DraftFieldDescriptor>>;
	/** Collection field values as the form holds them, edits that haven't rendered included. */
	formData: Readonly<Record<string, unknown>>;
	slug: string;
	/** The SEO title and description as last typed or patched; null in a collection without SEO. */
	seo: SeoText | null;
	/** The block types the rich text editor treats as plugin blocks when it mounts. */
	pluginBlocks: readonly PluginBlockDef[];
	/** Whether an available plugin widget renders the field instead of the built-in editor. */
	rendersWidget(field: DraftFieldDescriptor): boolean;
}

export interface EditorDraftHost {
	/** The editor's state, or null once the editor shows another entry or has unmounted. */
	read(): EditorDraftState | null;
	/** Writes a checked patch into the form, slug and SEO text in one step. */
	apply(changes: DraftChanges): void;
}

/** The writes one patch makes, with a JSON copy of every `set` value. */
export interface DraftChanges {
	/** Keyed by collection field slug; `null` clears the field. */
	fields: Record<string, unknown>;
	/** A non-empty slug, when the patch names `slug`. */
	slug?: string;
	/** SEO text as SeoPanel holds it, with "" for none. */
	seo?: Partial<SeoText>;
}

interface FieldTypeRule {
	/** Whether a `set` value other than null has the shape the field type takes. */
	accepts(value: unknown): boolean;
	/** Completes "expected …" in an EDITOR_DRAFT_INVALID message. */
	expected: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
	typeof value === "object" && value !== null && !Array.isArray(value);
const arrayOf = (item: (value: unknown) => boolean) => (value: unknown) =>
	Array.isArray(value) && value.every(item);
const text: FieldTypeRule = { accepts: (value) => typeof value === "string", expected: "a string" };

/** Every schema type a draft field can have, with the top-level shape its values take. */
const FIELD_TYPES: Record<string, FieldTypeRule> = {
	string: text,
	slug: text,
	text,
	url: text,
	datetime: text,
	select: text,
	reference: text,
	number: {
		accepts: (value) => typeof value === "number" && Number.isFinite(value),
		expected: "a finite number",
	},
	integer: { accepts: Number.isInteger, expected: "an integer" },
	boolean: {
		accepts: (value) => value === true || value === false || value === 0 || value === 1,
		expected: "true, false, 0 or 1",
	},
	multiSelect: {
		accepts: arrayOf((item) => typeof item === "string"),
		expected: "an array of strings",
	},
	portableText: {
		accepts: arrayOf((block) => isRecord(block) && typeof block._type === "string"),
		expected: "an array of objects with a string _type",
	},
	repeater: { accepts: arrayOf(isRecord), expected: "an array of objects" },
	blocks: { accepts: arrayOf(isRecord), expected: "an array of objects" },
	image: { accepts: isRecord, expected: "an object" },
	file: { accepts: isRecord, expected: "an object" },
	json: { accepts: () => true, expected: "a JSON value" },
};

interface HostKeyRule {
	key: string;
	type: "slug" | "string" | "text";
	/** The label the editor shows for the value. */
	label: MessageDescriptor;
	/** Where the editor holds the value: the slug input or a SeoPanel text. */
	holds: "slug" | keyof SeoText;
	maxLength?: number;
}

/** Draft keys that aren't collection fields. `slug` is a reserved field slug, and field slugs can't contain a dot. */
const HOST_KEYS: readonly HostKeyRule[] = [
	{ key: "slug", type: "slug", label: msg`Slug`, holds: "slug" },
	{ key: "seo.title", type: "string", label: msg`SEO Title`, holds: "title", maxLength: 200 },
	{
		key: "seo.description",
		type: "text",
		label: msg`Meta Description`,
		holds: "description",
		maxLength: 500,
	},
];

type DraftKey =
	| {
			name: string;
			source: "field";
			field: DraftFieldDescriptor;
			type: string;
			rule: FieldTypeRule;
	  }
	| { name: string; source: "host"; host: HostKeyRule; rule: FieldTypeRule };

/**
 * A reference field bound to a relation keeps its selection outside the form values, in the
 * save request's `references`. The field renderer shows the relation picker for the same fields.
 */
export function boundReference(field: {
	kind: string;
	validation?: Record<string, unknown>;
}): { relation: string; targetCollection: string } | null {
	const relation = field.validation?.relation;
	const targetCollection = field.validation?.targetCollection;
	return field.kind === "reference" &&
		typeof relation === "string" &&
		typeof targetCollection === "string"
		? { relation, targetCollection }
		: null;
}

/** The draft's keys in snapshot and revision order: fields in schema order, then the host keys. */
function draftKeys(state: EditorDraftState): DraftKey[] {
	const keys: DraftKey[] = [];
	for (const [name, field] of Object.entries(state.fields)) {
		const type = field.type;
		if (!type || field.unsupportedType || boundReference(field)) continue;
		const rule = Object.hasOwn(FIELD_TYPES, type) ? FIELD_TYPES[type] : undefined;
		if (rule) keys.push({ name, source: "field", field, type, rule });
	}
	for (const host of HOST_KEYS) {
		if (host.holds !== "slug" && !state.seo) continue;
		keys.push({ name: host.key, source: "host", host, rule: text });
	}
	return keys;
}

/** The value a key holds, with null for none: a missing field value, or an empty slug or SEO text. */
function currentValue(key: DraftKey, state: EditorDraftState): unknown {
	if (key.source === "field") return state.formData[key.name] ?? null;
	if (key.host.holds === "slug") return state.slug || null;
	return state.seo?.[key.host.holds] || null;
}

/** JSON text, or undefined for a value JSON can't hold, such as undefined, a BigInt or a cycle. */
function jsonOf(value: unknown): string | undefined {
	try {
		return JSON.stringify(value);
	} catch {
		return undefined;
	}
}

/** A JSON round trip of `value`, or undefined for a value JSON can't hold. */
function jsonCopy(value: unknown): unknown {
	const json = jsonOf(value);
	return json === undefined ? undefined : JSON.parse(json);
}

/** The JSON of each draft value in key order. The revision and the snapshot both come from it. */
function serializeValues(keys: readonly DraftKey[], state: EditorDraftState): string[] {
	return keys.map((key) => jsonOf(currentValue(key, state)) ?? "null");
}

function definitionOf(key: DraftKey): EditorDraftFieldDefinition {
	if (key.source === "field") {
		const { field } = key;
		return {
			slug: key.name,
			label: getFieldLabel(key.name, field),
			type: key.type,
			required: Boolean(field.required),
			translatable: Boolean(field.translatable),
			...(field.validation && { validation: structuredClone(field.validation) }),
		};
	}
	const { host } = key;
	return {
		slug: key.name,
		label: i18n._(host.label),
		type: host.type,
		required: false,
		translatable: true,
		...(host.maxLength !== undefined && { validation: { maxLength: host.maxLength } }),
	};
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

/** Why `operation` can't go into `key`, or null. `value` is the JSON copy the form would receive. */
function valueProblem(
	key: DraftKey,
	operation: EditorDraftPatchOperation,
	value: unknown,
	state: EditorDraftState,
): string | null {
	if (key.source === "host" && key.host.holds === "slug") {
		if (operation.op === "clear") return "the slug can't be cleared";
		return typeof value === "string" && value !== "" ? null : "expected a non-empty string";
	}
	// NaN and Infinity copy as null, so only a null the caller passed counts as a clear.
	if (operation.op === "clear" || operation.value === null) return null;
	if (!key.rule.accepts(value)) return `expected ${key.rule.expected}`;
	if (key.source === "host") {
		const { maxLength } = key.host;
		return maxLength !== undefined && typeof value === "string" && value.length > maxLength
			? `longer than ${maxLength} characters`
			: null;
	}
	return loadsAsRichText(key.field, state) ? richTextProblem(value, state) : null;
}

function parseOperation(value: unknown): EditorDraftPatchOperation | null {
	if (!isRecord(value) || typeof value.field !== "string") return null;
	if (value.op === "clear") return { op: "clear", field: value.field };
	if (value.op === "set") return { op: "set", field: value.field, value: value.value };
	return null;
}

/** Adds the write of `value`, a JSON copy or null, to `field`. */
function addChange(changes: DraftChanges, field: string, value: unknown): void {
	const host = HOST_KEYS.find((rule) => rule.key === field);
	if (!host) {
		changes.fields[field] = value;
		return;
	}
	const held = typeof value === "string" ? value : "";
	if (host.holds === "slug") changes.slug = held;
	else changes.seo = { ...changes.seo, [host.holds]: held };
}

function toDraftChanges(operations: readonly EditorDraftPatchOperation[]): DraftChanges {
	const changes: DraftChanges = { fields: {} };
	for (const operation of operations) {
		const value =
			operation.op === "set" && operation.value !== null ? jsonCopy(operation.value) : null;
		addChange(changes, operation.field, value);
	}
	return changes;
}

type PatchCheck = { ok: true; changes: DraftChanges } | { ok: false; message: string };

/** Checks a whole trusted patch before anything is written, and reports the first problem. */
function checkPatch(
	operations: unknown,
	keys: readonly DraftKey[],
	state: EditorDraftState,
): PatchCheck {
	if (!Array.isArray(operations) || operations.length === 0) {
		return {
			ok: false,
			message: "operations must be a non-empty array of set and clear operations",
		};
	}
	const byName = new Map(keys.map((key) => [key.name, key]));
	const changes: DraftChanges = { fields: {} };
	const seen = new Set<string>();
	for (const [index, value] of operations.entries()) {
		const at = `Operation ${index + 1}`;
		const operation = parseOperation(value);
		if (!operation) {
			return {
				ok: false,
				message: `${at} must be { op: "set", field, value } or { op: "clear", field }`,
			};
		}
		const named = `${at} (${operation.op} "${operation.field}")`;
		if (seen.has(operation.field)) {
			return { ok: false, message: `${named} names a field an earlier operation names` };
		}
		seen.add(operation.field);
		const key = byName.get(operation.field);
		if (!key) return { ok: false, message: `${named} names a field that isn't a draft field` };
		const copy = operation.op === "set" ? jsonCopy(operation.value) : null;
		const problem =
			copy === undefined
				? "the value can't be serialized as JSON"
				: valueProblem(key, operation, copy, state);
		if (problem) return { ok: false, message: `${named}: ${problem}` };
		addChange(changes, operation.field, copy);
	}
	return { ok: true, changes };
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

function refuse(
	code: "EDITOR_DRAFT_STALE" | "EDITOR_DRAFT_READ_ONLY" | "EDITOR_DRAFT_INVALID",
	message: string,
): ContentEditorDraftPatchResult {
	return { ok: false, code, message };
}

/** The caller's `options.expectedRevision`, or undefined when the options can't be read. */
function expectedRevisionOf(options: unknown): unknown {
	try {
		return isRecord(options) ? options.expectedRevision : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The draft object a trusted panel receives, one per entry the editor shows. Its revision is a
 * random ID and a counter that advances whenever a call finds the draft values different from
 * the previous call's, so it follows every edit without any edit path advancing it. Retirement
 * is the host's `read()` returning null, which never reverts.
 */
export function createContentEditorDraft(host: EditorDraftHost): ContentEditorDraft {
	const id =
		globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
	let counter = 0;
	let lastValues: string | null = null;

	const revisionOf = (serialized: readonly string[]): string => {
		const values = `[${serialized.join(",")}]`;
		if (lastValues !== null && values !== lastValues) counter++;
		lastValues = values;
		return `${id}:${counter}`;
	};

	return {
		get() {
			const state = host.read();
			if (!state) return { revision: "", readOnly: true, fields: {}, fieldDefinitions: [] };
			const keys = draftKeys(state);
			const serialized = serializeValues(keys, state);
			return {
				revision: revisionOf(serialized),
				readOnly: !state.acceptsEdits,
				fields: Object.fromEntries(
					keys.map((key, index) => [key.name, JSON.parse(serialized[index] ?? "null")]),
				),
				fieldDefinitions: keys.map(definitionOf),
			};
		},
		patch(operations: unknown, options?: unknown) {
			const state = host.read();
			if (!state) {
				return refuse(
					"EDITOR_DRAFT_STALE",
					"This editor draft is for an entry the editor no longer shows.",
				);
			}
			const keys = draftKeys(state);
			if (revisionOf(serializeValues(keys, state)) !== expectedRevisionOf(options)) {
				return refuse(
					"EDITOR_DRAFT_STALE",
					"The draft changed after this revision was read. Read it again with get().",
				);
			}
			if (!state.acceptsEdits) {
				return refuse("EDITOR_DRAFT_READ_ONLY", "The editor doesn't accept edits right now.");
			}
			let checked: PatchCheck;
			try {
				checked = checkPatch(operations, keys, state);
			} catch {
				// A getter or proxy in the caller's operations threw.
				checked = { ok: false, message: "the operations couldn't be read" };
			}
			if (!checked.ok) return refuse("EDITOR_DRAFT_INVALID", checked.message);
			host.apply(checked.changes);
			return { ok: true };
		},
	};
}
