import {
	portableTextToProsemirror as adminPortableTextToProsemirror,
	prosemirrorToPortableText as adminProsemirrorToPortableText,
} from "@emdash-cms/admin/internal/portable-text";
import { describe, expect, it } from "vitest";

import { portableTextToProsemirror as corePortableTextToProsemirror } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText as coreProsemirrorToPortableText } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type {
	PortableTextTextBlock,
	ProseMirrorDocument,
	ProseMirrorNode,
} from "../../../src/content/converters/types.js";

type MarkDef = Record<string, unknown> & { _key: string; _type: string };
type Span = { _key: string; _type: "span"; text: string; marks?: string[] };
type ResultBlock = PortableTextTextBlock & { markDefs?: MarkDef[] };
type PortableTextConverter = {
	toProsemirror: (blocks: PortableTextTextBlock[]) => ProseMirrorDocument;
	toPortableText: (doc: ProseMirrorDocument) => ResultBlock[];
};

const adapters: Array<[string, PortableTextConverter]> = [
	[
		"admin",
		{
			toProsemirror: (blocks) => adminPortableTextToProsemirror(blocks) as ProseMirrorDocument,
			toPortableText: (doc) => adminProsemirrorToPortableText(doc) as ResultBlock[],
		},
	],
	[
		"core",
		{
			toProsemirror: (blocks) => corePortableTextToProsemirror(blocks, { preserveIdentity: true }),
			toPortableText: (doc) => coreProsemirrorToPortableText(doc) as ResultBlock[],
		},
	],
];

const href = "https://example.com/gemini/";

function block(
	markDefs: MarkDef[],
	children: Array<Pick<Span, "_key" | "text"> & { marks?: string[] }>,
): PortableTextTextBlock {
	return {
		_type: "block",
		_key: "b1",
		style: "normal",
		markDefs,
		children: children.map((child) => ({ _type: "span", ...child })),
	};
}

function paragraph(doc: ProseMirrorDocument): ProseMirrorNode[] {
	return doc.content[0]!.content!;
}

function addLinkTo(doc: ProseMirrorDocument, indexes: number[]): void {
	const nodes = paragraph(doc);
	const attrs = nodes[1]!.marks!.find((mark) => mark.type === "link")!.attrs;
	for (const index of indexes) {
		nodes[index]!.marks = [...(nodes[index]!.marks ?? []), { type: "link", attrs }];
	}
}

function linkKeys(result: ResultBlock): Array<string | undefined> {
	return result.children.map((child) =>
		child.marks?.find((mark) =>
			result.markDefs?.some((def) => def._key === mark && def._type === "link"),
		),
	);
}

function linkDefs(result: ResultBlock): MarkDef[] {
	return (result.markDefs ?? []).filter((def) => def._type === "link");
}

