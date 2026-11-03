import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
	createContentEditorDraft,
	type DraftChanges,
	type DraftFieldDescriptor,
	type EditorDraftState,
} from "../../src/lib/content-editor-draft";
import type { ContentEditorDraft } from "../../src/lib/content-editor-panels";

function textBlocks(text: string) {
	return [
		{
			_type: "block",
			_key: "b1",
			style: "normal",
			markDefs: [],
			children: [{ _type: "span", _key: "s1", text, marks: [] }],
		},
	];
}

const FIELDS: Record<string, DraftFieldDescriptor> = {
	title: { kind: "string", type: "string", label: "Title", required: true, translatable: true },
	excerpt: { kind: "richText", type: "text", label: "Excerpt", validation: { maxLength: 160 } },
	count: { kind: "number", type: "number", label: "Count" },
	rank: { kind: "number", type: "integer", label: "Rank" },
	featured: { kind: "boolean", type: "boolean", label: "Featured" },
	cover: { kind: "image", type: "image", label: "Cover" },
	data: { kind: "json", type: "json", label: "Data" },
	body: { kind: "portableText", type: "portableText", label: "Body" },
	author: {
		kind: "reference",
		type: "reference",
		label: "Author",
		validation: { relation: "post_author", targetCollection: "people" },
	},
	legacy: { kind: "reference", type: "reference", label: "Legacy" },
	future: { kind: "unsupported", type: "string", label: "Future", unsupportedType: {} },
	untyped: { kind: "string", label: "Untyped" },
};

function makeState(overrides: Partial<EditorDraftState> = {}): EditorDraftState {
	return {
		acceptsEdits: true,
		fields: FIELDS,
		formData: { title: "Hello", featured: 1, body: textBlocks("Body") },
		slug: "hello",
		seo: { title: "", description: "Meta" },
		pluginBlocks: [],
		rendersWidget: () => false,
		...overrides,
	};
}

/** A draft over a state the test changes between calls, and the writes it hands the editor. */
function setup(overrides: Partial<EditorDraftState> = {}) {
	let state: EditorDraftState | null = makeState(overrides);
	const apply = vi.fn<(changes: DraftChanges) => void>();
	const draft = createContentEditorDraft({ read: () => state, apply });
	return {
		draft,
		apply,
		update(next: Partial<EditorDraftState>) {
			state = { ...state!, ...next };
		},
		retire() {
			state = null;
		},
	};
}

function patchWith(draft: ContentEditorDraft, operations: unknown) {
	const { revision } = draft.get();
	return draft.patch(operations as never, { expectedRevision: revision });
}

afterEach(() => {
	i18n.activate("en");
});

