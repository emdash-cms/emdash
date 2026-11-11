import {
	ENTRY_SLUG,
	readField,
	readFields,
	readSlug,
	touchedFields,
	writeField,
} from "@emdash-cms/admin/internal/co-editing";
import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
	buildDocument,
	documentFields,
	layoutFields,
	storedValues,
	type DocumentField,
} from "../../../src/rooms/document.js";
import {
	editorFixtures,
	roundTripThroughSharedDocument,
} from "../../utils/admin-portable-text-round-trip.js";

const title: DocumentField = { slug: "title", type: "string" };
const body: DocumentField = { slug: "body", type: "portableText" };
const summary: DocumentField = { slug: "summary", type: "portableText" };
const tags: DocumentField = { slug: "tags", type: "multiSelect" };
const meta: DocumentField = { slug: "meta", type: "json" };
const count: DocumentField = { slug: "count", type: "integer" };
const featured: DocumentField = { slug: "featured", type: "boolean" };
const related: DocumentField = {
	slug: "related",
	type: "reference",
	validation: { relation: "posts_related" },
};
/** A reference from before relations, which keeps a column holding one entry ID. */
const legacy: DocumentField = { slug: "legacy", type: "reference" };

const fields = [title, body, summary, tags, meta, count, featured, related, legacy];

function entry(
	data: Record<string, unknown>,
	slug: string | null = "post",
	pluginTypes: string[] = [],
) {
	return { data, fields, slug, pluginTypes };
}

function paragraph(key: string, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		children: [{ _type: "span", _key: `${key}-s`, text }],
	};
}

function sync(from: Y.Doc, to: Y.Doc): void {
	Y.applyUpdate(to, Y.encodeStateAsUpdate(from, Y.encodeStateVector(to)));
}

/** Every field the document's transactions touched while `change` ran. */
function touchedBy(doc: Y.Doc, change: () => void): Set<string> {
	const touched = new Set<string>();
	const record = (transaction: Y.Transaction) => {
		for (const field of touchedFields(transaction)) touched.add(field);
	};
	doc.on("afterTransaction", record);
	change();
	doc.off("afterTransaction", record);
	return touched;
}

describe("buildDocument and readField", () => {
	it.each(editorFixtures)(
		"reads back $name as the shared document round trip gives it",
		({ blocks, pluginTypes }) => {
			const doc = buildDocument(entry({ body: blocks }, "post", [...(pluginTypes ?? [])]));

			expect(readField(doc, body)).toEqual(roundTripThroughSharedDocument(blocks, pluginTypes));
		},
	);

	it("lays out rich text as fragments and every other value in one map, without relation references", () => {
		const doc = buildDocument(
			entry({
				title: "Hello",
				body: [paragraph("p1", "One")],
				tags: ["a", "b"],
				meta: { nested: { list: [1, 2] } },
				count: 3,
				featured: false,
				related: "entry-2",
				legacy: "entry-3",
			}),
		);

		expect([...doc.share.keys()].toSorted()).toEqual(["field:body", "field:summary", "fields"]);
		expect(doc.getMap("fields").toJSON()).toEqual({
			title: "Hello",
			tags: ["a", "b"],
			meta: { nested: { list: [1, 2] } },
			count: 3,
			featured: false,
			legacy: "entry-3",
			slug: "post",
		});
		expect(doc.getXmlFragment("field:body").length).toBe(1);
	});

	it("reads every document field back, with absent values as null", () => {
		const data = {
			title: "Hello",
			body: [paragraph("p1", "One")],
			tags: ["a"],
			meta: { a: 1 },
			featured: true,
			related: "entry-2",
			legacy: "entry-3",
		};
		const doc = buildDocument(entry(data));

		expect(readFields(doc, documentFields(fields))).toEqual({
			title: "Hello",
			body: [paragraph("p1", "One")],
			summary: [],
			tags: ["a"],
			meta: { a: 1 },
			count: null,
			featured: true,
			legacy: "entry-3",
			slug: "post",
		});
		expect(readSlug(doc)).toBe("post");
		expect(readSlug(buildDocument(entry(data, null)))).toBeNull();
	});

	it("keys stored values as the document does, leaving relation references out", () => {
		expect(
			storedValues(
				entry(
					{ title: "Hello", related: "entry-2", legacy: "entry-3", other: "not a field" },
					"post",
				),
			),
		).toEqual({
			title: "Hello",
			body: undefined,
			summary: undefined,
			tags: undefined,
			meta: undefined,
			count: undefined,
			featured: undefined,
			legacy: "entry-3",
			slug: "post",
		});
	});

	it("refuses a rich-text value that isn't a list of blocks", () => {
		expect(() => buildDocument(entry({ body: "plain text" }))).toThrow(TypeError);
	});

	it("reads rich text without changing the document, even content the editor schema rejects", () => {
		const doc = buildDocument(entry({ body: [paragraph("p1", "One")] }));
		const comment = new Y.XmlElement("comment");
		comment.insert(0, [new Y.XmlText("kept")]);
		doc.getXmlFragment("field:body").insert(1, [comment]);
		const before = Y.encodeStateAsUpdate(doc);

		readField(doc, body);

		expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
		expect(doc.getXmlFragment("field:body").length).toBe(2);
	});

	it("reads copies of map values, so changing one never changes the document", () => {
		const doc = buildDocument(entry({ tags: ["a"], meta: [{ n: 1 }] }));

		const tagsRead = readField(doc, tags);
		const metaRead = readField(doc, meta);
		if (!Array.isArray(tagsRead) || !Array.isArray(metaRead)) throw new Error("Not lists");
		tagsRead.push("b");
		metaRead[0].n = 2;

		expect(doc.getMap("fields").toJSON()).toMatchObject({ tags: ["a"], meta: [{ n: 1 }] });
	});

	it("refuses to read a shared type a client nested", () => {
		const doc = buildDocument(entry({}));
		doc.getMap("fields").set("meta", new Y.Map());

		expect(() => readField(doc, meta)).toThrow();
	});
});

