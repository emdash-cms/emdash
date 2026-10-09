/**
 * Submission → content entry mapping.
 *
 * Validates a form's `contentMapping` against the target collection and
 * builds content entries from submissions.
 */

import type { FieldSchemaInfo, RouteContext } from "emdash";
import { PluginRouteError } from "emdash";

import type { ContentMapping, ContentMappingTransform, FormField, FormPage } from "./types.js";

// ─── Save-time Validation ────────────────────────────────────────

/**
 * Validate a content mapping against the target collection and the form's
 * fields. Throws `PluginRouteError.badRequest` describing the first problem
 * found.
 */
export async function validateContentMapping(
	ctx: RouteContext,
	mapping: ContentMapping,
	pages: FormPage[],
): Promise<void> {
	if (!ctx.schema) {
		throw PluginRouteError.internal("Schema access is not available");
	}

	const collection = await ctx.schema.getCollection(mapping.collection);
	if (!collection) {
		throw PluginRouteError.badRequest(
			`Content mapping targets unknown collection "${mapping.collection}"`,
		);
	}

	const formFields = new Map(
		pages.flatMap((page) => page.fields.map((field) => [field.name, field] as const)),
	);
	const collectionFields = new Map(collection.fields.map((field) => [field.slug, field]));

	const mappedTargets = new Set<string>();
	const targetsWithGuaranteedSource = new Set<string>();
	for (const [formField, target] of Object.entries(mapping.fieldMappings)) {
		const source = formFields.get(formField);
		if (!source) {
			throw PluginRouteError.badRequest(
				`Content mapping references unknown form field "${formField}"`,
			);
		}
		// Uploaded files are not part of the validated submission data.
		if (source.type === "file") {
			throw PluginRouteError.badRequest(
				`Content mapping cannot map file field "${formField}"; file uploads are not supported as content values`,
			);
		}
		const targetField = typeof target === "string" ? target : target.field;
		const transform = typeof target === "string" ? undefined : target.transform;
		const collectionField = collectionFields.get(targetField);
		if (!collectionField) {
			throw PluginRouteError.badRequest(
				`Content mapping targets unknown field "${targetField}" in collection "${mapping.collection}"`,
			);
		}

		const produced = transformedValue(formValue(source), transform);
		if (!accepts(collectionField, produced.value)) {
			const via = transform ? `, ${transform} transform` : "";
			throw PluginRouteError.badRequest(
				`Content mapping maps form field "${formField}" (${source.type}${via}) to field "${targetField}" (${collectionField.type}) in collection "${mapping.collection}", which does not accept that value`,
			);
		}
		if (collectionField.required && produced.lossy) {
			throw PluginRouteError.badRequest(
				`Content mapping maps required field "${targetField}" in collection "${mapping.collection}" from form field "${formField}" with the ${transform} transform, which cannot convert every ${source.type} value. Map a ${transform} form field instead`,
			);
		}

		mappedTargets.add(targetField);
		// A required field hidden by a condition is skipped by submission validation.
		if (source.required && !source.condition) {
			targetsWithGuaranteedSource.add(targetField);
		}
	}

	const metadata = mapping.metadata ?? {};
	const metadataKeys = new Set(Object.keys(metadata));
	for (const key of metadataKeys) {
		if (mappedTargets.has(key)) {
			throw PluginRouteError.badRequest(
				`Content mapping metadata field "${key}" in collection "${mapping.collection}" is also mapped from a form field`,
			);
		}
		const collectionField = collectionFields.get(key);
		if (!collectionField) {
			throw PluginRouteError.badRequest(
				`Content mapping metadata targets unknown field "${key}" in collection "${mapping.collection}"`,
			);
		}
		if (collectionField.required && isEmptyValue(metadata[key])) {
			throw PluginRouteError.badRequest(
				`Content mapping metadata for required field "${key}" in collection "${mapping.collection}" must not be empty`,
			);
		}
		if (!isEmptyValue(metadata[key]) && !accepts(collectionField, metadataValue(metadata[key]))) {
			throw PluginRouteError.badRequest(
				`Content mapping metadata for field "${key}" in collection "${mapping.collection}" is not a valid ${collectionField.type} value`,
			);
		}
	}

	// A required collection field needs a value on every submission: a
	// metadata constant, or a mapping from a form field that is always filled.
	for (const field of collection.fields) {
		if (!field.required || metadataKeys.has(field.slug)) continue;
		if (!mappedTargets.has(field.slug)) {
			throw PluginRouteError.badRequest(
				`Content mapping does not map required field "${field.slug}" in collection "${mapping.collection}"`,
			);
		}
		if (!targetsWithGuaranteedSource.has(field.slug)) {
			throw PluginRouteError.badRequest(
				`Content mapping maps required field "${field.slug}" in collection "${mapping.collection}" from an optional or conditional form field. Mark the form field as required with no condition, or cover the field with metadata`,
			);
		}
	}
}

function isEmptyValue(value: unknown): boolean {
	return (
		value === undefined || value === null || (typeof value === "string" && value.trim() === "")
	);
}

// ─── Value Compatibility ─────────────────────────────────────────

/**
 * The shape of a value a mapping writes into an entry. `options` lists the
 * values a string or string list can take when they are known up front.
 */
interface ProducedValue {
	kind:
		| "string"
		| "url"
		| "date"
		| "datetime"
		| "number"
		| "boolean"
		| "stringList"
		| "portableText"
		| "object";
	options?: string[];
}

const ISO_DATETIME_RE = /^\d{4}-\d{2}-\d{2}T/;

