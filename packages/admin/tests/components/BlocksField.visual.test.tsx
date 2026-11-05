import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { ContentEditor, type FieldDescriptor } from "../../src/components/ContentEditor.js";
import type { ContentItem } from "../../src/lib/api";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import { render } from "../utils/render.js";

vi.mock("@tanstack/react-router", async () => {
	const actual = await vi.importActual("@tanstack/react-router");
	return {
		...actual,
		Link: ({ children, ...props }: React.ComponentProps<"a">) => <a {...props}>{children}</a>,
		useBlocker: () => ({ status: "idle" }),
	};
});

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchBylines: vi.fn(async () => ({ items: [], nextCursor: null })),
		fetchReferenceChildren: vi.fn(async () => ({ children: [] })),
	};
});

vi.mock("../../src/components/TaxonomySidebar", () => ({
	TaxonomySidebar: () => null,
	useHasApplicableTaxonomies: () => false,
}));

const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";

function blockType(slug: string, label: string, fields: BlockFieldDefinition[]): BlockType {
	return {
		id: `${slug}-type`,
		slug,
		label,
		currentVersion: 1,
		source: "seed",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: `${slug}-v1`,
				blockTypeId: `${slug}-type`,
				version: 1,
				fields,
				fingerprint: slug,
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
}

const showcase = blockType("showcase", "Showcase", [
	{ slug: "headline", label: "Headline", type: "string" },
	{ slug: "eyebrow", label: "Label above headline", type: "string" },
	{
		slug: "features",
		label: "Features",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "description", label: "Description", type: "text" },
			],
		},
	},
	{
		slug: "stats",
		label: "Stats",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "value", label: "Value", type: "string" },
				{ slug: "label", label: "Label", type: "string" },
			],
		},
	},
	{ slug: "background", label: "Background image", type: "image" },
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{ slug: "primary_cta_url", label: "Primary button link", type: "string" },
	{ slug: "anchor_id", label: "Section ID", type: "string" },
]);

const showcaseBlock = {
	_type: "showcase",
	_version: 1,
	_key: "showcase-1",
	headline: "Every building, running at its best.",
	eyebrow: "Platform",
	features: [
		{
			title: "Every meter, one view",
			description: "Electricity, gas, water and heat from every site, normalised and live.",
		},
		{
			title: "Fixes that run themselves",
			description: "When a building drifts, Halden adjusts the controls before anyone notices.",
		},
		{
			title: "Reports in minutes",
			description: "CSRD, GRESB and ENERGY STAR submissions from the same data.",
		},
	],
	stats: [
		{ value: "23%", label: "Lower energy use" },
		{ value: "4,800", label: "Buildings connected" },
	],
	background: { id: "media-1", src: PHOTO, alt: "", width: 16, height: 9 },
	primary_cta_label: "Book a demo",
	primary_cta_url: "/contact",
	anchor_id: "platform",
};

const faq = blockType("faq", "FAQ", [
	{
		slug: "questions",
		label: "Questions",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "question", label: "Question", type: "string" },
				{ slug: "answer", label: "Answer", type: "text" },
			],
		},
	},
]);

const faqBlock = {
	_type: "faq",
	_version: 1,
	_key: "faq-1",
	questions: [
		{
			question:
				"Which reporting frameworks, certifications and disclosure schemes does Halden support for portfolios across several countries?",
			answer: "Halden prepares CSRD, GRESB, ENERGY STAR and CDP submissions from the same data.",
		},
		{
			question: "Do we need new hardware?",
			answer: "Usually not. Halden reads the meters and controls you already have.",
		},
		{
			question: "Is our data secure?",
			answer: "Halden is audited every year against SOC 2 Type II and ISO 27001.",
		},
		{
			question: "How quickly will we see savings?",
			answer: "Most portfolios see their first verified savings within a month.",
		},
		{
			question: "Can Halden change settings on its own?",
			answer: "Only within the limits your engineers set for each building.",
		},
		{
			question: "Does Halden work with our existing controls?",
			answer: "It connects to the BMS, meters and sensors you already run.",
		},
		{
			question: "What happens to our data if we stop using Halden?",
			answer: "You can export everything, and we delete our copy within thirty days.",
		},
	],
};

