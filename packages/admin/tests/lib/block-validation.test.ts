import { describe, expect, it } from "vitest";

import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema";
import { blockIssueElementId, validateBlocks } from "../../src/lib/block-validation";
import { isSafeHref } from "../../src/lib/url";

function blockType(fields: BlockFieldDefinition[]): BlockType {
	return {
		id: "card-type",
		slug: "card",
		label: "Card",
		currentVersion: 1,
		source: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: "card-v1",
				blockTypeId: "card-type",
				version: 1,
				fields,
				fingerprint: "card",
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
}

function issuesFor(fields: BlockFieldDefinition[], values: Record<string, unknown>) {
	return validateBlocks(
		[{ _type: "card", _version: 1, _key: "card", ...values }],
		[blockType(fields)],
	).map(({ path, code }) => `${path}:${code}`);
}

const FIELD_TYPES: BlockFieldDefinition["type"][] = [
	"string",
	"text",
	"url",
	"number",
	"integer",
	"boolean",
	"datetime",
	"select",
	"multiSelect",
	"portableText",
	"image",
	"file",
	"repeater",
];

// The server's documented examples, from `sanitizeHref` and its tests in packages/core.
const SAFE_LINKS = [
	"https://example.com",
	"/about",
	"#section",
	"mailto:a@b.com",
	"/foo\\bar",
	"#contact",
	"mailto:a@example.com",
];
const UNSAFE_LINKS = [
	"javascript:alert(1)",
	"data:text/html,<script>",
	"",
	"//evil.example/path",
	"/\\evil.example/path",
	"/\t/evil.example/path",
	"\t//evil.example/path",
	"\u0000//evil.example/path",
	"\\\\evil.example/path",
	"www.example.com",
];

describe("validateBlocks", () => {
	it("finds the values the server rejects", () => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "title", label: "Title", type: "string", required: true },
			{ slug: "kicker", label: "Kicker", type: "string", validation: { maxLength: 5 } },
			{ slug: "slug", label: "Slug", type: "string", validation: { pattern: "^[a-z]+$" } },
			{ slug: "rating", label: "Rating", type: "number", validation: { min: 1, max: 5 } },
			{
				slug: "align",
				label: "Align",
				type: "select",
				validation: { options: ["start", "center"] },
			},
			{
				slug: "plans",
				label: "Plans",
				type: "repeater",
				validation: {
					minItems: 2,
					subFields: [
						{ slug: "name", label: "Name", type: "string", required: true },
						{ slug: "tier", label: "Tier", type: "select", options: ["free", "pro"] },
					],
				},
			},
		];

		expect(
			issuesFor(fields, {
				title: "",
				kicker: "Too long",
				slug: "Not a slug",
				rating: 9,
				align: "left",
				plans: [{ name: "", tier: "" }],
			}),
		).toEqual([
			"title:required",
			"kicker:too_big",
			"slug:invalid_format",
			"rating:too_big",
			"align:invalid_value",
			"plans:too_small",
			"plans.0.name:required",
			"plans.0.tier:invalid_value",
		]);
	});

	it("accepts what the server accepts", () => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "title", label: "Title", type: "string", required: true, defaultValue: "Untitled" },
			{ slug: "summary", label: "Summary", type: "text", validation: { minLength: 3 } },
			{
				slug: "anchor",
				label: "Anchor",
				type: "string",
				validation: { pattern: "^(?:$|[a-z]+)$" },
			},
			{ slug: "image", label: "Image", type: "image" },
			{ slug: "size", label: "Size", type: "select", validation: { options: ["", "large"] } },
			{
				slug: "plans",
				label: "Plans",
				type: "repeater",
				validation: {
					subFields: [
						{ slug: "tier", label: "Tier", type: "select", required: true, options: ["", "pro"] },
					],
				},
			},
		];

		expect(
			issuesFor(fields, {
				summary: null,
				anchor: "",
				image: null,
				size: "",
				plans: [{ tier: "" }],
			}),
		).toEqual([]);
	});

	it.each(FIELD_TYPES)("rejects a missing or empty required %s", (type) => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "value", label: "Value", type, required: true },
		];

		expect(issuesFor(fields, {})).toEqual(["value:required"]);
		expect(issuesFor(fields, { value: null })).toEqual(["value:required"]);
		expect(issuesFor(fields, { value: "" })).toEqual(["value:required"]);
	});

	it("counts a value made only of spaces as filled", () => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "title", label: "Title", type: "string", required: true },
			{ slug: "body", label: "Body", type: "text", required: true },
			{
				slug: "items",
				label: "Items",
				type: "repeater",
				validation: {
					subFields: [{ slug: "name", label: "Name", type: "string", required: true }],
				},
			},
		];

		expect(issuesFor(fields, { title: " ", body: "\n", items: [{ name: "  " }] })).toEqual([]);
	});

	it("accepts an empty required multiSelect, rich text or list, unless the list has a minimum", () => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "topics", label: "Topics", type: "multiSelect", required: true },
			{ slug: "body", label: "Body", type: "portableText", required: true },
			{ slug: "links", label: "Links", type: "repeater", required: true },
			{
				slug: "logos",
				label: "Logos",
				type: "repeater",
				required: true,
				validation: { minItems: 1 },
			},
		];

		expect(issuesFor(fields, { topics: [], body: [], links: [], logos: [] })).toEqual([
			"logos:too_small",
		]);
	});

	it("checks a string against its pattern", () => {
		const fields: BlockFieldDefinition[] = [
			{
				slug: "cta_url",
				label: "Link",
				type: "string",
				validation: { pattern: "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$" },
			},
		];

		expect(issuesFor(fields, { cta_url: "contact" })).toEqual(["cta_url:invalid_format"]);
		expect(issuesFor(fields, { cta_url: "/contact" })).toEqual([]);
		expect(issuesFor(fields, { cta_url: "" })).toEqual([]);
	});

	it("keeps a list within its minimum and maximum size", () => {
		const fields: BlockFieldDefinition[] = [
			{
				slug: "stats",
				label: "Stats",
				type: "repeater",
				validation: { minItems: 2, maxItems: 3, subFields: [] },
			},
		];

		expect(issuesFor(fields, { stats: [{}] })).toEqual(["stats:too_small"]);
		expect(issuesFor(fields, { stats: [{}, {}] })).toEqual([]);
		expect(issuesFor(fields, { stats: [{}, {}, {}] })).toEqual([]);
		expect(issuesFor(fields, { stats: [{}, {}, {}, {}] })).toEqual(["stats:too_big"]);
	});

	it("finds a missing required sub-field in each list item", () => {
		const fields: BlockFieldDefinition[] = [
			{
				slug: "logos",
				label: "Logos",
				type: "repeater",
				validation: {
					subFields: [
						{ slug: "name", label: "Company name", type: "string", required: true },
						{ slug: "logo", label: "Logo", type: "image", required: true },
					],
				},
			},
		];
		const issues = validateBlocks(
			[
				{
					_type: "card",
					_version: 1,
					_key: "card",
					logos: [{ name: "Arc", logo: { id: "media-1" } }, { name: "" }],
				},
			],
			[blockType(fields)],
		);

		expect(issues).toMatchObject([
			{ path: "logos.1.name", field: "logos", label: "Company name", item: 1, code: "required" },
			{ path: "logos.1.logo", field: "logos", label: "Logo", item: 1, code: "required" },
		]);
		expect(blockIssueElementId("layout", issues[0]!)).toBe("field-layout.card.logos.1.name");
	});

	it("requires a whole number in an integer field or sub-field", () => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "seats", label: "Seats", type: "integer" },
			{ slug: "price", label: "Price", type: "number" },
			{
				slug: "rows",
				label: "Rows",
				type: "repeater",
				validation: { subFields: [{ slug: "count", label: "Count", type: "integer" }] },
			},
		];

		expect(issuesFor(fields, { seats: 1.5, price: 1.5, rows: [{ count: 2.5 }] })).toEqual([
			"seats:not_integer",
			"rows.0.count:not_integer",
		]);
		expect(issuesFor(fields, { seats: 2, price: 1.5, rows: [{ count: 2 }] })).toEqual([]);
	});

	it.each(SAFE_LINKS)("accepts the safe link %j in a url field and sub-field", (link) => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "website", label: "Website", type: "url" },
			{
				slug: "links",
				label: "Links",
				type: "repeater",
				validation: { subFields: [{ slug: "url", label: "Link", type: "url" }] },
			},
		];

		expect(isSafeHref(link)).toBe(true);
		expect(issuesFor(fields, { website: link, links: [{ url: link }] })).toEqual([]);
	});

	it.each(UNSAFE_LINKS)("rejects the unsafe link %j in a url field and sub-field", (link) => {
		const fields: BlockFieldDefinition[] = [
			{ slug: "website", label: "Website", type: "url" },
			{
				slug: "links",
				label: "Links",
				type: "repeater",
				validation: { subFields: [{ slug: "url", label: "Link", type: "url" }] },
			},
		];

		expect(isSafeHref(link)).toBe(false);
		expect(issuesFor(fields, { website: link, links: [{ url: link }] })).toEqual([
			"website:invalid_format",
			"links.0.url:invalid_format",
		]);
	});

	it("leaves an unset optional link alone", () => {
		const fields: BlockFieldDefinition[] = [{ slug: "website", label: "Website", type: "url" }];

		expect(issuesFor(fields, {})).toEqual([]);
		expect(issuesFor(fields, { website: null })).toEqual([]);
	});

	it("leaves blocks without a stored definition to the server", () => {
		const types = [blockType([{ slug: "title", label: "Title", type: "string", required: true }])];

		expect(
			validateBlocks(
				[
					{ _type: "card", _version: 2, _key: "future" },
					{ _type: "gone", _version: 1, _key: "gone" },
				],
				types,
			),
		).toEqual([]);
	});
});