describe.each(adapters)("adjacent link mark definitions (%s)", (_name, adapter) => {
	it.each([undefined, false])("joins freshly linked text when blank is %s", (blank) => {
		const stored = block(
			[{ _key: "A", _type: "link", href, ...(blank === undefined ? {} : { blank }) }],
			[
				{ _key: "s1", text: "left" },
				{ _key: "s2", text: "middle", marks: ["A"] },
				{ _key: "s3", text: "right" },
			],
		);
		const doc = adapter.toProsemirror([stored]);
		addLinkTo(doc, [0, 2]);
		const result = adapter.toPortableText(doc)[0]!;

		expect(linkKeys(result)).toEqual(["A", "A", "A"]);
		expect(linkDefs(result)).toHaveLength(1);
		expect(result.children.map((child) => child._key)).toEqual(["s1", "s2", "s3"]);
		expect(adapter.toPortableText(adapter.toProsemirror([result]))).toEqual([result]);
	});

	it("collapses an already split run to the first stored key", () => {
		const stored = block(
			[
				{ _key: "A", _type: "link", href, blank: false },
				{ _key: "B", _type: "link", href, blank: false },
				{ _key: "C", _type: "link", href, blank: false },
			],
			[
				{ _key: "s1", text: "left", marks: ["A"] },
				{ _key: "s2", text: "middle", marks: ["B"] },
				{ _key: "s3", text: "right", marks: ["C"] },
			],
		);
		const result = adapter.toPortableText(adapter.toProsemirror([stored]))[0]!;
		expect(linkKeys(result)).toEqual(["A", "A", "A"]);
		expect(linkDefs(result)).toHaveLength(1);
	});

	it("joins through different decorator marks", () => {
		const stored = block(
			[{ _key: "A", _type: "link", href, blank: false }],
			[
				{ _key: "s1", text: "left", marks: ["strong"] },
				{ _key: "s2", text: "middle", marks: ["A"] },
				{ _key: "s3", text: "right", marks: ["em"] },
			],
		);
		const doc = adapter.toProsemirror([stored]);
		addLinkTo(doc, [0, 2]);
		const result = adapter.toPortableText(doc)[0]!;
		expect(linkKeys(result)).toEqual(["A", "A", "A"]);
		expect(result.children[0]!.marks).toContain("strong");
		expect(result.children[2]!.marks).toContain("em");
	});

	it("keeps unequal links apart and merges equivalent metadata regardless of property order", () => {
		const metadata = { nested: { first: 1, second: 2 }, title: "same" };
		const reordered = { title: "same", nested: { second: 2, first: 1 } };
		const stored = block(
			[
				{ _key: "A", _type: "link", href, blank: false, ...metadata },
				{
					_key: "B",
					_type: "link",
					href,
					blank: false,
					nested: { ...reordered.nested },
					title: reordered.title,
				},
				{ _key: "C", _type: "link", href: "https://example.com/other", blank: false, ...metadata },
				{ _key: "D", _type: "link", href, blank: true, ...metadata },
			],
			[
				{ _key: "s1", text: "one", marks: ["A"] },
				{ _key: "s2", text: "two", marks: ["B"] },
				{ _key: "s3", text: "three", marks: ["C"] },
				{ _key: "s4", text: "four", marks: ["D"] },
			],
		);
		const result = adapter.toPortableText(adapter.toProsemirror([stored]))[0]!;
		expect(linkKeys(result)).toEqual(["A", "A", "C", "D"]);
		expect(linkDefs(result)).toHaveLength(3);
	});

	it.each([{ title: "different" }, { nested: { first: 1, second: 3 } }])(
		"does not merge links with different metadata: %j",
		(difference) => {
			const stored = block(
				[
					{ _key: "A", _type: "link", href, title: "same", nested: { first: 1, second: 2 } },
					{
						_key: "B",
						_type: "link",
						href,
						title: "same",
						nested: { first: 1, second: 2 },
						...difference,
					},
				],
				[
					{ _key: "s1", text: "one", marks: ["A"] },
					{ _key: "s2", text: "two", marks: ["B"] },
				],
			);
			const result = adapter.toPortableText(adapter.toProsemirror([stored]))[0]!;
			expect(linkKeys(result)).toEqual(["A", "B"]);
			expect(linkDefs(result)).toEqual(stored.markDefs);
		},
	);

	it("rewrites only the adjacent run when a generated definition is shared elsewhere", () => {
		const stored = block(
			[{ _key: "A", _type: "link", href }],
			[
				{ _key: "s1", text: "left" },
				{ _key: "s2", text: "middle", marks: ["A"] },
				{ _key: "s3", text: "gap" },
				{ _key: "s4", text: "separate" },
			],
		);
		const doc = adapter.toProsemirror([stored]);
		addLinkTo(doc, [0, 3]);
		const result = adapter.toPortableText(doc)[0]!;
		const keys = linkKeys(result);
		expect(keys.slice(0, 3)).toEqual(["A", "A", undefined]);
		expect(keys[3]).toBeDefined();
		expect(keys[3]).not.toBe("A");
		expect(linkDefs(result)).toHaveLength(2);
	});

	it("does not merge equal links separated by unlinked text and is idempotent", () => {
		const stored = block(
			[
				{ _key: "A", _type: "link", href, blank: false },
				{ _key: "B", _type: "link", href, blank: false },
			],
			[
				{ _key: "s1", text: "one", marks: ["A"] },
				{ _key: "s2", text: "gap" },
				{ _key: "s3", text: "two", marks: ["B"] },
			],
		);
		const first = adapter.toPortableText(adapter.toProsemirror([stored]));
		const second = adapter.toPortableText(adapter.toProsemirror(first));
		expect(linkKeys(first[0]!)).toEqual(["A", undefined, "B"]);
		expect(linkDefs(first[0]!)).toHaveLength(2);
		expect(second).toEqual(first);
	});
});