function renderEditor(content: unknown[], blockTypes: BlockType[]) {
	const fields: Record<string, FieldDescriptor> = {
		title: { kind: "string", label: "Title" },
		content: {
			kind: "blocks",
			label: "Content",
			validation: { allowedTypes: blockTypes.map((type) => type.slug), retiredTypes: [] },
			blockTypes,
		},
	};
	const item: ContentItem = {
		id: "page-1",
		type: "pages",
		slug: "home",
		status: "draft",
		data: { title: "Home", content },
		authorId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
	return render(
		<ContentEditor
			collection="pages"
			collectionLabel="Page"
			fields={fields}
			isNew={false}
			item={item}
			onSave={vi.fn()}
		/>,
		{ wrapper: Toasty },
	);
}

async function openShowcase() {
	await renderEditor([showcaseBlock], [showcase]);
	await page.getByRole("button", { name: "Showcase", exact: true }).click();
	await expect.element(page.getByRole("textbox", { name: "Headline", exact: true })).toBeVisible();
}

const control = (name: string) => page.getByRole("textbox", { name, exact: true }).element();
const toggle = (name: string) => page.getByRole("button", { name, exact: true }).element();
const itemOf = (title: string) => toggle(title).closest('[role="listitem"]')!;
const headOf = (title: string) => toggle(title).parentElement!;
/** The visible name of a block or item row, which its toggle is labelled by. */
const nameOf = (title: string) =>
	document.getElementById(toggle(title).getAttribute("aria-labelledby")!)!;

type Rgba = [number, number, number, number];

const canvas = document.createElement("canvas");
canvas.width = canvas.height = 1;
const context = canvas.getContext("2d", { willReadFrequently: true })!;

/** Any CSS colour as sRGB 0–255 with alpha 0–1. */
function rgba(color: string): Rgba {
	context.clearRect(0, 0, 1, 1);
	context.fillStyle = "transparent";
	context.fillStyle = color;
	context.fillRect(0, 0, 1, 1);
	const [r = 0, g = 0, b = 0, a = 0] = context.getImageData(0, 0, 1, 1).data;
	return [r, g, b, a / 255];
}

function over(top: Rgba, under: Rgba): Rgba {
	const a = top[3];
	return [
		top[0] * a + under[0] * (1 - a),
		top[1] * a + under[1] * (1 - a),
		top[2] * a + under[2] * (1 - a),
		1,
	];
}

const COLOR_FUNCTION = /(?:oklch|oklab|lab|lch|rgba?|hsla?|color)\([^)]*\)/g;

/** The opaque colour painted behind an element: its own and its ancestors' fills and washes. */
function backdrop(element: Element): Rgba {
	const layers: Rgba[] = [];
	for (let node: Element | null = element; node; node = node.parentElement) {
		const style = getComputedStyle(node);
		const washes = style.backgroundImage.match(COLOR_FUNCTION) ?? [];
		// Each wash is a two-stop gradient of one colour.
		for (let i = 0; i < washes.length; i += 2) layers.push(rgba(washes[i]!));
		const fill = rgba(style.backgroundColor);
		if (fill[3] > 0) layers.push(fill);
		if (fill[3] >= 1) break;
	}
	return layers.reduceRight<Rgba>((under, layer) => over(layer, under), [255, 255, 255, 1]);
}

function luminance([r, g, b]: Rgba): number {
	const linear = (v: number) => {
		const c = v / 255;
		return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
	};
	return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}

/** WCAG contrast of a colour drawn over an element's backdrop. */
function contrast(color: string, on: Element): number {
	const bg = backdrop(on);
	const fg = over(rgba(color), bg);
	const [hi, lo] = [luminance(fg), luminance(bg)].toSorted((a, b) => b - a);
	return (hi! + 0.05) / (lo! + 0.05);
}

/** The edge lines an element paints with box shadows that are visible. */
function edges(element: Element): string[] {
	const shadow = getComputedStyle(element).boxShadow;
	if (shadow === "none") return [];
	return shadow
		.split(/,(?![^(]*\))/)
		.filter((layer) => (layer.match(COLOR_FUNCTION) ?? []).some((c) => rgba(c)[3] > 0.01))
		.filter((layer) => /\s[1-9][\d.]*px/.test(layer.replace(COLOR_FUNCTION, "")));
}

