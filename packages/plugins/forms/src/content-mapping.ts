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

	const formFieldNames = new Set(pages.flatMap((page) => page.fields.map((field) => field.name)));
	const collectionFields = new Map(collection.fields.map((field) => [field.slug, field]));

	const mappedTargets = new Set<string>();
	for (const [formField, target] of Object.entries(mapping.fieldMappings)) {
		if (!formFieldNames.has(formField)) {
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
	}

	if (mapping.slugFrom && !formFieldNames.has(mapping.slugFrom)) {
		throw PluginRouteError.badRequest(
			`Content mapping slugFrom references unknown form field "${mapping.slugFrom}"`,
		);
	}

	// Metadata keys become entry fields, so an unknown key would make every
	// submit-time create fail against the collection table.
	const metadataKeys = new Set(Object.keys(mapping.metadata ?? {}));
	for (const key of metadataKeys) {
		if (!collectionFields.has(key)) {
			throw PluginRouteError.badRequest(
				`Content mapping metadata targets unknown field "${key}" in collection "${mapping.collection}"`,
			);
		}
	}

	// Every required field of the target collection must be covered by a
	// field mapping or a metadata constant — otherwise created entries would
	// always be missing data the collection declares as required.
	for (const field of collection.fields) {
		if (field.required && !mappedTargets.has(field.slug) && !metadataKeys.has(field.slug)) {
			throw PluginRouteError.badRequest(
				`Content mapping does not map required field "${field.slug}" in collection "${mapping.collection}"`,
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

let keyCounter = 0;

/** Generate a Portable Text `_key`, unique within this process */
function generateKey(): string {
	keyCounter += 1;
	return `form-${keyCounter.toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}