describe("layoutFields", () => {
	it("reads the fields a stored document holds, whatever the schema says now", () => {
		const built = buildDocument({
			data: { title: "Hi", count: 2, body: [paragraph("a", "Body")] },
			fields: [title, count, body],
			slug: "post",
			pluginTypes: [],
		});
		const doc = new Y.Doc();
		Y.applyUpdate(doc, Y.encodeStateAsUpdate(built));
		doc.getXmlFragment("field:count");

		const layout = layoutFields(doc);

		expect(layout).toContain(ENTRY_SLUG);
		expect(layout.map((field) => field.slug).toSorted()).toEqual([
			"body",
			"count",
			"slug",
			"title",
		]);
		expect(readFields(doc, layout)).toEqual({
			title: "Hi",
			count: 2,
			body: readField(built, body),
			slug: "post",
		});
	});
});

describe("writeField", () => {
	it("keeps the unchanged blocks at both ends, so a concurrent edit to one survives", () => {
		const room = buildDocument(
			entry({
				body: [paragraph("p1", "First"), paragraph("p2", "Middle"), paragraph("p3", "Last")],
			}),
		);
		const fragment = room.getXmlFragment("field:body");
		const [first, , last] = fragment.toArray();
		const client = new Y.Doc();
		sync(room, client);

		const clientFirst = client.getXmlFragment("field:body").get(0) as Y.XmlElement;
		(clientFirst.get(0) as Y.XmlText).insert(5, " edited");
		expect(
			writeField(
				room,
				body,
				[paragraph("p1", "First"), paragraph("p2", "Changed"), paragraph("p3", "Last")],
				[],
				"merge",
			),
		).toBe(true);
		sync(client, room);
		sync(room, client);

		expect(fragment.get(0)).toBe(first);
		expect(fragment.get(2)).toBe(last);
		const merged = [
			paragraph("p1", "First edited"),
			paragraph("p2", "Changed"),
			paragraph("p3", "Last"),
		];
		expect(readField(room, body)).toEqual(merged);
		expect(readField(client, body)).toEqual(merged);
	});

	it("writes in one transaction with the given origin", () => {
		const doc = buildDocument(entry({ body: [paragraph("p1", "One")], title: "Old" }));
		const origins: unknown[] = [];
		doc.on("update", (_update: Uint8Array, origin: unknown) => origins.push(origin));
		const origin = { merge: 1 };

		writeField(doc, body, [paragraph("p1", "One"), paragraph("p2", "Two")], [], origin);
		writeField(doc, title, "New", [], origin);

		expect(origins).toEqual([origin, origin]);
		expect(readField(doc, body)).toEqual([paragraph("p1", "One"), paragraph("p2", "Two")]);
		expect(readField(doc, title)).toBe("New");
	});

	it.each([
		{
			name: "marks the editor can't represent",
			value: [
				{
					_type: "block",
					_key: "p1",
					style: "normal",
					markDefs: [{ _type: "comment", _key: "c1", text: "A note" }],
					children: [{ _type: "span", _key: "s1", text: "Noted", marks: ["c1"] }],
				},
			],
		},
		{ name: "a table the converter refuses", value: [{ _type: "table", _key: "t", rows: "none" }] },
		{ name: "a value that isn't a list of blocks", value: { not: "blocks" } },
	])("refuses rich text with $name and writes nothing", ({ value }) => {
		const doc = buildDocument(entry({ body: [paragraph("p1", "One")] }));
		const before = Y.encodeStateAsUpdate(doc);
		const updates: Uint8Array[] = [];
		doc.on("update", (update: Uint8Array) => updates.push(update));

		expect(writeField(doc, body, value, [], "merge")).toBe(false);

		expect(updates).toEqual([]);
		expect(Y.encodeStateAsUpdate(doc)).toEqual(before);
		expect(readField(doc, body)).toEqual([paragraph("p1", "One")]);
	});

	it("sets, replaces and removes map values, and the slug", () => {
		const doc = buildDocument(entry({ title: "Old", meta: { a: 1 } }));

		writeField(doc, meta, { a: 2 }, [], "merge");
		writeField(doc, title, undefined, [], "merge");
		writeField(doc, ENTRY_SLUG, "renamed", [], "merge");

		expect(readField(doc, meta)).toEqual({ a: 2 });
		expect(doc.getMap("fields").has("title")).toBe(false);
		expect(readField(doc, title)).toBeNull();
		expect(readSlug(doc)).toBe("renamed");
	});
});