/** How wide a run of text shows: zero when hidden, otherwise clipped to its row. */
function shownWidth(element: Element): number {
	if (element.getClientRects().length === 0) return 0;
	let width = element.getBoundingClientRect().width;
	for (let node = element.parentElement; node && !node.matches('[role="listitem"]');) {
		if (getComputedStyle(node).overflow !== "visible") {
			width = Math.min(width, node.getBoundingClientRect().width);
		}
		node = node.parentElement;
	}
	return width;
}

const truncated = (element: Element) => element.scrollWidth > element.clientWidth + 0.5;

/** Draws the admin's theme, as its ThemeProvider sets it on the root, in light or dark mode. */
function showMode(mode: "light" | "dark") {
	document.documentElement.setAttribute("data-theme", "classic");
	document.documentElement.setAttribute("data-mode", mode);
}

afterEach(async () => {
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-mode");
	await page.viewport(1280, 800);
});

describe("Blocks field hierarchy", () => {
	it("reads a block's name a step above its items' names and its field labels", async () => {
		await renderEditor([showcaseBlock], [showcase]);
		const closedWeight = Number(getComputedStyle(nameOf("Showcase")).fontWeight);
		await toggle("Showcase").click();
		await expect
			.element(page.getByRole("textbox", { name: "Headline", exact: true }))
			.toBeVisible();

		const weight = (element: Element) => Number(getComputedStyle(element).fontWeight);
		const blockName = weight(nameOf("Showcase"));
		expect(blockName).toBe(closedWeight);
		expect(blockName).toBeGreaterThan(weight(nameOf("Every meter, one view")));
		expect(blockName).toBeGreaterThan(weight(page.getByText("Label above headline").element()));
	});

	it("keeps the headline the block's largest value without outweighing the block's name", async () => {
		await openShowcase();

		const headline = getComputedStyle(control("Headline"));
		const eyebrow = getComputedStyle(control("Label above headline"));
		const blockName = getComputedStyle(nameOf("Showcase"));
		expect(Number.parseFloat(headline.fontSize)).toBeGreaterThan(
			Number.parseFloat(eyebrow.fontSize),
		);
		expect(Number(headline.fontWeight)).toBeLessThan(Number(blockName.fontWeight));
	});

	it("draws a list's label like the field labels beside it", async () => {
		await openShowcase();

		const list = getComputedStyle(page.getByText("Features", { exact: true }).element());
		const field = getComputedStyle(page.getByText("Label above headline").element());
		expect([list.fontSize, list.fontWeight, list.color]).toEqual([
			field.fontSize,
			field.fontWeight,
			field.color,
		]);
	});
});

describe("Blocks field states", () => {
	it("gives an open item an edge that a hovered row doesn't have", async () => {
		await openShowcase();
		await toggle("Every meter, one view").click();
		await expect.element(page.getByRole("textbox", { name: "Description" })).toBeVisible();
		await userEvent.hover(toggle("Reports in minutes"));

		expect(edges(itemOf("Every meter, one view"))).not.toEqual([]);
		expect(edges(headOf("Reports in minutes"))).toEqual([]);
		expect(edges(itemOf("Reports in minutes"))).toEqual([]);
	});

	it("keeps a row and its menu button washed while the pointer is in the row's menu", async () => {
		await openShowcase();
		const head = headOf("Fixes that run themselves");
		const sheet = backdrop(itemOf("Fixes that run themselves").parentElement!);
		const trigger = page.getByRole("button", { name: "Fixes that run themselves actions" });

		await trigger.click();
		const moveUp = page.getByRole("menuitem", { name: "Move up" });
		await expect.element(moveUp).toBeVisible();
		await userEvent.hover(moveUp);

		expect(head.matches(":hover")).toBe(false);
		expect(backdrop(head)).not.toEqual(sheet);
		expect(rgba(getComputedStyle(trigger.element()).backgroundColor)[3]).toBeGreaterThan(0);
	});
});

