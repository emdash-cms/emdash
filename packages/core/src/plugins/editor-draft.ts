import type {
	EditorDraftFieldDefinition,
	EditorDraftInvocationReceipt,
	EditorDraftPatchEffect,
	EditorDraftSnapshot,
} from "@emdash-cms/blocks";
import {
	isEditorDraftPatchEffect,
	validateEditorDraftPatchEffect,
} from "@emdash-cms/blocks/server";

import type { CollectionWithFields, Field } from "../schema/types.js";
import { generateFieldSchema } from "../schema/zod-generator.js";
import type { PluginEditorDraftFieldSelector } from "./types.js";

export const EDITOR_DRAFT_LIMITS = {
	maxFields: 32,
	maxSnapshotBytes: 192 * 1024,
	maxFieldBytes: 64 * 1024,
} as const;

export type EditorDraftErrorCode =
	| "EDITOR_DRAFT_STALE"
	| "EDITOR_DRAFT_FIELD_FORBIDDEN"
	| "EDITOR_DRAFT_INVALID"
	| "EDITOR_DRAFT_UNSUPPORTED_FIELD_TYPE"
	| "EDITOR_DRAFT_TOO_LARGE"
	| "EDITOR_DRAFT_CAPABILITY_REQUIRED";

export interface EditorDraftValidationError {
	code: EditorDraftErrorCode;
	message: string;
}

interface BrowserDraftRequest {
	collection: string;
	entryId: string;
	locale: string | null;
	baseRevision: string;
	generation: number;
	invocationId: string;
	fields: Record<string, unknown>;
}

export interface ValidatedEditorDraftRequest {
	snapshot: EditorDraftSnapshot;
	receipt: EditorDraftInvocationReceipt;
	readFields: ReadonlySet<string>;
	patchFields: ReadonlySet<string>;
}

const ENCODER = new TextEncoder();
const INVOCATION_PATTERN = /^[A-Za-z0-9_-]{16,128}$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isBrowserDraftRequest(value: unknown): value is BrowserDraftRequest {
	return (
		isRecord(value) &&
		typeof value.collection === "string" &&
		typeof value.entryId === "string" &&
		(value.locale === null || typeof value.locale === "string") &&
		typeof value.baseRevision === "string" &&
		typeof value.generation === "number" &&
		typeof value.invocationId === "string" &&
		isRecord(value.fields)
	);
}

function jsonBytes(value: unknown): number | null {
	try {
		return ENCODER.encode(JSON.stringify(value)).byteLength;
	} catch {
		return null;
	}
}

function selectedFields(
	collection: CollectionWithFields,
	selector: PluginEditorDraftFieldSelector | undefined,
): Set<string> {
	const selected = new Set(selector?.fields ?? []);
	if (selector?.translatable) {
		for (const field of collection.fields) {
			if (field.translatable) selected.add(field.slug);
		}
	}
	return selected;
}

function sanitizeField(field: Field): EditorDraftFieldDefinition {
	return {
		slug: field.slug,
		label: field.label,
		type: field.type,
		required: field.required,
		translatable: field.translatable,
		...(field.validation ? { validation: { ...field.validation } } : {}),
	};
}

function fail(code: EditorDraftErrorCode, message: string): EditorDraftValidationError {
	return { code, message };
}

