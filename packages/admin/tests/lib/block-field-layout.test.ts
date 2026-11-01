import { describe, expect, it } from "vitest";

import type { BlockFieldDefinition } from "../../src/lib/api/schema.js";
import {
	type BlockFieldPart,
	blockSummary,
	isLinkField,
	itemTitleField,
	listItemText,
	type LayoutField,
	listPresentation,
	type PlanField,
	planBlockFields,
	splitLabelHint,
} from "../../src/lib/block-field-layout.js";

const format = {
	locale: "en",
	withMore: (list: string, count: number) => `${list} +${count}`,
};

function repeater(slug: string, subFields: LayoutField[]): BlockFieldDefinition {
	return { slug, label: slug, type: "repeater", validation: { subFields } };
}

function field(type: string, slug: string, label = slug): PlanField {
	return { slug, label, type };
}

function describePart(part: BlockFieldPart): string {
	switch (part.kind) {
		case "field":
			return `${part.heading ? "heading " : ""}${part.field.slug}`;
		case "columns":
			return `columns(${part.fields.map((column) => column.slug).join(", ")})`;
		case "image":
			return `image(${part.field.slug}${part.caption ? `, ${part.caption.slug}` : ""})`;
		case "button":
			return `button "${part.label}"(${part.text.slug}, ${part.link.slug})`;
	}
}

function layout(fields: PlanField[], scope: "block" | "item" = "block") {
	const plan = planBlockFields(fields, scope);
	return {
		content: plan.content.map(describePart),
		settings: plan.settings.map(describePart),
		advanced: plan.advanced.map((advanced) => advanced.slug),
	};
}

function placedSlugs(plan: ReturnType<typeof planBlockFields>): string[] {
	const parts = [...plan.content, ...plan.settings].flatMap((part) => {
		switch (part.kind) {
			case "field":
				return [part.field];
			case "columns":
				return part.fields;
			case "image":
				return part.caption ? [part.field, part.caption] : [part.field];
			case "button":
				return [part.text, part.link];
		}
	});
	return [...parts, ...plan.advanced].map((placed) => placed.slug);
}

describe("splitLabelHint", () => {
	it("turns a trailing parenthetical with a space into a capitalized hint", () => {
		expect(
			splitLabelHint("Primary button link (starts with /, https://, mailto:, tel: or #)"),
		).toEqual({
			label: "Primary button link",
			hint: "Starts with /, https://, mailto:, tel: or #",
		});
		expect(splitLabelHint("Checklist (one item per line)")).toEqual({
			label: "Checklist",
			hint: "One item per line",
		});
	});

	it('turns a trailing ", for example" into a hint', () => {
		expect(splitLabelHint("Website, for example https://example.com")).toEqual({
			label: "Website",
			hint: "For example https://example.com",
		});
	});

	it.each(["Price (USD)", "Size (px)", "Aspect ratio (16:9)", "Headline", "(one item per line)"])(
		"keeps %j whole",
		(label) => {
			expect(splitLabelHint(label)).toEqual({ label });
		},
	);
});

