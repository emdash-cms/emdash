import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent, type Locator } from "vitest/browser";

import "../../dist/styles.css";
import {
	ContentEditor,
	type ContentEditorProps,
	type FieldDescriptor,
} from "../../src/components/ContentEditor.js";
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

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: (props: { open: boolean }) =>
		props.open
			? createPortal(<div role="dialog" aria-label="Media library" />, document.body)
			: null,
}));

const LINK_PATTERN = "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$";
const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";
const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control";

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

const hero = blockType("hero", "Hero", [
	{ slug: "headline", label: "Headline", type: "string", required: true },
	{ slug: "subheadline", label: "Second sentence (shown muted after the headline)", type: "text" },
	{ slug: "tagline", label: "Tagline", type: "text", validation: { maxLength: 60 } },
	{ slug: "image", label: "Image", type: "image" },
	{
		slug: "image_caption",
		label: "Image caption (shown on the photo)",
		type: "string",
		validation: { maxLength: 80 },
	},
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{
		slug: "primary_cta_url",
		label: "Primary button link (starts with /, https://, mailto:, tel: or #)",
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
	{ slug: "secondary_cta_label", label: "Secondary button text", type: "string" },
	{
		slug: "secondary_cta_url",
		label: "Secondary button link (starts with /, https://, mailto:, tel: or #)",
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
	{
		slug: "anchor_id",
		label: "Section ID (lowercase, for links like /#pricing)",
		type: "string",
		validation: { pattern: "^(?:$|[a-z][a-z0-9_-]*)$" },
	},
]);

const heroBlock = {
	_type: "hero",
	_version: 1,
	_key: "hero-1",
	headline: "Every building, running at its best.",
	subheadline: "Halden finds the waste and fixes it.",
	tagline: "Hello",
	image: { id: "media-1", src: PHOTO, alt: "" },
	image_caption: "Riverside Tower",
	primary_cta_label: "Book a demo",
	primary_cta_url: "/contact",
	secondary_cta_label: "Talk to sales",
	secondary_cta_url: "mailto:sales@example.com",
	anchor_id: "hero",
};

// The schema puts Icon first, but an item draws its title in its head, then its stacked
// fields, then its settings rows.
const features = blockType("features", "Features", [
	{ slug: "headline", label: "Headline", type: "string" },
	{
		slug: "features",
		label: "Features",
		type: "repeater",
		validation: {
			subFields: [
				{
					slug: "icon",
					label: "Icon",
					type: "select",
					required: true,
					options: ["gauge", "bell"],
				},
				{ slug: "title", label: "Title", type: "string", required: true },
				{ slug: "description", label: "Description", type: "text", required: true },
			],
		},
	},
]);

const featuresBlock = {
	_type: "features",
	_version: 1,
	_key: "features-1",
	headline: "One platform",
	features: [{ icon: "gauge", title: "Every meter", description: "All in one view." }],
};

const card = blockType("card", "Card", [
	{ slug: "headline", label: "Headline", type: "string" },
	{ slug: "photo", label: "Photo", type: "image" },
]);

function makeItem(content: unknown[]): ContentItem {
	return {
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
}

function renderEditor(
	content: unknown[],
	blockTypes: BlockType[],
	props: Partial<ContentEditorProps> = {},
) {
	const fields: Record<string, FieldDescriptor> = {
		title: { kind: "string", label: "Title" },
		content: {
			kind: "blocks",
			label: "Content",
			validation: { allowedTypes: blockTypes.map((type) => type.slug), retiredTypes: [] },
			blockTypes,
		},
	};
	return render(
		<ContentEditor
			collection="pages"
			collectionLabel="Page"
			fields={fields}
			isNew={false}
			item={makeItem(content)}
			onSave={vi.fn()}
			{...props}
		/>,
		{ wrapper: Toasty },
	);
}

function box(target: Locator | Element): DOMRect {
	return (target instanceof Element ? target : target.element()).getBoundingClientRect();
}

function control(name: string): Locator {
	return page.getByRole("textbox", { name, exact: true });
}

/** The element showing `text` on screen, leaving out copies kept for screen readers. */
function shownText(text: string, within: Element = document.body): Element | undefined {
	return [...within.querySelectorAll("*")].find(
		(element) =>
			[...element.childNodes].some((node) => node.nodeType === 3 && node.textContent === text) &&
			!element.closest(".sr-only, [hidden]") &&
			element.getBoundingClientRect().width > 1 &&
			element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
	);
}

/** The label element that names `target`. */
function labelOf(target: Locator): HTMLElement {
	return document.getElementById(target.element().getAttribute("aria-labelledby")!)!;
}

function overlaps(a: DOMRect, b: DOMRect): boolean {
	return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

/** Every element in the field holding visible text, but `except`. */
function textBoxes(except: Element): DOMRect[] {
	const field = document.querySelector("[data-blocks-field]")!;
	return [...field.querySelectorAll("*")]
		.filter(
			(element) =>
				!except.contains(element) &&
				!element.contains(except) &&
				[...element.childNodes].some((node) => node.nodeType === 3 && node.textContent?.trim()) &&
				!element.closest(".sr-only, [hidden]") &&
				element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
		)
		.map((element) => element.getBoundingClientRect());
}

/** Where each control and list item sits in the blocks field. */
function rowTops(): number[] {
	const top = document.querySelector("[data-blocks-field]")!.getBoundingClientRect().top;
	return Array.from(
		document.querySelectorAll('[class~="group/control"], [data-list-item]'),
		(element) => element.getBoundingClientRect().top - top,
	);
}

async function openBlock(name: string) {
	await page.getByRole("button", { name, exact: true }).click();
	await expect.poll(() => document.getAnimations().length).toBe(0);
}

async function save() {
	await page.getByRole("textbox", { name: "Title" }).first().fill("Home page");
	await page.getByRole("button", { name: "Save" }).first().click();
}

afterEach(async () => {
	document.documentElement.dir = "ltr";
	await page.viewport(1280, 800);
});

describe("A field's notes", () => {
	it("counts a field's characters at the end of its label's line while it has focus", async () => {
		await renderEditor([heroBlock], [hero]);
		await openBlock("Hero");

		await control("Tagline").click();
		await expect.poll(() => shownText("5 of 60 characters")).toBeDefined();
		const count = shownText("5 of 60 characters")!;
		const label = labelOf(control("Tagline"));
		expect(label.contains(count)).toBe(true);
		expect(Math.abs(box(count).right - box(control("Tagline")).right)).toBeLessThan(12);
		expect(textBoxes(label).filter((rect) => overlaps(rect, box(count)))).toEqual([]);
	});

	it("counts an unlabelled control's characters at the end of its own line, with its text kept clear of them", async () => {
		await renderEditor([heroBlock], [hero]);
		await openBlock("Hero");
		const tops = rowTops();

		const caption = control("Image caption (shown on the photo)");
		await caption.click();
		await userEvent.keyboard(" at dusk");
		await expect.poll(() => shownText("23 of 80 characters")).toBeDefined();
		const count = box(shownText("23 of 80 characters")!);
		const input = caption.element() as HTMLInputElement;
		const field = box(input);
		expect(count.top).toBeGreaterThanOrEqual(field.top - 0.5);
		expect(count.bottom).toBeLessThanOrEqual(field.bottom + 0.5);
		const textEnd = () => field.right - Number.parseFloat(getComputedStyle(input).paddingRight);
		await expect.poll(textEnd).toBeLessThanOrEqual(count.left + 0.5);
		expect(textEnd()).toBeGreaterThan(field.left + field.width / 3);
		expect(rowTops()).toEqual(tops);
	});
});

describe("A field's problems", () => {
	it("says an empty required field's problem as text on its label's line, once", async () => {
		await renderEditor([{ ...heroBlock, headline: "" }], [hero]);
		await save();

		const headline = control("Headline");
		await expect.element(headline).toHaveFocus();
		await expect.element(headline).toHaveAttribute("aria-invalid", "true");
		await expect.element(headline).toHaveAccessibleDescription("Required");
		(headline.element() as HTMLElement).blur();
		await expect.poll(() => document.getAnimations().length).toBe(0);
		const label = labelOf(headline);
		const message = shownText("Required", label);
		expect(message).toBeDefined();
		expect(box(message!).top).toBeGreaterThanOrEqual(box(label).top - 0.5);
		expect(box(message!).bottom).toBeLessThanOrEqual(box(label).bottom + 0.5);
		// The label's line says it, so the empty control doesn't say it again.
		expect(headline.element().getAttribute("placeholder")).not.toBe("Required");
		expect(getComputedStyle(message!).color).not.toBe(getComputedStyle(label).color);
	});

	it("says an empty required item title's problem at the end of its line, without growing the head", async () => {
		await renderEditor([featuresBlock], [features]);
		await openBlock("Features");
		const closedHead = box(
			page.getByRole("button", { name: "Every meter", exact: true }).element().parentElement!,
		);
		await page.getByRole("button", { name: "Add item" }).click();
		const title = page.getByRole("textbox", { name: "Title", exact: true }).last();
		await expect.element(title).toHaveFocus();
		await save();

		await expect.element(title).toHaveFocus();
		(title.element() as HTMLElement).blur();
		const head = title.element().closest("[data-item-control]")!.parentElement!;
		const message = shownText("Required", head);
		expect(message).toBeDefined();
		expect(box(message!).left).toBeGreaterThan(box(title).left + box(title).width / 2);
		expect(box(head).height).toBe(closedHead.height);
		await expect.element(title).toHaveAttribute("placeholder", "Title");
	});
});

describe("Saving with problems", () => {
	it("focuses the first problem on screen, not in the schema's order, and says how many there are", async () => {
		await renderEditor([featuresBlock], [features]);
		await openBlock("Features");
		await page.getByRole("button", { name: "Add item" }).click();
		const title = page.getByRole("textbox", { name: "Title", exact: true }).last();
		await expect.element(title).toHaveFocus();
		await userEvent.keyboard("Live alerts");

		await save();
		const descriptions = page.getByRole("textbox", { name: "Description", exact: true });
		await expect.element(descriptions.last()).toHaveFocus();
		const live = [...document.querySelectorAll("[data-blocks-field] [aria-live]")];
		await expect
			.poll(() => live.map((region) => region.textContent).join(" "))
			.toContain("2 fields need attention");
	});
});

describe("Undo", () => {
	async function deleteFromMenu(name: string, { keyboard }: { keyboard: boolean }) {
		const menu = page.getByRole("button", { name: `${name} actions`, exact: true });
		if (keyboard) {
			menu.element().focus();
			await userEvent.keyboard("{Enter}");
			const item = page.getByRole("menuitem", { name: "Delete" });
			await expect.element(item).toBeVisible();
			(item.element() as HTMLElement).focus();
			await userEvent.keyboard("{Enter}");
		} else {
			await menu.click();
			await page.getByRole("menuitem", { name: "Delete" }).click();
		}
	}

	it("puts a deleted block back with Mod+Z while focus is not somewhere to type", async () => {
		await renderEditor([heroBlock, featuresBlock], [hero, features]);
		await deleteFromMenu("Hero", { keyboard: true });
		await expect.element(page.getByText("Deleted Hero")).toBeVisible();
		await expect.element(page.getByRole("button", { name: "Features", exact: true })).toHaveFocus();
		await expect
			.element(page.getByRole("button", { name: "Undo" }))
			.toHaveAttribute("aria-keyshortcuts", `${MOD}+Z`);

		await page.getByRole("textbox", { name: "Title" }).first().click();
		await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
		expect(page.getByRole("button", { name: "Hero", exact: true }).query()).toBeNull();

		page.getByRole("button", { name: "Features", exact: true }).element().focus();
		await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
		await expect.element(page.getByRole("button", { name: "Hero", exact: true })).toHaveFocus();
		await expect.element(page.getByText("Deleted Hero")).not.toBeInTheDocument();
	});

	it("keeps Undo open past the usual few seconds after a deletion made from the keyboard", async () => {
		await renderEditor([heroBlock, featuresBlock], [hero, features]);
		await deleteFromMenu("Hero", { keyboard: true });
		await expect.element(page.getByText("Deleted Hero")).toBeVisible();
		await new Promise((resolve) => setTimeout(resolve, 7000));
		await expect.element(page.getByText("Deleted Hero")).toBeVisible();
	}, 20_000);

	it("offers Undo for a removed photo, and keeps focus in its slot", async () => {
		await renderEditor(
			[
				{
					_type: "card",
					_version: 1,
					_key: "card-1",
					headline: "Hi",
					photo: { id: "m", src: PHOTO },
				},
			],
			[card],
		);
		await openBlock("Card");
		const photo = page.getByRole("group", { name: "Photo", exact: true });

		photo.getByRole("button", { name: "Remove image" }).element().focus();
		await userEvent.keyboard("{Enter}");
		const select = photo.getByRole("button", { name: "Select image" });
		await expect.element(select).toHaveFocus();
		await expect.element(page.getByText("Removed Photo")).toBeVisible();

		await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
		await expect.poll(() => photo.element().querySelector("img")?.getAttribute("src")).toBe(PHOTO);
		await expect.element(photo.getByRole("button", { name: "Replace" })).toHaveFocus();
		await expect.element(page.getByText("Removed Photo")).not.toBeInTheDocument();

		await photo.getByRole("button", { name: "Remove image" }).click();
		await page.getByRole("button", { name: "Undo" }).click();
		await expect.poll(() => photo.element().querySelector("img")?.getAttribute("src")).toBe(PHOTO);
	});
});

describe("Autosave paused", () => {
	it("waits while you're still in the block with the problem, then names the field", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			const onAutosave = vi.fn();
			await renderEditor([heroBlock, featuresBlock], [hero, features], { onAutosave });
			await openBlock("Features");
			await page.getByRole("button", { name: "Add item" }).click();
			await userEvent.keyboard("Live alerts");
			await vi.advanceTimersByTimeAsync(3000);
			expect(onAutosave).not.toHaveBeenCalled();
			expect(page.getByText("Autosave paused").query()).toBeNull();

			await page.getByRole("textbox", { name: "Title" }).first().click();
			await expect.element(page.getByText("Autosave paused")).toBeVisible();
			await expect
				.element(page.getByText("Fix Description in the Features block to resume saving."))
				.toBeVisible();
		} finally {
			vi.useRealTimers();
		}
	});
});

describe("Spacing on a narrow screen", () => {
	it("keeps stacked settings and Advanced at the field gap, and a larger step under a photo", async () => {
		await page.viewport(400, 800);
		const cta = blockType("cta", "Call to action", [
			{ slug: "headline", label: "Headline", type: "string" },
			{ slug: "body", label: "Body", type: "text" },
			{ slug: "image", label: "Background image", type: "image" },
			{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
			{ slug: "primary_cta_url", label: "Primary button link", type: "string" },
			{ slug: "secondary_cta_label", label: "Secondary button text", type: "string" },
			{ slug: "secondary_cta_url", label: "Secondary button link", type: "string" },
			{ slug: "anchor_id", label: "Section ID", type: "string" },
		]);
		await renderEditor(
			[
				{
					_type: "cta",
					_version: 1,
					_key: "cta-1",
					headline: "See what you could save.",
					body: "Book a walkthrough.",
					image: { id: "m", src: PHOTO },
					primary_cta_label: "Book a demo",
					primary_cta_url: "/contact",
					secondary_cta_label: "Talk to sales",
					secondary_cta_url: "mailto:sales@example.com",
				},
			],
			[cta],
		);
		await openBlock("Call to action");

		/** From the bottom of a control's text to the top of the next text. */
		const textBox = (element: Element) => {
			if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) {
				const rect = element.getBoundingClientRect();
				const style = getComputedStyle(element);
				const line = Number.parseFloat(style.lineHeight) || 20;
				const top =
					element instanceof HTMLTextAreaElement
						? rect.top + Number.parseFloat(style.paddingTop)
						: rect.top + (rect.height - line) / 2;
				return {
					top,
					bottom:
						element instanceof HTMLTextAreaElement
							? rect.bottom - Number.parseFloat(style.paddingBottom)
							: top + line,
				};
			}
			const range = document.createRange();
			range.selectNodeContents(element);
			const rect = range.getBoundingClientRect();
			return { top: rect.top, bottom: rect.bottom };
		};
		const textOf = (name: string) =>
			page
				.getByText(name, { exact: true })
				.elements()
				.find((element) => element.checkVisibility())!;
		const gap = (above: Element, below: Element) => textBox(below).top - textBox(above).bottom;

		const field = gap(control("Headline").element(), textOf("Body"));
		const settings = gap(control("Primary button text").element(), textOf("Secondary button text"));
		const advanced = gap(control("Secondary button text").element(), textOf("Advanced"));
		const photo = document.querySelector('[data-block-key="cta-1"] [data-block-body] img')!;
		const zone = textBox(textOf("Primary button text")).top - box(photo).bottom;

		expect(Math.abs(settings - field)).toBeLessThanOrEqual(2);
		expect(Math.abs(advanced - field)).toBeLessThanOrEqual(2);
		expect(zone).toBeGreaterThanOrEqual(field + 4);
	});
});