describe("touchedFields", () => {
	it("names the map keys a transaction set or removed", () => {
		const doc = buildDocument(entry({ title: "Old", count: 1 }));
		const map = doc.getMap("fields");

		expect(
			touchedBy(doc, () =>
				doc.transact(() => {
					map.set("title", "New");
					map.delete("count");
				}),
			),
		).toEqual(new Set(["title", "count"]));
	});

	it("names the slug", () => {
		const doc = buildDocument(entry({}));

		expect(touchedBy(doc, () => writeField(doc, ENTRY_SLUG, "renamed", [], null))).toEqual(
			new Set(["slug"]),
		);
	});

	it("names a rich-text field for edits nested inside its blocks", () => {
		const doc = buildDocument(
			entry({ body: [paragraph("p1", "One")], summary: [paragraph("s1", "Short")] }),
		);
		const block = doc.getXmlFragment("field:body").get(0) as Y.XmlElement;

		expect(touchedBy(doc, () => (block.get(0) as Y.XmlText).insert(3, " more"))).toEqual(
			new Set(["body"]),
		);
		expect(touchedBy(doc, () => block.setAttribute("textAlign", "center"))).toEqual(
			new Set(["body"]),
		);
		expect(
			touchedBy(doc, () =>
				doc.getXmlFragment("field:summary").insert(1, [new Y.XmlElement("paragraph")]),
			),
		).toEqual(new Set(["summary"]));
	});

	it("names the fields a client's update touches in a document loaded from stored updates", () => {
		const stored = Y.encodeStateAsUpdate(
			buildDocument(entry({ body: [paragraph("p1", "One")], title: "Old" })),
		);
		const room = new Y.Doc();
		Y.applyUpdate(room, stored);
		const client = new Y.Doc();
		Y.applyUpdate(client, stored);
		const before = Y.encodeStateVector(client);

		client.transact(() => {
			client.getXmlFragment("field:body").insert(1, [new Y.XmlElement("paragraph")]);
			client.getMap("fields").set("title", "New");
		});

		expect(
			touchedBy(room, () => Y.applyUpdate(room, Y.encodeStateAsUpdate(client, before))),
		).toEqual(new Set(["body", "title"]));
	});

	it("names the field holding a value a client nested as a shared type", () => {
		const doc = buildDocument(entry({}));
		const nested = new Y.Map<number>();
		doc.getMap("fields").set("meta", nested);

		expect(touchedBy(doc, () => nested.set("a", 1))).toEqual(new Set(["meta"]));
	});

	it("names nothing for a transaction that changes nothing", () => {
		const doc = buildDocument(entry({ title: "Same" }));

		expect(touchedBy(doc, () => doc.transact(() => {}))).toEqual(new Set());
	});
});
