import { describe, expect, it } from "vitest";

import type { BlockFieldDefinition } from "../../src/lib/api/schema.js";
import {
	blockSummary,
	isLinkField,
	itemTitleField,
	type LayoutField,
} from "../../src/lib/block-field-layout.js";

const format = {
	locale: "en",
	withMore: (list: string, count: number) => `${list} +${count}`,
};

function repeater(slug: string, subFields: LayoutField[]): BlockFieldDefinition {
	return { slug, label: slug, type: "repeater", validation: { subFields } };
}

describe("isLinkField", () => {
	it("accepts url fields and string fields named like links", () => {
		expect(isLinkField({ slug: "website", type: "url" })).toBe(true);
		expect(isLinkField({ slug: "primary_cta_url", type: "string" })).toBe(true);
		expect(isLinkField({ slug: "more_link", type: "string" })).toBe(true);
		expect(isLinkField({ slug: "logo_href", type: "string" })).toBe(true);
	});

	it("rejects other fields, including text fields named like links", () => {
		expect(isLinkField({ slug: "url", type: "string" })).toBe(false);
		expect(isLinkField({ slug: "curling", type: "string" })).toBe(false);
		expect(isLinkField({ slug: "notes_url", type: "text" })).toBe(false);
	});
});

describe("itemTitleField", () => {
	it("titles a testimonial by its author rather than its quote", () => {
		const subFields = [
			{ slug: "quote", type: "text" },
			{ slug: "author", type: "string" },
			{ slug: "role", type: "string" },
		];
		expect(itemTitleField(subFields)?.slug).toBe("author");
	});

	it.each([
		["cta_label", "cta_url"],
		["cta_text", "cta_link"],
		["cta", "cta_href"],
	])("skips button text %s paired with %s", (text, link) => {
		const subFields = [
			{ slug: text, type: "string" },
			{ slug: link, type: "string" },
			{ slug: "name", type: "string" },
		];
		expect(itemTitleField(subFields)?.slug).toBe("name");
	});

	it("keeps a label field that has no link partner", () => {
		const subFields = [
			{ slug: "button_label", type: "string" },
			{ slug: "website", type: "string" },
		];
		expect(itemTitleField(subFields)?.slug).toBe("button_label");
	});

	it("falls back to the first text sub-field, or none", () => {
		expect(
			itemTitleField([
				{ slug: "website", type: "url" },
				{ slug: "answer", type: "text" },
			])?.slug,
		).toBe("answer");
		expect(itemTitleField([{ slug: "logo", type: "image" }])).toBeUndefined();
	});
});

describe("blockSummary", () => {
	it("prefers a required field to an earlier optional one", () => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "eyebrow", label: "Eyebrow", type: "string" },
			{ slug: "headline", label: "Headline", type: "string", required: true },
		];
		expect(
			blockSummary(
				{ eyebrow: "New", headline: "  Heat pumps for campuses " },
				"Hero",
				fields,
				format,
			),
		).toBe("Heat pumps for campuses");
		expect(blockSummary({ eyebrow: "New", headline: " " }, "Hero", fields, format)).toBe("New");
	});

	it("skips link fields, the section ID and text that repeats the block name", () => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "heading", label: "Heading", type: "string", required: true },
			{ slug: "cta_url", label: "Button link", type: "string", required: true },
			{ slug: "website", label: "Website", type: "url" },
			{ slug: "anchor_id", label: "Section ID", type: "string" },
			{ slug: "intro", label: "Introduction", type: "text" },
		];
		const block = {
			heading: " clients ",
			cta_url: "/contact",
			website: "https://example.com",
			anchor_id: "selected-clients",
			intro: "Studios we have worked with",
		};
		expect(blockSummary(block, "Clients", fields, format)).toBe("Studios we have worked with");
	});

	it("falls back to the first text block of rich text", () => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "title", label: "Title", type: "string" },
			{ slug: "body", label: "Body", type: "portableText" },
		];
		const body = [
			{ _type: "image", asset: { id: "media-1" } },
			{ _type: "block", children: [{ _type: "span", text: "  " }] },
			{
				_type: "block",
				children: [
					{ _type: "span", text: "Talk to " },
					{ _type: "span", text: "the team" },
				],
			},
		];
		expect(blockSummary({ title: "", body }, "Text", fields, format)).toBe("Talk to the team");
	});

	it("lists the titles of the first list's items", () => {
		const clients = repeater("clients", [
			{ slug: "website", type: "url" },
			{ slug: "name", type: "string" },
		]);
		const fields: BlockFieldDefinition[] = [
			{ slug: "heading", label: "Heading", type: "string" },
			clients,
			repeater("partners", [{ slug: "name", type: "string" }]),
		];
		const names = [
			"Hotel Wilde",
			"",
			"Het Bouwhuis",
			"Ola Ceramics",
			"Studio Vaag",
			"Norma",
			"Arc",
		];
		const block = {
			heading: "Clients",
			clients: names.map((name) => ({ name, website: "https://example.com" })),
			partners: [{ name: "Ignored" }],
		};

		expect(blockSummary(block, "Clients", fields, format)).toBe(
			"Hotel Wilde, Het Bouwhuis, Ola Ceramics +3",
		);
		expect(blockSummary({ clients: block.clients.slice(0, 3) }, "Clients", fields, format)).toBe(
			"Hotel Wilde, Het Bouwhuis",
		);
	});

	it("has no summary when nothing qualifies", () => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "heading", label: "Heading", type: "string" },
			{ slug: "image", label: "Image", type: "image" },
			repeater("logos", [{ slug: "logo", type: "image" }]),
		];
		expect(
			blockSummary({ heading: "Logos", logos: [{ logo: null }] }, "Logos", fields, format),
		).toBeNull();
		expect(blockSummary({}, "Logos", [], format)).toBeNull();
	});
});
