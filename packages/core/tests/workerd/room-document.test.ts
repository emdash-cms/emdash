import { readFields, writeField } from "@emdash-cms/admin/internal/co-editing";
import { describe, expect, it } from "vitest";

import { buildDocument, documentFields } from "../../src/rooms/document.js";
import { hashValue } from "../../src/rooms/hash.js";

const span = (key: string, text: string, marks: string[] = []) => ({
	_type: "span",
	_key: key,
	text,
	marks,
});

const PLUGIN_TYPES = ["callout"];

const FIELDS = [
	{ slug: "title", type: "string" as const },
	{ slug: "body", type: "portableText" as const },
	{ slug: "related", type: "reference" as const, validation: { relation: "posts_related" } },
];

const ENTRY_DATA = {
	title: "Hello",
	related: "01RELATED",
	body: [
		{
			_type: "block",
			_key: "p1",
			style: "normal",
			markDefs: [{ _type: "link", _key: "l1", href: "https://example.com" }],
			children: [
				span("p1a", "Plain, "),
				span("p1b", "bold", ["strong"]),
				span("p1c", " and "),
				span("p1d", "a link", ["l1"]),
				span("p1e", "."),
			],
		},
		{ _type: "block", _key: "h1", style: "h2", markDefs: [], children: [span("h1a", "A heading")] },
		{
			_type: "block",
			_key: "li1",
			style: "normal",
			listItem: "bullet",
			level: 1,
			markDefs: [],
			children: [span("li1a", "First item")],
		},
		{
			_type: "block",
			_key: "li2",
			style: "normal",
			listItem: "bullet",
			level: 2,
			markDefs: [],
			children: [span("li2a", "Nested item", ["em"])],
		},
		{
			_type: "block",
			_key: "li3",
			style: "normal",
			listItem: "number",
			level: 1,
			markDefs: [],
			children: [span("li3a", "Numbered")],
		},
		{ _type: "callout", _key: "c1", id: "callout-1", tone: "info", text: "A plugin block" },
		{
			_type: "block",
			_key: "q1",
			style: "blockquote",
			markDefs: [],
			children: [span("q1a", "Quoted text")],
		},
	],
};

const MERGED_BODY = [
	{
		...ENTRY_DATA.body[0],
		children: [...ENTRY_DATA.body[0]!.children, span("p1f", " Appended from outside.")],
	},
	ENTRY_DATA.body[2],
	ENTRY_DATA.body[3],
	{ ...ENTRY_DATA.body[4], children: [span("li3a", "Numbered, edited")] },
	ENTRY_DATA.body[5],
	ENTRY_DATA.body[6],
	{
		_type: "block",
		_key: "n1",
		style: "normal",
		markDefs: [],
		children: [span("n1a", "A new paragraph")],
	},
];

/** What Node.js serializes after the same build and merge write. */
const NODE_FIELDS = {
	title: "Hello again",
	body: [
		{
			_type: "block",
			_key: "p1",
			style: "normal",
			children: [
				{
					_type: "span",
					_key: "p1a",
					text: "Plain, ",
				},
				{
					_type: "span",
					_key: "p1b",
					text: "bold",
					marks: ["strong"],
				},
				{
					_type: "span",
					_key: "p1c",
					text: " and ",
				},
				{
					_type: "span",
					_key: "p1d",
					text: "a link",
					marks: ["l1"],
				},
				{
					_type: "span",
					_key: "p1e",
					text: ".",
				},
				{
					_type: "span",
					_key: "p1f",
					text: " Appended from outside.",
				},
			],
			markDefs: [
				{
					_type: "link",
					_key: "l1",
					href: "https://example.com",
				},
			],
		},
		{
			_type: "block",
			_key: "li1",
			style: "normal",
			listItem: "bullet",
			level: 1,
			children: [
				{
					_type: "span",
					_key: "li1a",
					text: "First item",
				},
			],
		},
		{
			_type: "block",
			_key: "li2",
			style: "normal",
			listItem: "bullet",
			level: 2,
			children: [
				{
					_type: "span",
					_key: "li2a",
					text: "Nested item",
					marks: ["em"],
				},
			],
		},
		{
			_type: "block",
			_key: "li3",
			style: "normal",
			listItem: "number",
			level: 1,
			listId: "legacy:root:3:li3",
			listStart: 1,
			children: [
				{
					_type: "span",
					_key: "li3a",
					text: "Numbered, edited",
				},
			],
		},
		{
			_type: "callout",
			_key: "c1",
			id: "callout-1",
			tone: "info",
			text: "A plugin block",
		},
		{
			_type: "block",
			_key: "q1",
			style: "blockquote",
			children: [
				{
					_type: "span",
					_key: "q1a",
					text: "Quoted text",
				},
			],
		},
		{
			_type: "block",
			_key: "n1",
			style: "normal",
			children: [
				{
					_type: "span",
					_key: "n1a",
					text: "A new paragraph",
				},
			],
		},
	],
	slug: "hello-world",
};
const NODE_HASH = "8921e7952def155dc798abace11cb638afbb3ccb7918ff3d9b0721adc2201a62";

describe("room documents in workerd", () => {
	it("serializes a merged document as Node.js does", () => {
		const doc = buildDocument({
			data: ENTRY_DATA,
			fields: FIELDS,
			slug: "hello-world",
			pluginTypes: PLUGIN_TYPES,
		});
		writeField(doc, { slug: "body", type: "portableText" }, MERGED_BODY, PLUGIN_TYPES, "merge");
		writeField(doc, { slug: "title", type: "string" }, "Hello again", PLUGIN_TYPES, "merge");
		const fields = readFields(doc, documentFields(FIELDS));
		expect(fields).toEqual(NODE_FIELDS);
		expect(hashValue(fields)).toBe(NODE_HASH);
	});
});