describe("planBlockFields", () => {
	it.each(
		["_label", "_text", ""].flatMap((textSuffix) =>
			["_url", "_link", "_href"].map((linkSuffix) => [`cta${textSuffix}`, `cta${linkSuffix}`]),
		),
	)("puts %s and %s in one button row", (text, link) => {
		expect(
			layout([
				field("string", "headline"),
				field("string", text, "Primary button text"),
				field("string", link, "Primary button link (starts with /)"),
			]),
		).toEqual({
			content: ["heading headline"],
			settings: [`button "Primary button"(${text}, ${link})`],
			advanced: [],
		});
	});

	it("pairs each link with one text field, preferring _label, then _text, then the bare base", () => {
		expect(
			layout([
				field("string", "cta"),
				field("string", "cta_text"),
				field("string", "cta_label"),
				field("url", "cta_url"),
				field("string", "cta_link"),
			]).settings,
		).toEqual(['button "cta_text"(cta_text, cta_link)', 'button "cta_label"(cta_label, cta_url)']);
	});

	it("only pairs a string text with a link field", () => {
		expect(
			layout([
				field("string", "headline"),
				field("text", "cta_label"),
				field("url", "cta_url"),
				field("string", "more"),
				field("text", "more_url"),
			]),
		).toEqual({
			content: ["heading headline", "cta_label", "more", "more_url"],
			settings: ["cta_url"],
			advanced: [],
		});
	});

	it("puts a block's {image}_caption under its photo, wherever it is declared", () => {
		const fields = [
			field("string", "photo_caption"),
			field("string", "headline"),
			field("image", "photo"),
			field("text", "image_caption"),
			field("image", "image"),
		];
		expect(layout(fields).content).toEqual([
			"heading headline",
			"image(photo, photo_caption)",
			"image_caption",
			"image(image)",
		]);
		expect(layout(fields, "item")).toEqual({
			content: ["columns(photo_caption, headline)", "image_caption"],
			settings: ["image(photo)", "image(image)"],
			advanced: [],
		});
	});

	it("moves a block's section ID to Advanced", () => {
		const fields = [field("string", "anchor_id", "Section ID"), field("string", "headline")];
		expect(layout(fields)).toEqual({
			content: ["heading headline"],
			settings: [],
			advanced: ["anchor_id"],
		});
		expect(layout(fields, "item").content).toEqual(["columns(anchor_id, headline)"]);
	});

	it("puts switches, choices, numbers, dates, files and lone links in settings rows", () => {
		expect(
			layout([
				field("string", "title"),
				field("boolean", "centered"),
				field("select", "tone"),
				field("multiSelect", "topics"),
				field("number", "price"),
				field("integer", "seats"),
				field("datetime", "starts_at"),
				field("file", "brochure"),
				field("url", "website"),
				field("string", "video_href"),
				field("portableText", "body"),
				field("repeater", "items"),
				field("future", "widget"),
			]),
		).toEqual({
			content: ["heading title", "body", "items", "widget"],
			settings: [
				"centered",
				"tone",
				"topics",
				"price",
				"seats",
				"starts_at",
				"brochure",
				"website",
				"video_href",
			],
			advanced: [],
		});
	});

	it("matches headline words whole, in the slug or the label", () => {
		expect(
			layout([
				field("string", "kicker"),
				field("text", "subheadline", "Subheadline"),
				field("string", "subtitle", "Subtitle"),
				field("string", "main", "Main statement"),
			]).content,
		).toEqual(["kicker", "subheadline", "subtitle", "heading main"]);
		expect(
			layout([field("text", "intro", "Intro"), field("string", "section_heading", "Top")]).content,
		).toEqual(["intro", "heading section_heading"]);
	});

	it("never picks a label, eyebrow, kicker or tag as the headline", () => {
		expect(
			layout([
				field("string", "eyebrow", "Label above headline"),
				field("string", "headline", "Headline"),
			]).content,
		).toEqual(["eyebrow", "heading headline"]);
		expect(
			layout([
				field("string", "headline", "Section label (small text above the quotes)"),
				field("text", "quote", "Quote"),
			]).content,
		).toEqual(["headline", "quote"]);
		expect(layout([field("string", "tag", "Tag"), field("text", "body", "Body")]).content).toEqual([
			"tag",
			"body",
		]);
	});

	it("falls back to the first text field, and has no headline in list items", () => {
		expect(
			layout([field("text", "intro", "Intro"), field("string", "name", "Name")]).content,
		).toEqual(["heading intro", "name"]);
		expect(layout([field("string", "headline", "Headline")], "item").content).toEqual(["headline"]);
	});

	it("sets runs of two or three one-line fields side by side", () => {
		expect(
			layout([
				field("string", "headline"),
				field("string", "one"),
				field("string", "two"),
				field("string", "three"),
				field("string", "four"),
				field("text", "body"),
				field("string", "five"),
				field("string", "six"),
				field("image", "photo"),
				field("string", "seven"),
			]).content,
		).toEqual([
			"heading headline",
			"columns(one, two, three)",
			"four",
			"body",
			"columns(five, six)",
			"image(photo)",
			"seven",
		]);
	});

	it("places every field exactly once", () => {
		const fields = [
			field("string", "cta"),
			field("string", "cta_label"),
			field("string", "cta_url"),
			field("string", "cta_link"),
			field("string", "anchor_id"),
			field("string", "image_caption"),
			field("image", "image"),
			field("string", "image_caption_url"),
			field("url", "website"),
			field("boolean", "flag"),
			field("text", "body"),
		];
		const slugs = fields.map((each) => each.slug).toSorted();
		expect(placedSlugs(planBlockFields(fields, "block")).toSorted()).toEqual(slugs);
		expect(placedSlugs(planBlockFields(fields, "item")).toSorted()).toEqual(slugs);
	});
});