describe("createContentEditorDraft", () => {
	it("lists the collection fields in schema order, then the slug and the SEO text", () => {
		const { draft } = setup();
		expect(draft.get().fieldDefinitions.map((field) => field.slug)).toEqual([
			"title",
			"excerpt",
			"count",
			"rank",
			"featured",
			"cover",
			"data",
			"body",
			"legacy",
			"slug",
			"seo.title",
			"seo.description",
		]);
	});

	it("leaves out bound references, unsupported fields and fields without a schema type", () => {
		const { fields } = setup().draft.get();
		expect(fields).not.toHaveProperty("author");
		expect(fields).not.toHaveProperty("future");
		expect(fields).not.toHaveProperty("untyped");
	});

	it("leaves out the SEO keys in a collection without SEO", () => {
		const { fields } = setup({ seo: null }).draft.get();
		expect(Object.keys(fields)).toContain("slug");
		expect(fields).not.toHaveProperty("seo.title");
		expect(fields).not.toHaveProperty("seo.description");
	});

	it("describes collection fields by schema type and the extra keys as the editor shows them", () => {
		const definitions = setup().draft.get().fieldDefinitions;
		const byKey = Object.fromEntries(definitions.map((field) => [field.slug, field]));
		expect(byKey.title).toEqual({
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
			translatable: true,
		});
		expect(byKey.excerpt).toEqual({
			slug: "excerpt",
			label: "Excerpt",
			type: "text",
			required: false,
			translatable: false,
			validation: { maxLength: 160 },
		});
		expect(byKey.rank?.type).toBe("integer");
		expect(byKey.slug).toEqual({
			slug: "slug",
			label: "Slug",
			type: "slug",
			required: false,
			translatable: true,
		});
		expect(byKey["seo.title"]).toEqual({
			slug: "seo.title",
			label: "SEO Title",
			type: "string",
			required: false,
			translatable: true,
			validation: { maxLength: 200 },
		});
		expect(byKey["seo.description"]).toEqual({
			slug: "seo.description",
			label: "Meta Description",
			type: "text",
			required: false,
			translatable: true,
			validation: { maxLength: 500 },
		});
	});

	it("labels the extra keys in the admin's active language", () => {
		i18n.load("fr", {
			[msg`Slug`.id]: "Identifiant",
			[msg`SEO Title`.id]: "Titre SEO",
			[msg`Meta Description`.id]: "Méta-description",
		});
		i18n.activate("fr");
		const labels = setup()
			.draft.get()
			.fieldDefinitions.filter((field) => !(field.slug in FIELDS))
			.map((field) => field.label);
		expect(labels).toEqual(["Identifiant", "Titre SEO", "Méta-description"]);
	});

	it("hands out copies, so changing a snapshot changes neither the form nor the next snapshot", () => {
		const formData = { title: "Hello", body: textBlocks("Body") };
		const { draft } = setup({ formData });
		const snapshot = draft.get();
		(snapshot.fields.body as Array<{ _key: string }>)[0]!._key = "changed";
		snapshot.fieldDefinitions[1]!.validation!.maxLength = 1;
		expect(formData.body[0]?._key).toBe("b1");
		expect(FIELDS.excerpt?.validation).toEqual({ maxLength: 160 });
		const next = draft.get();
		expect((next.fields.body as Array<{ _key: string }>)[0]?._key).toBe("b1");
		expect(next.fieldDefinitions[1]?.validation).toEqual({ maxLength: 160 });
		expect(next.revision).toBe(snapshot.revision);
	});

	it("reports a missing value, an empty slug and empty SEO text as null, and keeps an empty string", () => {
		const { fields } = setup({
			formData: { title: "" },
			slug: "",
			seo: { title: "", description: "" },
		}).draft.get();
		expect(fields.title).toBe("");
		expect(fields.count).toBeNull();
		expect(fields.slug).toBeNull();
		expect(fields["seo.title"]).toBeNull();
		expect(fields["seo.description"]).toBeNull();
	});

	it("keeps the revision while the values are the same, and moves it when any of them changes", () => {
		const { draft, update } = setup();
		const first = draft.get().revision;
		update({ formData: { title: "Hello", featured: 1, body: textBlocks("Body") } });
		expect(draft.get().revision).toBe(first);

		update({ formData: { title: "Changed", featured: 1, body: textBlocks("Body") } });
		const afterField = draft.get().revision;
		expect(afterField).not.toBe(first);
		update({ slug: "changed" });
		const afterSlug = draft.get().revision;
		expect(afterSlug).not.toBe(afterField);
		update({ seo: { title: "", description: "Changed" } });
		expect(draft.get().revision).not.toBe(afterSlug);
	});

	it("gives two draft objects different revisions for the same values", () => {
		expect(setup().draft.get().revision).not.toBe(setup().draft.get().revision);
	});

	it("checks staleness first, then whether the editor accepts edits, then the operations", () => {
		const { draft, update } = setup();
		const { revision } = draft.get();
		update({ acceptsEdits: false, slug: "moved" });
		expect(draft.patch([], { expectedRevision: revision })).toMatchObject({
			ok: false,
			code: "EDITOR_DRAFT_STALE",
		});
		expect(draft.patch([], { expectedRevision: draft.get().revision })).toMatchObject({
			ok: false,
			code: "EDITOR_DRAFT_READ_ONLY",
		});
		update({ acceptsEdits: true });
		expect(draft.patch([], { expectedRevision: draft.get().revision })).toMatchObject({
			ok: false,
			code: "EDITOR_DRAFT_INVALID",
		});
	});

	it("reads as retired and refuses every patch once the editor no longer shows the entry", () => {
		const { draft, apply, retire } = setup();
		const { revision } = draft.get();
		retire();
		expect(draft.get()).toEqual({ revision: "", readOnly: true, fields: {}, fieldDefinitions: [] });
		expect(
			draft.patch([{ op: "set", field: "title", value: "Late" }], { expectedRevision: revision }),
		).toMatchObject({ ok: false, code: "EDITOR_DRAFT_STALE" });
		expect(apply).not.toHaveBeenCalled();
	});

	it.each([
		["an empty list", []],
		["something other than a list", { op: "set", field: "title", value: "Hi" }],
		["an unknown operation", [{ op: "merge", field: "title", value: "Hi" }]],
		["an operation without a field", [{ op: "clear" }]],
		[
			"two operations on one field",
			[
				{ op: "set", field: "title", value: "Hi" },
				{ op: "clear", field: "title" },
			],
		],
		["a field the collection doesn't have", [{ op: "set", field: "nope", value: "Hi" }]],
		["a bound reference", [{ op: "set", field: "author", value: "person_1" }]],
		["an unsupported field", [{ op: "set", field: "future", value: "Hi" }]],
		["clearing the slug", [{ op: "clear", field: "slug" }]],
		["an empty slug", [{ op: "set", field: "slug", value: "" }]],
		["a null slug", [{ op: "set", field: "slug", value: null }]],
		[
			"an SEO title over 200 characters",
			[{ op: "set", field: "seo.title", value: "x".repeat(201) }],
		],
		[
			"a meta description over 500 characters",
			[{ op: "set", field: "seo.description", value: "x".repeat(501) }],
		],
		["an undefined value", [{ op: "set", field: "title", value: undefined }]],
		["a BigInt", [{ op: "set", field: "data", value: 1n }]],
		["a number for a string", [{ op: "set", field: "title", value: 1 }]],
		["NaN for a number", [{ op: "set", field: "count", value: Number.NaN }]],
		["1.5 for an integer", [{ op: "set", field: "rank", value: 1.5 }]],
		["2 for a boolean", [{ op: "set", field: "featured", value: 2 }]],
		["an array for an image", [{ op: "set", field: "cover", value: [] }]],
		["a block without _type", [{ op: "set", field: "body", value: [{ text: "Hi" }] }]],
		[
			"a mark the rich text editor doesn't support",
			[
				{
					op: "set",
					field: "body",
					value: [
						{
							_type: "block",
							_key: "b1",
							markDefs: [],
							children: [{ _type: "span", _key: "s1", text: "Hi", marks: ["highlight"] }],
						},
					],
				},
			],
		],
		[
			"a block the converter can't load",
			[{ op: "set", field: "body", value: [{ _type: "block" }] }],
		],
	])("refuses %s as invalid without writing anything", (_case, operations) => {
		const { draft, apply } = setup();
		expect(patchWith(draft, operations)).toMatchObject({ ok: false, code: "EDITOR_DRAFT_INVALID" });
		expect(apply).not.toHaveBeenCalled();
	});

	it("names the operation and the field in an invalid patch's message", () => {
		const result = patchWith(setup().draft, [
			{ op: "set", field: "title", value: "Fine" },
			{ op: "set", field: "rank", value: 1.5 },
		]);
		expect(result).toMatchObject({
			ok: false,
			message: expect.stringContaining('Operation 2 (set "rank")'),
		});
	});

	it("skips the rich text check for a field a plugin widget renders", () => {
		const unloadable = [{ op: "set", field: "body", value: [{ _type: "block" }] }];
		const withWidget = setup({ rendersWidget: (field) => field.kind === "portableText" });
		expect(patchWith(withWidget.draft, unloadable)).toEqual({ ok: true });
	});

	it("takes null for every field but the slug, and 0 or 1 for a boolean", () => {
		const { draft, apply } = setup();
		expect(
			patchWith(draft, [
				{ op: "set", field: "title", value: null },
				{ op: "set", field: "cover", value: null },
				{ op: "set", field: "seo.title", value: null },
				{ op: "set", field: "featured", value: 0 },
			]),
		).toEqual({ ok: true });
		expect(apply).toHaveBeenLastCalledWith({
			fields: { title: null, cover: null, featured: 0 },
			seo: { title: "" },
		});
	});

	it("hands the editor JSON copies, with the slug and SEO text apart from the fields", () => {
		const { draft, apply } = setup();
		const cover = { id: "media_1", alt: "Cover", taken: new Date("2026-01-01T00:00:00Z") };
		expect(
			patchWith(draft, [
				{ op: "set", field: "cover", value: cover },
				{ op: "clear", field: "excerpt" },
				{ op: "set", field: "slug", value: "bonjour" },
				{ op: "set", field: "seo.title", value: "Bonjour" },
				{ op: "clear", field: "seo.description" },
			]),
		).toEqual({ ok: true });
		const changes = apply.mock.lastCall![0];
		expect(changes).toEqual({
			fields: {
				cover: { id: "media_1", alt: "Cover", taken: "2026-01-01T00:00:00.000Z" },
				excerpt: null,
			},
			slug: "bonjour",
			seo: { title: "Bonjour", description: "" },
		});
		expect(changes.fields.cover).not.toBe(cover);
	});

	it("refuses rather than throws for a missing options argument or operations that aren't objects", () => {
		const { draft } = setup();
		const loose = draft as unknown as { patch(...args: unknown[]): unknown };
		expect(loose.patch([{ op: "set", field: "title", value: "Hi" }])).toMatchObject({
			ok: false,
			code: "EDITOR_DRAFT_STALE",
		});
		expect(loose.patch([null, "set", 4], { expectedRevision: draft.get().revision })).toMatchObject(
			{ ok: false, code: "EDITOR_DRAFT_INVALID" },
		);
		expect(loose.patch(undefined, { expectedRevision: draft.get().revision })).toMatchObject({
			ok: false,
			code: "EDITOR_DRAFT_INVALID",
		});
	});
});