describe.each(["light", "dark"] as const)("Blocks field grey text in %s mode", (mode) => {
	it("draws informational text at text contrast and the item grip at icon contrast", async () => {
		showMode(mode);
		await openShowcase();

		const count = page
			.getByText("Features", { exact: true })
			.element()
			.parentElement!.querySelector("bdi")!;
		const advanced = page.getByText("Section ID: platform").element();
		const grip = itemOf("Fixes that run themselves").querySelector(
			':scope > [aria-hidden="true"]',
		)!;
		expect(contrast(getComputedStyle(count).color, count)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(getComputedStyle(advanced).color, advanced)).toBeGreaterThanOrEqual(4.5);
		expect(contrast(getComputedStyle(grip).color, grip.parentElement!)).toBeGreaterThanOrEqual(3);
	});

	it("draws a placeholder that names its control at text contrast", async () => {
		showMode(mode);
		await openShowcase();

		await page.getByRole("button", { name: "Add item" }).first().click();
		const title = page.getByRole("textbox", { name: "Title", exact: true }).last();
		await expect.element(title).toBeVisible();
		const input = title.element() as HTMLInputElement;
		input.blur();
		await userEvent.hover(page.getByText("Label above headline"));
		expect(input.placeholder).toBe("Title");
		expect(contrast(getComputedStyle(input, "::placeholder").color, input)).toBeGreaterThanOrEqual(
			4.5,
		);
	});
});

describe.each([
	["a desktop", 1280],
	["a phone", 390],
] as const)("Closed item rows at %s width", (_, width) => {
	it("give a title its width before its summary and never show a stub of a summary", async () => {
		await page.viewport(width, 844);
		await renderEditor([faqBlock], [faq]);
		await toggle("FAQ").click();
		const rows = faqBlock.questions.map(({ question }) => {
			const name = nameOf(question);
			const summary = document.getElementById(
				toggle(question)
					.getAttribute("aria-describedby")!
					.split(" ")
					.find((id) => id.endsWith("-summary"))!,
			)!;
			return { question, titleCut: truncated(name), summaryWidth: shownWidth(summary) };
		});

		for (const row of rows) {
			if (row.titleCut)
				expect(row, "a cut title leaves no summary").toMatchObject({ summaryWidth: 0 });
			if (row.summaryWidth > 0) expect(row.summaryWidth, row.question).toBeGreaterThanOrEqual(64);
		}
		expect(rows[0]!.titleCut).toBe(true);
		expect(rows.some((row) => !row.titleCut && row.summaryWidth > 0)).toBe(true);
	});
});

describe("Blocks field photos, tables and picker", () => {
	it("draws a photo's edge faintly inside the image, and keeps the settings' rule clear of it", async () => {
		await openShowcase();

		const image = page
			.getByRole("group", { name: "Background image", exact: true })
			.element()
			.querySelector("img")!;
		const style = getComputedStyle(image);
		const outward =
			style.outlineStyle === "none"
				? 0
				: Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
		expect(outward).toBeLessThanOrEqual(0);
		expect(edges(image)).toEqual([]);
		expect(rgba(style.outlineColor)[3]).toBeLessThanOrEqual(0.15);

		const photoBottom = image.getBoundingClientRect().bottom;
		const settingsTop = page
			.getByRole("group", { name: "Primary button text", exact: true })
			.element()
			.getBoundingClientRect().top;
		const rules = [...document.querySelectorAll("#field-content *")].filter((element) => {
			const box = element.getBoundingClientRect();
			const border = getComputedStyle(element);
			return (
				box.top >= photoBottom - 1 &&
				box.top <= settingsTop &&
				border.borderTopStyle !== "none" &&
				Number.parseFloat(border.borderTopWidth) > 0
			);
		});
		expect(rules).toHaveLength(1);
		expect(rules[0]!.getBoundingClientRect().top - photoBottom).toBeGreaterThanOrEqual(10);
		expect(settingsTop - photoBottom).toBeGreaterThanOrEqual(16);
	});

	it("lines up the digits in a table's cells", async () => {
		await openShowcase();

		for (const name of ["Value 1", "Value 2"]) {
			expect(getComputedStyle(control(name)).fontVariantNumeric).toContain("tabular-nums");
		}
	});

	it("names block types in the picker at the size of the rows they create", async () => {
		await renderEditor([showcaseBlock], [showcase, faq]);
		const rowName = getComputedStyle(nameOf("Showcase")).fontSize;
		const rowIcon = toggle("Showcase").querySelectorAll("svg")[1]!.getBoundingClientRect().width;

		await page.getByRole("button", { name: "Add block", exact: true }).click();
		const option = page.getByRole("option", { name: /^FAQ/ }).element();
		// The picker scales in as it opens.
		await expect.poll(() => document.getAnimations().length).toBe(0);
		expect(getComputedStyle(page.getByText("FAQ", { exact: true }).last().element()).fontSize).toBe(
			rowName,
		);
		expect(option.querySelector("svg")!.getBoundingClientRect().width).toBe(rowIcon);
	});
});