describe("listPresentation", () => {
	it("types one string or url per line", () => {
		expect(listPresentation([{ slug: "name", type: "string" }])).toBe("lines");
		expect(listPresentation([{ slug: "link", type: "url" }])).toBe("lines");
		expect(listPresentation([{ slug: "bio", type: "text" }])).toBe("items");
	});

	it("shows up to three short sub-fields as a table, with at most one image", () => {
		expect(
			listPresentation([
				{ slug: "value", type: "string" },
				{ slug: "label", type: "string" },
			]),
		).toBe("table");
		expect(
			listPresentation([
				{ slug: "name", type: "string" },
				{ slug: "logo", type: "image" },
				{ slug: "rank", type: "integer" },
			]),
		).toBe("table");
		expect(
			listPresentation([
				{ slug: "light", type: "image" },
				{ slug: "dark", type: "image" },
			]),
		).toBe("items");
	});

	it("expands items with a text sub-field or more than three sub-fields", () => {
		expect(
			listPresentation([
				{ slug: "question", type: "string" },
				{ slug: "answer", type: "text" },
			]),
		).toBe("items");
		expect(listPresentation(["a", "b", "c", "d"].map((slug) => ({ slug, type: "string" })))).toBe(
			"items",
		);
	});
});

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

describe("listItemText", () => {
	const testimonial = [
		{ slug: "quote", type: "text" },
		{ slug: "author", type: "string" },
		{ slug: "role", type: "string" },
		{ slug: "company", type: "string" },
		{ slug: "team", type: "string" },
		{ slug: "avatar", type: "image" },
	];

	it("shows the title, then up to two other plain strings", () => {
		expect(
			listItemText(
				{
					quote: "We found more savings in the first month.",
					author: "Maya Okafor",
					role: "Director of Facilities",
					company: "Calder University",
					team: "Estates",
				},
				testimonial,
			),
		).toEqual({ title: "Maya Okafor", summary: "Director of Facilities · Calder University" });
	});

	it("skips empty strings, link fields and button text in the summary", () => {
		const plan = [
			{ slug: "name", type: "string" },
			{ slug: "price", type: "string" },
			{ slug: "cta_label", type: "string" },
			{ slug: "cta_url", type: "string" },
			{ slug: "website", type: "url" },
			{ slug: "period", type: "string" },
		];
		expect(
			listItemText(
				{
					name: "Pro",
					price: "  ",
					cta_label: "Start",
					cta_url: "/start",
					website: "https://example.com",
					period: "per month",
				},
				plan,
			),
		).toEqual({ title: "Pro", summary: "per month" });
	});

	it("falls back to the start of the first other text, on one line", () => {
		const feature = [
			{ slug: "icon", type: "select" },
			{ slug: "title", type: "string" },
			{ slug: "description", type: "text" },
		];
		expect(
			listItemText({ title: "", description: "  Find the waste.\n\nThen fix it.  " }, feature),
		).toEqual({ title: "", summary: "Find the waste. Then fix it." });
	});

	it("uses the text as the title when there is no string to title the item", () => {
		const faq = [
			{ slug: "link", type: "url" },
			{ slug: "answer", type: "text" },
		];
		expect(listItemText({ link: "/faq", answer: "Yes,\nalways." }, faq)).toEqual({
			title: "Yes, always.",
			summary: "",
		});
		expect(listItemText({ logo: { id: "m" } }, [{ slug: "logo", type: "image" }])).toEqual({
			title: "",
			summary: "",
		});
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
