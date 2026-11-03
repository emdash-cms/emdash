import { i18n } from "@lingui/core";
import { describe, expect, it } from "vitest";

import { changeLabel } from "../../../src/components/revisions/change-labels.js";
import type { BlockNoun, ChangeItem, FieldRef } from "../../../src/lib/revision-diff/types.js";
import { isolate } from "../../../src/lib/utils.js";

const body: FieldRef = { slug: "content", label: "Content" };
const featured: FieldRef = { slug: "featured", label: "Featured post" };
const excerpt: FieldRef = { slug: "excerpt", label: "Excerpt" };

const NOUNS: Record<BlockNoun, true> = {
	paragraph: true,
	heading: true,
	quote: true,
	listItem: true,
	image: true,
	code: true,
	table: true,
	gallery: true,
	video: true,
	embed: true,
	html: true,
	divider: true,
	custom: true,
};
const TEXT_NOUNS = new Set<BlockNoun>(["paragraph", "heading", "quote", "listItem"]);
const BLOCK_ACTIONS = ["added", "removed", "edited", "restyled", "moved"] as const;
const IMAGE_ACTIONS = [
	"added",
	"removed",
	"replaced",
	"captionEdited",
	"altEdited",
	"changed",
] as const;

function block(
	noun: BlockNoun,
	action: (typeof BLOCK_ACTIONS)[number],
	snippet: { text: string; truncated: boolean } | null = null,
): ChangeItem {
	return {
		kind: "block",
		field: body,
		action,
		noun,
		snippet,
		target: "b-content-0",
	};
}

const blockItems = (Object.keys(NOUNS) as BlockNoun[]).flatMap((noun) =>
	BLOCK_ACTIONS.map((action) => block(noun, action)),
);

const everyItem: ChangeItem[] = [
	{ kind: "created" },
	{ kind: "earliest" },
	{ kind: "restored", revisionId: "rev-1" },
	{ kind: "noChanges" },
	{ kind: "title", field: { slug: "title", label: "Title" }, target: "f-title" },
	{ kind: "text", field: excerpt, change: "added", target: "f-excerpt" },
	{ kind: "text", field: excerpt, change: "removed", target: "f-excerpt" },
	{ kind: "text", field: excerpt, change: "edited", target: "f-excerpt" },
	{ kind: "toggle", field: featured, on: true, target: "f-featured" },
	{ kind: "toggle", field: featured, on: false, target: "f-featured" },
	{ kind: "field", field: { slug: "category", label: "Category" }, target: "f-category" },
	{ kind: "slug", after: "new-post" },
	{ kind: "slug", after: null },
	...blockItems,
	...BLOCK_ACTIONS.map((action) =>
		block("paragraph", action, { text: "Most teams plan posts in", truncated: true }),
	),
	...IMAGE_ACTIONS.map(
		(action): ChangeItem => ({ kind: "image", field: body, action, target: "b-content-1" }),
	),
];

describe("changeLabel", () => {
	it.each(everyItem.map((item) => [JSON.stringify(item), item] as const))(
		"describes %s",
		(_, item) => {
			const label = changeLabel(i18n, item);
			expect(label.trim()).not.toBe("");
			expect(label).not.toContain("undefined");
			expect(label).not.toContain("null");
			expect(label).not.toContain("[object");
		},
	);

	it("gives every block noun and action its own sentence", () => {
		const labels = (Object.keys(NOUNS) as BlockNoun[])
			.filter((noun) => noun !== "custom")
			.flatMap((noun) =>
				BLOCK_ACTIONS.filter((action) => action !== "restyled" || TEXT_NOUNS.has(noun)).map(
					(action) => changeLabel(i18n, block(noun, action)),
				),
			);
		expect(new Set(labels).size).toBe(labels.length);
	});

	it("describes a restyled non-text block as an edit", () => {
		expect(changeLabel(i18n, block("table", "restyled"))).toBe(
			changeLabel(i18n, block("table", "edited")),
		);
	});

	it("names the field for custom blocks", () => {
		expect(changeLabel(i18n, block("custom", "added"))).toBe(`Changed ${isolate("Content")}`);
	});

	it("quotes an isolated snippet and marks a truncated one with an ellipsis", () => {
		expect(
			changeLabel(i18n, block("paragraph", "edited", { text: "Most teams plan", truncated: true })),
		).toBe(`Edited “${isolate("Most teams plan…")}”`);
		expect(
			changeLabel(i18n, block("heading", "removed", { text: "Launch day", truncated: false })),
		).toBe(`Removed “${isolate("Launch day")}”`);
		expect(
			changeLabel(i18n, block("quote", "restyled", { text: "Ship it", truncated: false })),
		).toBe(`Changed the style of “${isolate("Ship it")}”`);
	});

	it("isolates field labels", () => {
		expect(
			changeLabel(i18n, { kind: "toggle", field: featured, on: true, target: "f-featured" }),
		).toBe(`Turned on ${isolate("Featured post")}`);
		expect(
			changeLabel(i18n, { kind: "text", field: excerpt, change: "removed", target: "f-excerpt" }),
		).toBe(`Cleared ${isolate("Excerpt")}`);
	});

	it("quotes the new slug, or says it was removed", () => {
		expect(changeLabel(i18n, { kind: "slug", after: "new-post" })).toBe(
			`Changed the slug to “${isolate("new-post")}”`,
		);
		expect(changeLabel(i18n, { kind: "slug", after: "" })).toBe("Removed the slug");
	});

	it("dates a restored version when it is loaded", () => {
		const item: ChangeItem = { kind: "restored", revisionId: "rev-1" };
		expect(
			changeLabel(i18n, item, {
				restoredWhen: (id) => (id === "rev-1" ? "Yesterday, 4:05 PM" : null),
			}),
		).toBe(`Restored the version from ${isolate("Yesterday, 4:05 PM")}`);
		expect(changeLabel(i18n, item, { restoredWhen: () => null })).toBe(
			"Restored an earlier version",
		);
	});
});
