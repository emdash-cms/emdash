import { describe, expect, it } from "vitest";

import {
	EDITOR_DRAFT_LIMITS,
	validateEditorDraftPatch,
	validateEditorDraftRequest,
} from "../../../src/plugins/editor-draft.js";
import type { CollectionWithFields, Field } from "../../../src/schema/types.js";

function field(overrides: Partial<Field> & Pick<Field, "slug" | "type">): Field {
	return {
		id: `field-${overrides.slug}`,
		collectionId: "collection-posts",
		label: overrides.slug,
		columnType: "TEXT",
		required: false,
		unique: false,
		sortOrder: 0,
		searchable: false,
		indexed: false,
		translatable: true,
		createdAt: "2026-01-01T00:00:00.000Z",
		...overrides,
	};
}

const collection = {
	id: "collection-posts",
	slug: "posts",
	label: "Posts",
	labelSingular: "Post",
	fields: [
		field({ slug: "title", type: "string", required: true }),
		field({ slug: "excerpt", type: "text" }),
		field({ slug: "rating", type: "integer", translatable: false, columnType: "INTEGER" }),
		field({
			slug: "legacy",
			type: "json",
			unsupportedType: { type: "future", path: "fields.legacy.type" },
			columnType: "JSON",
		}),
	],
} as CollectionWithFields;

function request(overrides: Record<string, unknown> = {}) {
	return {
		collection: "posts",
		entryId: "entry-1",
		locale: "en",
		baseRevision: "rev-1",
		generation: 4,
		invocationId: "invocation_123456",
		fields: { title: "Unsaved title", excerpt: "Unsaved excerpt" },
		...overrides,
	};
}

function validate(overrides: Partial<Parameters<typeof validateEditorDraftRequest>[0]> = {}) {
	return validateEditorDraftRequest({
		request: request(),
		collection,
		entry: { id: "entry-1", locale: "en", revision: "rev-1" },
		readSelector: { fields: ["title"], translatable: true },
		patchSelector: { fields: ["title", "excerpt"] },
		canRead: true,
		canPatch: true,
		...overrides,
	});
}

describe("editor draft host validation", () => {
	it("returns only selected values and sanitized definitions", () => {
		const result = validate();
		expect(result).not.toHaveProperty("code");
		if ("code" in result) return;
		expect(result.snapshot.fields).toEqual({
			title: "Unsaved title",
			excerpt: "Unsaved excerpt",
		});
		expect(result.snapshot.fieldDefinitions).toEqual([
			expect.objectContaining({ slug: "title", type: "string", translatable: true }),
			expect.objectContaining({ slug: "excerpt", type: "text", translatable: true }),
		]);
		expect(result.snapshot).not.toHaveProperty("generation");
	});

	it.each([
		["collection", { collection: "pages" }],
		["entry", { entryId: "entry-2" }],
		["locale", { locale: "fr" }],
		["base revision", { baseRevision: "rev-2" }],
	])("rejects stale %s identity", (_label, changed) => {
		expect(validate({ request: request(changed) })).toMatchObject({ code: "EDITOR_DRAFT_STALE" });
	});

	it("keeps read and patch capabilities independent", () => {
		expect(validate({ canRead: false })).toMatchObject({
			code: "EDITOR_DRAFT_CAPABILITY_REQUIRED",
		});
		expect(
			validate({ request: request({ fields: {} }), readSelector: undefined, canRead: false }),
		).not.toHaveProperty("code");
		expect(validate({ canPatch: false })).toMatchObject({
			code: "EDITOR_DRAFT_CAPABILITY_REQUIRED",
		});
	});

	it("rejects selector, schema, unsupported-type, count, and byte violations", () => {
		expect(
			validate({
				request: request({ fields: { rating: 5 } }),
				readSelector: { fields: ["title"] },
			}),
		).toMatchObject({ code: "EDITOR_DRAFT_FIELD_FORBIDDEN" });
		expect(validate({ request: request({ fields: { title: 5 } }) })).toMatchObject({
			code: "EDITOR_DRAFT_INVALID",
		});
		expect(
			validate({
				request: request({ fields: { legacy: {} } }),
				readSelector: { fields: ["legacy"] },
			}),
		).toMatchObject({ code: "EDITOR_DRAFT_UNSUPPORTED_FIELD_TYPE" });
		expect(
			validate({
				request: request({
					fields: Object.fromEntries(Array.from({ length: 33 }, (_, i) => [`f${i}`, i])),
				}),
			}),
		).toMatchObject({ code: "EDITOR_DRAFT_TOO_LARGE" });
		expect(
			validate({
				request: request({ fields: { title: "x".repeat(EDITOR_DRAFT_LIMITS.maxFieldBytes) } }),
			}),
		).toMatchObject({ code: "EDITOR_DRAFT_TOO_LARGE" });
	});

	it("validates the complete patch atomically", () => {
		const valid = validateEditorDraftPatch({
			patch: {
				type: "editor-draft-patch",
				operations: [
					{ op: "set", field: "title", value: "Translated" },
					{ op: "clear", field: "excerpt" },
				],
			},
			collection,
			allowedFields: new Set(["title", "excerpt"]),
		});
		expect(valid).not.toHaveProperty("code");

		const invalid = validateEditorDraftPatch({
			patch: {
				type: "editor-draft-patch",
				operations: [
					{ op: "set", field: "title", value: "Translated" },
					{ op: "set", field: "rating", value: "not an integer" },
				],
			},
			collection,
			allowedFields: new Set(["title", "rating"]),
		});
		expect(invalid).toMatchObject({ code: "EDITOR_DRAFT_INVALID" });
	});
});
