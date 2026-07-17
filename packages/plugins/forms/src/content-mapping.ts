/**
 * Submission → content entry mapping.
 *
 * Implements the `contentMapping` form setting: validates a mapping against
 * the target collection when a form is saved, and builds a draft content
 * entry from a successful submission. Content creation is additive — the
 * submission is stored in the forms inbox regardless, and a create failure
 * never loses the submission or fails the submit request.
 */

import type { RouteContext } from "emdash";
import { PluginRouteError } from "emdash";

import type { ContentMapping, ContentMappingTransform, FormPage } from "./types.js";

// ─── Save-time Validation ────────────────────────────────────────

/**
 * Validate a content mapping against the target collection and the form's
 * fields. Called when a form is saved — not only at submit time — so
 * misconfigurations surface to the editor instead of silently failing
 * content creation later.
 *
 * Throws `PluginRouteError.badRequest` describing the first problem found.
 */
export async function validateContentMapping(
	ctx: RouteContext,
	mapping: ContentMapping,
	pages: FormPage[],
): Promise<void> {
	if (!ctx.content) {
		throw PluginRouteError.internal("Content access is not available");
	}

	const collection = await ctx.content.getCollection(mapping.collection);
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
	const targetsWithRequiredSource = new Set<string>();
	for (const [formField, target] of Object.entries(mapping.fieldMappings)) {
		const source = formFields.get(formField);
		if (!source) {
			throw PluginRouteError.badRequest(
				`Content mapping references unknown form field "${formField}"`,
			);
		}
		const targetField = typeof target === "string" ? target : target.field;
		if (!collectionFields.has(targetField)) {
			throw PluginRouteError.badRequest(
				`Content mapping targets unknown field "${targetField}" in collection "${mapping.collection}"`,
			);
		}
		mappedTargets.add(targetField);
		if (source.required) {
			targetsWithRequiredSource.add(targetField);
		}
	}

	if (mapping.slugFrom && !formFields.has(mapping.slugFrom)) {
		throw PluginRouteError.badRequest(
			`Content mapping slugFrom references unknown form field "${mapping.slugFrom}"`,
		);
	}

	// Metadata keys become entry fields, so an unknown key would make every
	// submit-time create fail against the collection table — and a nullish
	// constant cannot satisfy a required field.
	const metadata = mapping.metadata ?? {};
	const metadataKeys = new Set(Object.keys(metadata));
	for (const key of metadataKeys) {
		const collectionField = collectionFields.get(key);
		if (!collectionField) {
			throw PluginRouteError.badRequest(
				`Content mapping metadata targets unknown field "${key}" in collection "${mapping.collection}"`,
			);
		}
		if (collectionField.required && (metadata[key] === undefined || metadata[key] === null)) {
			throw PluginRouteError.badRequest(
				`Content mapping metadata for required field "${key}" in collection "${mapping.collection}" must not be null`,
			);
		}
	}

	// Every required field of the target collection must receive a value at
	// submit time: either a metadata constant (checked non-null above) or a
	// mapping whose source form field is itself required — an optional form
	// field left empty would create an entry missing required data.
	for (const field of collection.fields) {
		if (!field.required || metadataKeys.has(field.slug)) continue;
		if (!mappedTargets.has(field.slug)) {
			throw PluginRouteError.badRequest(
				`Content mapping does not map required field "${field.slug}" in collection "${mapping.collection}"`,
			);
		}
		if (!targetsWithRequiredSource.has(field.slug)) {
			throw PluginRouteError.badRequest(
				`Content mapping maps required field "${field.slug}" in collection "${mapping.collection}" from an optional form field — mark the form field as required or cover the field with metadata`,
			);
		}
	}
}

// ─── Submit-time Entry Creation ──────────────────────────────────

/**
 * Build the content entry data for a validated submission.
 *
 * Empty values are skipped rather than written as empty fields. When
 * `slugFrom` is set, the reserved `slug` key is populated with the raw
 * field value — the core content API runs it through the same slug
 * generation as the admin/REST create path.
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

	if (mapping.slugFrom) {
		const slugSource = data[mapping.slugFrom];
		if (typeof slugSource === "string" && slugSource.length > 0) {
			entry.slug = slugSource;
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

// The `_key` counter lives on `globalThis` because Vite can duplicate this
// module across SSR chunks — a plain module-scope variable would become two
// independent counters.
const KEY_COUNTER = Symbol.for("emdash-forms:content-mapping-key-counter");
const g = globalThis as Record<symbol, unknown>;

/** Generate a Portable Text `_key`, unique within this process */
function generateKey(): string {
	const current = g[KEY_COUNTER];
	const next = (typeof current === "number" ? current : 0) + 1;
	g[KEY_COUNTER] = next;
	return `form-${next.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