export function validateEditorDraftRequest(input: {
	request: unknown;
	collection: CollectionWithFields;
	entry: { id: string; locale: string | null; revision: string };
	readSelector?: PluginEditorDraftFieldSelector;
	patchSelector?: PluginEditorDraftFieldSelector;
	canRead: boolean;
	canPatch: boolean;
}): ValidatedEditorDraftRequest | EditorDraftValidationError {
	if (!isBrowserDraftRequest(input.request)) {
		return fail("EDITOR_DRAFT_INVALID", "Invalid editor draft snapshot");
	}
	const request = input.request;
	if (
		request.collection !== input.collection.slug ||
		request.entryId !== input.entry.id ||
		request.locale !== input.entry.locale
	) {
		return fail("EDITOR_DRAFT_STALE", "Editor draft identity is stale");
	}
	if (request.baseRevision !== input.entry.revision) {
		return fail("EDITOR_DRAFT_STALE", "Editor draft base revision is stale");
	}
	if (
		!Number.isSafeInteger(request.generation) ||
		request.generation < 0 ||
		typeof request.invocationId !== "string" ||
		!INVOCATION_PATTERN.test(request.invocationId)
	) {
		return fail("EDITOR_DRAFT_INVALID", "Invalid editor draft invocation identity");
	}
	const size = jsonBytes(request);
	if (size === null)
		return fail("EDITOR_DRAFT_INVALID", "Editor draft snapshot must be JSON serializable");
	if (size > EDITOR_DRAFT_LIMITS.maxSnapshotBytes) {
		return fail("EDITOR_DRAFT_TOO_LARGE", "Editor draft snapshot exceeds the size limit");
	}

	const readFields = selectedFields(input.collection, input.readSelector);
	const patchFields = selectedFields(input.collection, input.patchSelector);
	if (
		readFields.size > EDITOR_DRAFT_LIMITS.maxFields ||
		patchFields.size > EDITOR_DRAFT_LIMITS.maxFields
	) {
		return fail("EDITOR_DRAFT_TOO_LARGE", "Editor draft selector exceeds the field limit");
	}
	const supplied = Object.keys(request.fields);
	if (supplied.length > EDITOR_DRAFT_LIMITS.maxFields) {
		return fail("EDITOR_DRAFT_TOO_LARGE", "Editor draft snapshot exceeds the field limit");
	}
	if (supplied.length > 0 && !input.canRead) {
		return fail("EDITOR_DRAFT_CAPABILITY_REQUIRED", "Plugin cannot read unsaved editor content");
	}
	const bySlug = new Map(input.collection.fields.map((field) => [field.slug, field]));
	const patchFieldDefinitions = Array.from(patchFields, (slug) => bySlug.get(slug))
		.filter((field): field is Field => Boolean(field && !field.unsupportedType))
		.map(sanitizeField);
	const fields: Record<string, unknown> = {};
	const fieldDefinitions: EditorDraftFieldDefinition[] = [];
	for (const slug of supplied) {
		if (!readFields.has(slug)) {
			return fail("EDITOR_DRAFT_FIELD_FORBIDDEN", `Editor draft field '${slug}' is not allowed`);
		}
		const field = bySlug.get(slug);
		if (!field || field.unsupportedType) {
			return fail(
				"EDITOR_DRAFT_UNSUPPORTED_FIELD_TYPE",
				`Editor draft field '${slug}' has an unsupported type`,
			);
		}
		const fieldSize = jsonBytes(request.fields[slug]);
		if (fieldSize === null)
			return fail("EDITOR_DRAFT_INVALID", `Editor draft field '${slug}' is invalid`);
		if (fieldSize > EDITOR_DRAFT_LIMITS.maxFieldBytes) {
			return fail("EDITOR_DRAFT_TOO_LARGE", `Editor draft field '${slug}' exceeds the size limit`);
		}
		if (!generateFieldSchema(field).safeParse(request.fields[slug]).success) {
			return fail("EDITOR_DRAFT_INVALID", `Editor draft field '${slug}' is invalid`);
		}
		fields[slug] = request.fields[slug];
		fieldDefinitions.push(sanitizeField(field));
	}
	if (input.readSelector && !input.canRead) {
		return fail("EDITOR_DRAFT_CAPABILITY_REQUIRED", "Plugin cannot read unsaved editor content");
	}
	if (input.patchSelector && !input.canPatch) {
		return fail("EDITOR_DRAFT_CAPABILITY_REQUIRED", "Plugin cannot propose unsaved editor changes");
	}

	return {
		snapshot: {
			collection: input.collection.slug,
			entryId: input.entry.id,
			locale: input.entry.locale,
			baseRevision: input.entry.revision,
			invocationId: request.invocationId,
			fields,
			fieldDefinitions,
		},
		receipt: {
			entryId: input.entry.id,
			locale: input.entry.locale,
			baseRevision: input.entry.revision,
			generation: request.generation,
			invocationId: request.invocationId,
			fieldDefinitions: patchFieldDefinitions,
		},
		readFields,
		patchFields,
	};
}

export function validateEditorDraftPatch(input: {
	patch: unknown;
	collection: CollectionWithFields;
	allowedFields: ReadonlySet<string>;
}): EditorDraftPatchEffect | EditorDraftValidationError {
	const structural = validateEditorDraftPatchEffect(input.patch);
	if (!structural.valid || !isEditorDraftPatchEffect(input.patch))
		return fail("EDITOR_DRAFT_INVALID", "Plugin returned an invalid editor draft patch");
	const patch = input.patch;
	const bySlug = new Map(input.collection.fields.map((field) => [field.slug, field]));
	for (const operation of patch.operations) {
		if (!input.allowedFields.has(operation.field)) {
			return fail(
				"EDITOR_DRAFT_FIELD_FORBIDDEN",
				`Editor draft field '${operation.field}' is not allowed`,
			);
		}
		const field = bySlug.get(operation.field);
		if (!field || field.unsupportedType) {
			return fail(
				"EDITOR_DRAFT_UNSUPPORTED_FIELD_TYPE",
				`Editor draft field '${operation.field}' has an unsupported type`,
			);
		}
		const value = operation.op === "clear" ? null : operation.value;
		if (!generateFieldSchema(field).safeParse(value).success) {
			return fail("EDITOR_DRAFT_INVALID", `Editor draft field '${operation.field}' is invalid`);
		}
		const fieldSize = jsonBytes(value);
		if (fieldSize === null || fieldSize > EDITOR_DRAFT_LIMITS.maxFieldBytes) {
			return fail(
				"EDITOR_DRAFT_TOO_LARGE",
				`Editor draft field '${operation.field}' exceeds the size limit`,
			);
		}
	}
	return patch;
}
