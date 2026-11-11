import { readField, readFields } from "@emdash-cms/admin/internal/co-editing";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import type { ContentWrite } from "../../../src/api/content-save.js";
import {
	buildDocument,
	documentFields,
	storedValues,
	type DocumentField,
} from "../../../src/rooms/document.js";
import { hashValue } from "../../../src/rooms/hash.js";
import {
	decideField,
	hashValues,
	initialMergeBase,
	isDocumentChanged,
	mergeBaseAfterSave,
	type FieldDecision,
} from "../../../src/rooms/merge.js";
import type { LoadedEntry, MergeBase } from "../../../src/rooms/types.js";

const title: DocumentField = { slug: "title", type: "string" };
const body: DocumentField = { slug: "body", type: "portableText" };
const meta: DocumentField = { slug: "meta", type: "json" };
const fields = [title, body, meta];

type Entry = Pick<LoadedEntry, "rev" | "data" | "fields" | "slug" | "pluginTypes">;

function loaded(rev: string, data: Record<string, unknown>, slug: string | null = "post"): Entry {
	return { rev, data, fields, slug, pluginTypes: [] };
}

function paragraph(key: string, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		children: [{ _type: "span", _key: `${key}-s`, text }],
	};
}

/** Blocks without keys, which the converter derives, so they don't round-trip byte for byte. */
function keyless(text: string) {
	return [{ _type: "block", style: "normal", children: [{ _type: "span", text }] }];
}

function initialize(entry: Entry): { doc: Y.Doc; base: MergeBase } {
	const doc = buildDocument(entry);
	const base = initialMergeBase(
		entry.rev,
		storedValues(entry),
		readFields(doc, documentFields(entry.fields)),
	);
	return { doc, base };
}

describe("decideField", () => {
	const rows: Array<[boolean, boolean, boolean, boolean, FieldDecision]> = [
		[false, false, true, false, "none"],
		[false, false, true, true, "none"],
		[false, false, false, false, "none"],
		[false, false, false, true, "none"],
		[false, true, true, false, "none"],
		[false, true, true, true, "none"],
		[false, true, false, false, "none"],
		[false, true, false, true, "none"],
		[true, false, true, false, "write"],
		[true, false, true, true, "write"],
		[true, false, false, false, "write"],
		[true, false, false, true, "write"],
		[true, true, true, false, "keep-document"],
		[true, true, true, true, "keep-document"],
		[true, true, false, false, "keep-document"],
		[true, true, false, true, "start-over"],
	];

	it.each(rows)(
		"stored changed %s, document changed %s, open %s, values differ %s: %s",
		(storedChanged, documentChanged, open, valuesDiffer, decision) => {
			expect(decideField({ storedChanged, documentChanged, valuesDiffer, open })).toBe(decision);
		},
	);
});

describe("isDocumentChanged", () => {
	it("is true for a cleared document hash, touched or not", () => {
		expect(isDocumentChanged(null, false, "a")).toBe(true);
		expect(isDocumentChanged(null, true, "a")).toBe(true);
	});

	it("compares the hash of a value an update touched", () => {
		expect(isDocumentChanged("a", true, "b")).toBe(true);
		expect(isDocumentChanged("a", true, "a")).toBe(false);
	});

	it("is false for a value no update touched", () => {
		expect(isDocumentChanged("a", false, "b")).toBe(false);
	});
});

describe("merge base", () => {
	it("at initialization builds an absent rich-text field that a save won't send", () => {
		const { doc, base } = initialize(loaded("r1", { title: "Hello" }));

		expect(base.rev).toBe("r1");
		expect(base.stored.body).toBe(hashValue(null));
		expect(base.document.body).toBe(hashValue([]));
		expect(readField(doc, body)).toEqual([]);
	});

	it("at initialization hashes the document as it serializes and the entry as it's stored", () => {
		const entry = loaded("r1", { title: "Hello", body: keyless("Not byte for byte") });
		const { doc, base } = initialize(entry);

		expect(base.stored).toEqual(hashValues(storedValues(entry)));
		expect(base.document.body).toBe(hashValue(readField(doc, body)));
		expect(base.document.body).not.toBe(base.stored.body);
	});

	it("after a save takes stored hashes from the write and document hashes from what was sent", () => {
		const entry = loaded("r1", { title: "Hello", body: [paragraph("p1", "One")], meta: { a: 1 } });
		const { base } = initialize(entry);
		const sent = { title: "Hello " };

		const hooked = { ...entry.data, title: "Hello", meta: { a: 1, hooked: true } };
		const saved = mergeBaseAfterSave(base, { data: sent }, { rev: "r2", data: hooked });

		expect(saved.rev).toBe("r2");
		expect(saved.stored.title).toBe(hashValue("Hello"));
		expect(saved.document.title).toBe(hashValue("Hello "));
		expect(saved.stored.meta).toBe(hashValue({ a: 1, hooked: true }));
		expect(saved.document.meta).toBe(base.document.meta);
	});

	it("after a save takes both slug hashes from the slug sent, never from the write", () => {
		const { base } = initialize(loaded("r1", { title: "Hello" }));
		const write = (rev: string, slug: string): ContentWrite => ({
			rev,
			data: { title: "Hello" },
			slug,
		});

		const renamed = mergeBaseAfterSave(
			base,
			{ data: {}, slug: "my-post" },
			write("r2", "my-post-2"),
		);
		const untouched = mergeBaseAfterSave(
			renamed,
			{ data: { title: "Hello" } },
			write("r3", "my-post-3"),
		);
		const cleared = mergeBaseAfterSave(
			untouched,
			{ data: {}, slug: null },
			write("r4", "my-post-3"),
		);

		expect(renamed.stored.slug).toBe(hashValue("my-post"));
		expect(renamed.document.slug).toBe(hashValue("my-post"));
		expect(untouched.stored.slug).toBe(hashValue("my-post"));
		expect(untouched.document.slug).toBe(hashValue("my-post"));
		expect(cleared.stored.slug).toBe(hashValue(null));
		expect(cleared.document.slug).toBe(hashValue(null));
	});
});
