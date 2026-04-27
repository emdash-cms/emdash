/**
 * Cross-Implementation cssClasses Parity Tests
 *
 * EmDash currently has THREE independent ProseMirror ↔ Portable Text
 * converter implementations:
 *
 *   1. `packages/core/src/content/converters/*`            (canonical, Node)
 *   2. `packages/admin/src/components/PortableTextEditor`  (admin TipTap)
 *   3. `packages/core/src/components/InlinePortableTextEditor` (visual editor)
 *
 * Every cssClasses-related fix has to land in all three or the editors drift
 * from one another and silently corrupt content on save. This file pins the
 * shapes the *core* and *inline* converters must agree on for a battery of
 * representative documents. The admin counterpart lives in
 * `packages/admin/tests/editor/css-classes-conversion.test.ts` (it can't be
 * imported here without pulling React into a Node test, so the parity check
 * for admin happens by mirroring the same input/output pairs in both files).
 *
 * If you change one converter, run BOTH files. If a new shape is added,
 * mirror it into all three suites.
 */
import { describe, expect, it } from "vitest";

import {
	_pmToPortableText as inlinePmToPt,
	_portableTextToPM as inlinePtToPm,
} from "../../../src/components/InlinePortableTextEditor.js";
import { portableTextToProsemirror as coreToPm } from "../../../src/content/converters/portable-text-to-prosemirror.js";
import { prosemirrorToPortableText as coreToPt } from "../../../src/content/converters/prosemirror-to-portable-text.js";
import type { ProseMirrorDocument } from "../../../src/content/converters/types.js";

const WS_RE = /\s+/;
const compareStrings = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const sortTokens = (s: string | undefined): string[] =>
	(s ?? "").split(WS_RE).filter(Boolean).toSorted(compareStrings);

/** Strip random keys so we can compare structural shapes. */
function stripKeys<T>(value: T): T {
	if (Array.isArray(value)) {
		return value.map(stripKeys) as unknown as T;
	}
	if (value && typeof value === "object") {
		const out: Record<string, unknown> = {};
		for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
			if (k === "_key") continue;
			out[k] = stripKeys(v);
		}
		return out as T;
	}
	return value;
}

/** Drop markDef references from spans so we can compare across implementations
 * (each converter generates its own random keys for markDefs). */
function normalizeBlocks(blocks: unknown): unknown {
	const cloned = stripKeys(blocks) as Array<Record<string, unknown>>;
	return cloned.map((block) => {
		const next = { ...block };
		// Replace markDefs and span markRefs with sorted, key-less shapes so
		// the parity check is order-agnostic.
		if (Array.isArray(next.markDefs)) {
			next.markDefs = (next.markDefs as Array<Record<string, unknown>>)
				.map(({ _key: _, ...rest }) => rest)
				.toSorted((a, b) => compareStrings(JSON.stringify(a), JSON.stringify(b)));
		}
		if (Array.isArray(next.children)) {
			next.children = (next.children as Array<Record<string, unknown>>).map((span) => {
				const cleaned = { ...span };
				if (Array.isArray(cleaned.marks)) {
					// Mark references are random keys; replace with the count for
					// shape comparison (the per-implementation tests verify the
					// markDef itself).
					cleaned.marks = `<${(cleaned.marks as unknown[]).length}>`;
				}
				return cleaned;
			});
		}
		return next;
	});
}

const FIXTURES: Array<{ name: string; doc: ProseMirrorDocument }> = [
	{
		name: "plain paragraph with cssClasses",
		doc: {
			type: "doc",
			content: [
				{
					type: "paragraph",
					attrs: { cssClasses: "lead" },
					content: [{ type: "text", text: "Hello" }],
				},
			],
		},
	},
	{
		name: "blockquote with outer cssClasses, no inner",
		doc: {
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: { cssClasses: "card" },
					content: [{ type: "paragraph", content: [{ type: "text", text: "x" }] }],
				},
			],
		},
	},
	{
		name: "blockquote with outer + inner cssClasses (merged)",
		doc: {
			type: "doc",
			content: [
				{
					type: "blockquote",
					attrs: { cssClasses: "card" },
					content: [
						{
							type: "paragraph",
							attrs: { cssClasses: "lead" },
							content: [{ type: "text", text: "x" }],
						},
					],
				},
			],
		},
	},
	{
		name: "list item with cssClasses on the listItem",
		doc: {
			type: "doc",
			content: [
				{
					type: "bulletList",
					content: [
						{
							type: "listItem",
							attrs: { cssClasses: "checked" },
							content: [
								{
									type: "paragraph",
									content: [{ type: "text", text: "Done" }],
								},
							],
						},
					],
				},
			],
		},
	},
	{
		name: "image with cssClasses",
		doc: {
			type: "doc",
			content: [
				{
					type: "image",
					attrs: {
						src: "https://example.com/photo.jpg",
						mediaId: "med_parity",
						alt: "alt",
						cssClasses: "rounded",
					},
				},
			],
		},
	},
];

describe("cssClasses parity: core ↔ inline", () => {
	for (const fixture of FIXTURES) {
		it(`agrees on PM → PT shape: ${fixture.name}`, () => {
			const fromCore = coreToPt(fixture.doc);
			const fromInline = inlinePmToPt(fixture.doc as unknown as Parameters<typeof inlinePmToPt>[0]);
			expect(normalizeBlocks(fromInline)).toEqual(normalizeBlocks(fromCore));
		});

		it(`agrees on PM → PT → PM cssClasses: ${fixture.name}`, () => {
			const corePt = coreToPt(fixture.doc);
			const inlinePt = inlinePmToPt(fixture.doc as unknown as Parameters<typeof inlinePmToPt>[0]);

			const corePm = coreToPm(corePt);
			const inlinePm = inlinePtToPm(inlinePt as unknown as Parameters<typeof inlinePtToPm>[0]);

			// Pull cssClasses sets out of every node — they must agree.
			const collect = (root: { content?: unknown[] } | null | undefined): string[] => {
				if (!root || !root.content) return [];
				const acc: string[] = [];
				const visit = (node: unknown) => {
					if (!node || typeof node !== "object") return;
					const n = node as { attrs?: { cssClasses?: unknown }; content?: unknown[] };
					const c = n.attrs?.cssClasses;
					if (typeof c === "string") acc.push(...sortTokens(c));
					if (Array.isArray(n.content)) n.content.forEach(visit);
				};
				root.content.forEach(visit);
				return acc.toSorted(compareStrings);
			};

			expect(collect(inlinePm)).toEqual(collect(corePm));
		});
	}
});