/** What `validateSubmission` leaves in the submission data for a form field. */
function formValue(field: FormField): ProducedValue {
	switch (field.type) {
		case "number":
			return { kind: "number" };
		case "checkbox":
			return { kind: "boolean" };
		case "checkbox-group":
			return { kind: "stringList", options: field.options?.map((option) => option.value) };
		case "date":
			return { kind: "date" };
		case "url":
			return { kind: "url" };
		case "select":
		case "radio":
			return { kind: "string", options: field.options?.map((option) => option.value) };
		default:
			return { kind: "string" };
	}
}

/**
 * What a transform turns a form value into. `lossy` means the transform can
 * yield nothing for some inputs, so the target field may end up unset.
 */
function transformedValue(
	source: ProducedValue,
	transform: ContentMappingTransform | undefined,
): { value: ProducedValue; lossy: boolean } {
	switch (transform) {
		case "string":
			return { value: { kind: "string" }, lossy: false };
		case "number":
			return { value: { kind: "number" }, lossy: source.kind !== "number" };
		case "date":
			return { value: { kind: "datetime" }, lossy: source.kind !== "date" };
		case "portableText":
			return { value: { kind: "portableText" }, lossy: false };
		default:
			return { value: source, lossy: false };
	}
}

function metadataValue(value: unknown): ProducedValue {
	if (typeof value === "string") {
		if (ISO_DATETIME_RE.test(value) && !Number.isNaN(Date.parse(value))) {
			return { kind: "datetime", options: [value] };
		}
		return { kind: "string", options: [value] };
	}
	if (typeof value === "number") return { kind: "number", options: [String(value)] };
	if (typeof value === "boolean") return { kind: "boolean" };
	if (Array.isArray(value)) {
		if (value.every((item): item is string => typeof item === "string")) {
			return { kind: "stringList", options: value };
		}
		return { kind: "portableText" };
	}
	return { kind: "object" };
}

const TEXT_KINDS: ReadonlySet<ProducedValue["kind"]> = new Set([
	"string",
	"url",
	"date",
	"datetime",
]);

/** Whether core content validation accepts `value` for `field`. */
function accepts(field: FieldSchemaInfo, value: ProducedValue): boolean {
	switch (field.type) {
		case "string":
		case "text":
		case "slug":
			return TEXT_KINDS.has(value.kind);
		case "url":
			return value.kind === "url" || value.kind === "string";
		case "number":
			return value.kind === "number";
		case "integer":
			return (
				value.kind === "number" &&
				(value.options ?? []).every((option) => Number.isInteger(Number(option)))
			);
		case "boolean":
			return value.kind === "boolean";
		case "datetime":
			return value.kind === "datetime";
		case "select":
			return TEXT_KINDS.has(value.kind) && withinOptions(field, value);
		case "multiSelect":
			return value.kind === "stringList" && withinOptions(field, value);
		case "portableText":
			return value.kind === "portableText";
		case "json":
			return true;
		default:
			return false;
	}
}

/** A select field with options only takes those options, so the source values must be known. */
function withinOptions(field: FieldSchemaInfo, value: ProducedValue): boolean {
	const allowed = field.validation?.options;
	if (!allowed || allowed.length === 0) return true;
	if (!value.options) return false;
	return value.options.every((option) => allowed.includes(option));
}

// ─── Submit-time Entry Creation ──────────────────────────────────

/**
 * Build the content entry data for a validated submission. Empty values are
 * skipped rather than written as empty fields.
 */
export function buildContentEntry(
	mapping: ContentMapping,
	data: Record<string, unknown>,
): Record<string, unknown> {
	const entry: Record<string, unknown> = { ...mapping.metadata };

	for (const [formField, target] of Object.entries(mapping.fieldMappings)) {
		const value = data[formField];
		if (value === undefined || value === null || value === "") continue;

		const targetField = typeof target === "string" ? target : target.field;
		const transform = typeof target === "string" ? undefined : target.transform;
		const transformed = applyTransform(value, transform);
		if (transformed !== undefined) {
			entry[targetField] = transformed;
		}
	}

	return entry;
}

/**
 * Coerce a submitted value for its target field. Values that cannot be
 * coerced (e.g. a non-numeric string with the `number` transform) return
 * `undefined` and are skipped rather than failing the whole entry.
 */
export function applyTransform(value: unknown, transform?: ContentMappingTransform): unknown {
	switch (transform) {
		case "portableText":
			return textToPortableText(toDisplayString(value));
		case "string":
			return toDisplayString(value);
		case "number": {
			const num = Number(value);
			return Number.isNaN(num) ? undefined : num;
		}
		case "date": {
			const parsed = Date.parse(toDisplayString(value));
			return Number.isNaN(parsed) ? undefined : new Date(parsed).toISOString();
		}
		default:
			return value;
	}
}

/** Join checkbox-group arrays with a comma; stringify scalars. */
function toDisplayString(value: unknown): string {
	if (Array.isArray(value)) {
		return value.map((item) => String(item)).join(", ");
	}
	// eslint-disable-next-line typescript/no-base-to-string -- form field value is a scalar at runtime
	return String(value);
}

/** Blank line(s) separating paragraphs */
const PARAGRAPH_BREAK_RE = /\r?\n\s*\r?\n/;

/**
 * Convert plain text to Portable Text: blank-line-separated paragraphs
 * become `normal`-style blocks.
 */
export function textToPortableText(text: string): unknown[] {
	const paragraphs = text
		.split(PARAGRAPH_BREAK_RE)
		.map((paragraph) => paragraph.trim())
		.filter((paragraph) => paragraph.length > 0);

	return paragraphs.map((paragraph) => ({
		_type: "block",
		_key: generateKey(),
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: generateKey(), text: paragraph, marks: [] }],
	}));
}

function generateKey(): string {
	return Math.random().toString(36).substring(2, 11);
}
