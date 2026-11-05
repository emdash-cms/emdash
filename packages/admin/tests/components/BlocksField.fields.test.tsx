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
			? createPortal(
					<div role="dialog" aria-label="Media library">
						<button type="button" autoFocus>
							Upload
						</button>
					</div>,
					document.body,
				)
			: null,
}));

const LINK_PATTERN = "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$";
const PRIMARY_LINK = "Primary button link (starts with /, https://, mailto:, tel: or #)";
const CAPTION = "Image caption (shown on the photo)";
const ANNOUNCEMENT = "Announcement (shown above the headline)";
const ANNOUNCEMENT_LINK = "Announcement link (starts with /, https://, mailto:, tel: or #)";
const SECTION_ID = "Section ID (lowercase, for links like /#pricing)";
const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";

const heroFields: BlockFieldDefinition[] = [
	{ slug: "headline", label: "Headline", type: "string", required: true },
	{ slug: "subheadline", label: "Subheadline", type: "text" },
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{
		slug: "primary_cta_url",
		label: PRIMARY_LINK,
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
	{ slug: "image", label: "Image", type: "image" },
	{ slug: "image_caption", label: CAPTION, type: "string" },
	{ slug: "eyebrow", label: ANNOUNCEMENT, type: "string" },
	{
		slug: "eyebrow_url",
		label: ANNOUNCEMENT_LINK,
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
	{ slug: "centered", label: "Center the layout", type: "boolean", defaultValue: false },
	{
		slug: "anchor_id",
		label: SECTION_ID,
		type: "string",
		validation: { pattern: "^(?:$|[a-z][a-z0-9_-]*)$" },
	},
];

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

const hero = blockType("hero", "Hero", heroFields);

const heroBlock = {
	_type: "hero",
	_version: 1,
	_key: "hero-1",
	headline: "Every building, running at its best.",
	subheadline: "Halden finds the waste and fixes it.",
	primary_cta_label: "Book a demo",
	primary_cta_url: "/contact",
	image: { id: "media-1", src: PHOTO, alt: "" },
	centered: false,
};

function fieldsFor(blockTypes: BlockType[]): Record<string, FieldDescriptor> {
	return {
		title: { kind: "string", label: "Title" },
		content: {
			kind: "blocks",
			label: "Content",
			validation: { allowedTypes: blockTypes.map((type) => type.slug), retiredTypes: [] },
			blockTypes,
		},
	};
}

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
	blockTypes: BlockType[] = [hero],
	props: Partial<ContentEditorProps> = {},
) {
	return render(
		<ContentEditor
			collection="pages"
			collectionLabel="Page"
			fields={fieldsFor(blockTypes)}
			isNew={false}
			item={makeItem(content)}
			onSave={vi.fn()}
			{...props}
		/>,
		{ wrapper: Toasty },
	);
}

function box(locator: Locator): DOMRect {
	return locator.element().getBoundingClientRect();
}

/** How far down its block `locator` sits, wherever the page is scrolled to. */
function topInBlock(locator: Locator): number {
	const block = locator.element().closest("[data-block-key]")!;
	return box(locator).top - block.getBoundingClientRect().top;
}

function control(name: string): Locator {
	return page.getByRole("textbox", { name, exact: true });
}

async function openBlock(name = "Hero") {
	await page.getByRole("button", { name, exact: true }).click();
}

afterEach(async () => {
	document.documentElement.dir = "ltr";
	await page.viewport(1280, 800);
});

describe("Fields inside a block", () => {
	it("shows a Hero's content first, then its settings rows, then the section ID under Advanced", async () => {
		await renderEditor([{ ...heroBlock, anchor_id: "pricing" }]);
		await openBlock();

		const headline = control("Headline");
		const subheadline = control("Subheadline");
		const photo = page.getByRole("group", { name: "Image", exact: true });
		const caption = control(CAPTION);
		const buttonText = control("Primary button text");
		const buttonLink = control(PRIMARY_LINK);
		const announcement = page.getByRole("group", { name: ANNOUNCEMENT, exact: true });
		const centered = page.getByRole("switch", { name: "Center the layout" });
		const advanced = page.getByRole("button", { name: /^Advanced/ });

		const tops = [
			headline,
			subheadline,
			photo,
			caption,
			buttonText,
			announcement,
			centered,
			advanced,
		].map((locator) => box(locator).top);
		expect(tops).toEqual(tops.toSorted((a, b) => a - b));
		expect(new Set(tops).size).toBe(tops.length);

		const headlineStyle = getComputedStyle(headline.element());
		const subheadlineStyle = getComputedStyle(subheadline.element());
		const heroToggle = page.getByRole("button", { name: "Hero", exact: true }).element();
		const blockName = document.getElementById(heroToggle.getAttribute("aria-labelledby")!)!;
		expect(Number.parseFloat(headlineStyle.fontSize)).toBeGreaterThan(
			Number.parseFloat(subheadlineStyle.fontSize),
		);
		expect(Number(headlineStyle.fontWeight)).toBeGreaterThan(Number(subheadlineStyle.fontWeight));
		expect(Number(headlineStyle.fontWeight)).toBeLessThan(
			Number(getComputedStyle(blockName).fontWeight),
		);

		const primary = page.getByRole("group", { name: "Primary button text", exact: true });
		await expect
			.element(primary.getByRole("textbox", { name: "Primary button text", exact: true }))
			.toHaveValue("Book a demo");
		await expect
			.element(primary.getByRole("textbox", { name: PRIMARY_LINK, exact: true }))
			.toHaveValue("/contact");
		expect(Math.abs(box(buttonText).top - box(buttonLink).top)).toBeLessThan(2);
		expect(box(buttonText).right).toBeLessThanOrEqual(box(buttonLink).left);
		const rowLabel = () => shownText("Primary button text", primary.element());
		await expect.poll(rowLabel).toBeDefined();
		expect(rowLabel()!.getBoundingClientRect().right).toBeLessThanOrEqual(box(buttonText).left);

		await expect.element(advanced).toHaveAttribute("aria-expanded", "false");
		await expect.element(advanced).toHaveTextContent("pricing");
		expect(control(SECTION_ID).query()).toBeNull();
		await advanced.click();
		await expect.element(control(SECTION_ID)).toHaveValue("pricing");
	});

	it("gives fields whose names match no convention a row of their own", async () => {
		const plain = blockType("plain", "Plain", [
			{ slug: "intro", label: "Intro", type: "text" },
			{ slug: "button", label: "Button", type: "string" },
			{ slug: "destination", label: "Destination", type: "url" },
			{ slug: "picture", label: "Picture", type: "image" },
			{ slug: "caption", label: "Caption", type: "string" },
			{ slug: "section", label: "Section", type: "string" },
		]);
		await renderEditor([{ _type: "plain", _version: 1, _key: "plain-1" }], [plain]);
		await openBlock("Plain");

		for (const name of ["Intro", "Button", "Caption", "Section", "Destination"]) {
			await expect.element(page.getByText(name, { exact: true })).toBeVisible();
			await expect.element(control(name)).toBeVisible();
		}
		expect(page.getByRole("group", { name: "Button" }).query()).toBeNull();
		expect(page.getByRole("button", { name: /^Advanced/ }).query()).toBeNull();
		expect(box(control("Caption")).top).toBeGreaterThan(
			box(page.getByRole("group", { name: "Picture" })).bottom,
		);
		expect(box(control("Destination")).top).toBeGreaterThan(box(control("Section")).bottom);
	});

	it("shows a field's character count after its whole label, at the end of the label's line", async () => {
		const quote = blockType("quote", "Quote", [
			{
				slug: "tagline",
				label: "Tagline (shown above the quote)",
				type: "string",
				validation: { maxLength: 60 },
			},
		]);
		await renderEditor(
			[{ _type: "quote", _version: 1, _key: "quote-1", tagline: "Hello" }],
			[quote],
		);
		await openBlock("Quote");

		const tagline = control("Tagline (shown above the quote)");
		await tagline.click();
		await expect.poll(() => shownText("5 of 60 characters")).toBeDefined();
		const label = shownText("Tagline (shown above the quote)")!.getBoundingClientRect();
		const count = shownText("5 of 60 characters")!.getBoundingClientRect();
		expect(Math.abs(count.top + count.height / 2 - (label.top + label.height / 2))).toBeLessThan(1);
		expect(count.left).toBeGreaterThan(label.right);
		expect(count.top).toBeLessThan(box(tagline).top);
	});

	it("keeps the Text and Link placeholders in a button row", async () => {
		await renderEditor([{ ...heroBlock, eyebrow: "New: reports" }]);
		await openBlock();

		await expect.element(control(ANNOUNCEMENT)).toHaveValue("New: reports");
		await expect.element(control(ANNOUNCEMENT_LINK)).toHaveAttribute("placeholder", "Link");
		await expect.element(control(ANNOUNCEMENT_LINK)).not.toHaveAccessibleDescription();
		await expect.element(control("Primary button text")).toHaveAttribute("placeholder", "Text");
	});

	it("starts a text area one line tall and grows it with its content", async () => {
		await renderEditor([{ ...heroBlock, subheadline: "" }]);
		await openBlock();

		const subheadline = control("Subheadline");
		const oneLine = box(subheadline).height;
		expect(oneLine).toBeLessThan(40);
		await subheadline.fill("One\nTwo\nThree\nFour");
		await expect.poll(() => box(subheadline).height).toBeGreaterThan(oneLine + 40);
		expect(subheadline.element().scrollHeight).toBeLessThanOrEqual(
			subheadline.element().clientHeight,
		);
	});

	it.each(["ltr", "rtl"] as const)(
		"lines left-to-right values up with their labels (%s)",
		async (dir) => {
			document.documentElement.dir = dir;
			await renderEditor([heroBlock]);
			await openBlock();

			const headline = control("Headline");
			const link = control(PRIMARY_LINK);
			for (const value of [headline, link]) {
				expect(getComputedStyle(value.element()).direction).toBe("ltr");
				expect(getComputedStyle(value.element()).textAlign).toBe(dir === "rtl" ? "end" : "start");
			}

			const labelText = document.createRange();
			labelText.selectNodeContents(page.getByText("Headline", { exact: true }).element());
			const label = labelText.getBoundingClientRect();
			const value = box(headline);
			const padding = Number.parseFloat(getComputedStyle(headline.element()).paddingInlineStart);
			if (dir === "rtl") {
				expect(Math.abs(label.right - (value.right - padding))).toBeLessThan(2);
			} else {
				expect(Math.abs(label.left - (value.left + padding))).toBeLessThan(2);
			}
		},
	);

	it("stacks a settings row's label above its value when the field is narrow", async () => {
		await renderEditor([heroBlock]);
		await openBlock();
		const label = page.getByText("Center the layout", { exact: true });
		const centered = page.getByRole("switch", { name: "Center the layout" });
		expect(box(label).right).toBeLessThanOrEqual(box(centered).left);
		expect(Math.abs(box(label).top - box(centered).top)).toBeLessThan(12);

		await page.viewport(400, 800);
		await expect.poll(() => box(label).bottom).toBeLessThanOrEqual(box(centered).top);
		expect(box(label).left).toBeLessThanOrEqual(box(centered).left + 8);
	});

	it("shows a field's character count only while it has focus", async () => {
		const note = blockType("note", "Note", [
			{ slug: "name", label: "Name", type: "string", validation: { maxLength: 40 } },
			{ slug: "body", label: "Body", type: "text" },
		]);
		await renderEditor([{ _type: "note", _version: 1, _key: "note-1", name: "Hello" }], [note]);
		await openBlock("Note");

		const count = page.getByText("5 of 40 characters");
		await expect.element(count).not.toBeVisible();
		await control("Name").click();
		await expect.element(count).toBeVisible();
		await control("Body").click();
		await expect.element(count).not.toBeVisible();
	});

	it("opens a choice's options in a short popup lined up with its value, and follows the keyboard", async () => {
		const icons = ["star", "check", "lock", "clock", "cloud", "building", "leaf", "gauge"];
		const feature = blockType("feature", "Feature", [
			{
				slug: "icon",
				label: "Icon",
				type: "select",
				validation: { options: [...icons, "thermometer", "plug", "bell", "file", "flame", "sun"] },
			},
		]);
		await renderEditor(
			[{ _type: "feature", _version: 1, _key: "feature-1", icon: "gauge" }],
			[feature],
		);
		await openBlock("Feature");

		const icon = page.getByRole("combobox", { name: "Icon" });
		await icon.click();
		const listbox = page.getByRole("listbox");
		await expect.element(listbox).toBeVisible();
		const popup = listbox.element().parentElement!;
		await expect.poll(() => getComputedStyle(popup).opacity).toBe("1");

		const popupBox = popup.getBoundingClientRect();
		const triggerBox = box(icon);
		expect(popupBox.width).toBeLessThan(triggerBox.width);
		expect(popupBox.height).toBeLessThanOrEqual(280);
		expect(popupBox.top).toBeGreaterThanOrEqual(0);
		expect(popupBox.bottom).toBeLessThanOrEqual(window.innerHeight);
		expect(popupBox.top - triggerBox.bottom).toBeCloseTo(4, 0);

		const textLeft = (el: Element) => {
			const range = document.createRange();
			range.selectNodeContents(el);
			return range.getBoundingClientRect().left;
		};
		const firstOption = page.getByRole("option", { name: "star" }).element();
		const value = icon.element().querySelector("span")!;
		expect(
			Math.abs(textLeft(firstOption.firstElementChild!) - textLeft(value)),
		).toBeLessThanOrEqual(1);

		await userEvent.keyboard("{Escape}");
		await expect.element(icon).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect.element(listbox).toBeVisible();
		await userEvent.keyboard("{ArrowDown}{Enter}");
		await expect.element(icon).toHaveTextContent("thermometer");
		await expect.element(icon).toHaveFocus();
	});

	it("grows a choice's option to fit a label that wraps, so it never runs into the next", async () => {
		const long = "A choice whose label is long enough to wrap onto a second line inside the popup";
		const feature = blockType("feature", "Feature", [
			{
				slug: "icon",
				label: "Icon",
				type: "select",
				validation: { options: [long, "star", "gauge"] },
			},
		]);
		await renderEditor(
			[{ _type: "feature", _version: 1, _key: "feature-1", icon: "gauge" }],
			[feature],
		);
		await openBlock("Feature");

		await page.getByRole("combobox", { name: "Icon" }).click();
		const listbox = page.getByRole("listbox");
		await expect.element(listbox).toBeVisible();
		await expect.poll(() => listbox.element().parentElement!.getAnimations().length).toBe(0);
		const options = page
			.getByRole("option")
			.elements()
			.map((option) => option.getBoundingClientRect());
		const text = document.createRange();
		text.selectNodeContents(page.getByRole("option", { name: long }).element());
		const textBox = text.getBoundingClientRect();

		expect(textBox.height).toBeGreaterThan(30);
		expect(textBox.top).toBeGreaterThanOrEqual(options[0]!.top);
		expect(textBox.bottom).toBeLessThanOrEqual(options[0]!.bottom);
		for (const [index, option] of options.entries()) {
			const next = options[index + 1];
			if (next) expect(option.bottom).toBeLessThanOrEqual(next.top + 0.5);
		}
		expect(options.slice(1).map((option) => option.height)).toEqual([32, 32]);
		await userEvent.keyboard("{Escape}");
	});

	it("sets a settings row's label in its value's size, on its value's baseline", async () => {
		const feature = blockType("feature", "Feature", [
			{ slug: "icon", label: "Icon", type: "select", validation: { options: ["star", "gauge"] } },
		]);
		await renderEditor(
			[{ _type: "feature", _version: 1, _key: "feature-1", icon: "gauge" }],
			[feature],
		);
		await openBlock("Feature");

		const label = page
			.getByText("Icon", { exact: true })
			.elements()
			.find((element) => element.closest("label"))!;
		const value = page.getByRole("combobox", { name: "Icon" }).getByText("gauge").element();
		// A 0x0 inline block after the text rests on its baseline.
		const baseline = (element: Element) => {
			const probe = document.createElement("span");
			probe.style.cssText = "display:inline-block;width:0;height:0;vertical-align:baseline";
			element.append(probe);
			const top = probe.getBoundingClientRect().top;
			probe.remove();
			return top;
		};
		expect(getComputedStyle(label).fontSize).toBe(getComputedStyle(value).fontSize);
		expect(Math.abs(baseline(label) - baseline(value))).toBeLessThan(0.5);
	});

	it("says so when a block has no fields", async () => {
		await renderEditor(
			[{ _type: "divider", _version: 1, _key: "divider-1" }],
			[blockType("divider", "Divider", [])],
		);
		await openBlock("Divider");

		await expect.element(page.getByText("This block has no fields.")).toBeVisible();
	});
});

const logoWall = blockType("logos", "Logo wall", [
	{ slug: "headline", label: "Section label", type: "string" },
	{ slug: "logo", label: "Featured logo", type: "image", required: true },
	{ slug: "code", label: "Code", type: "string", validation: { pattern: "^[a-z]+$" } },
	{
		slug: "logos",
		label: "Logos",
		type: "repeater",
		validation: {
			minItems: 2,
			subFields: [{ slug: "name", label: "Company name", type: "string", required: true }],
		},
	},
]);

function saveButton(): Locator {
	return page.getByRole("button", { name: "Save" }).first();
}

function blockRow(key: string): Locator {
	return page.elementLocator(document.querySelector(`[data-block-key="${key}"]`)!);
}

/** The element showing `text` on screen, leaving out copies kept for screen readers. */
function shownText(text: string, within?: Element): Element | undefined {
	return page
		.getByText(text, { exact: true })
		.elements()
		.find(
			(element) =>
				(!within || within.contains(element)) &&
				!element.closest(".sr-only") &&
				element.checkVisibility({ opacityProperty: true, visibilityProperty: true }),
		);
}

describe("Checking fields inside a block", () => {
	it("shows a failed pattern in the field's row as Check the format, once the field is left", async () => {
		await renderEditor(
			[heroBlock, { _type: "logos", _version: 1, _key: "logos-1", logos: [{}, {}] }],
			[hero, logoWall],
		);
		await openBlock();
		await page.getByRole("button", { name: /^Advanced/ }).click();
		await expect.poll(() => document.getAnimations().length).toBe(0);

		const sectionId = control(SECTION_ID);
		const label = shownText(SECTION_ID)!;
		const quietLabel = getComputedStyle(label).color;
		await sectionId.fill("Pricing!");
		await control("Headline").click();
		await expect.element(sectionId).toHaveAttribute("aria-invalid", "true");
		await expect.element(sectionId).toHaveAccessibleDescription("Check the format");
		// At rest, the problem shows as words in the field's row, not only as a colour.
		const row = label.closest("label")!.parentElement!;
		const problem = "Check the format";
		await expect.poll(() => shownText(problem)).toBeDefined();
		await expect.poll(() => document.getAnimations().length).toBe(0);
		const error = shownText(problem)!.getBoundingClientRect();
		expect(error.top).toBeGreaterThanOrEqual(row.getBoundingClientRect().top);
		expect(error.bottom).toBeLessThanOrEqual(row.getBoundingClientRect().bottom);
		expect(getComputedStyle(label).color).toBe(quietLabel);

		const nextRowTop = topInBlock(control("Headline"));
		await sectionId.click();
		await expect.poll(() => shownText(problem)).toBeDefined();
		expect(topInBlock(control("Headline"))).toBe(nextRowTop);

		await sectionId.fill("pricing");
		await expect.element(sectionId).not.toHaveAttribute("aria-invalid");
		await control("Headline").click();
		await expect.poll(() => shownText(problem)).toBeUndefined();

		await openBlock("Logo wall");
		const code = control("Code");
		await code.fill("ABC");
		await control("Section label").click();
		await expect.element(code).toHaveAccessibleDescription("Check the format");
		await expect.poll(() => shownText("Check the format")).toBeDefined();
	});

	it("shows a label as written, wrapped beside its value, and a failed link as Invalid link alone", async () => {
		const label = "Button link (starts with / or https://)";
		const card = blockType("card", "Card", [
			{ slug: "headline", label: "Headline", type: "string" },
			{ slug: "button_url", label, type: "string", validation: { pattern: LINK_PATTERN } },
		]);
		await renderEditor([{ _type: "card", _version: 1, _key: "card-1", headline: "Hi" }], [card]);
		await openBlock("Card");

		const link = control(label);
		await expect.element(link).toHaveAttribute("placeholder", "Empty");
		await expect.element(link).not.toHaveAccessibleDescription();
		await expect.poll(() => shownText(label)).toBeDefined();
		const text = shownText(label)!;
		expect(text.scrollWidth).toBeLessThanOrEqual(text.clientWidth);
		const range = document.createRange();
		range.selectNodeContents(text);
		const lines = [...range.getClientRects()];
		expect(new Set(lines.map((line) => Math.round(line.top))).size).toBeGreaterThan(1);
		for (const line of lines) expect(line.right).toBeLessThanOrEqual(box(link).left + 0.5);

		await link.fill("example.com");
		await control("Headline").click();
		await expect.element(link).toHaveAttribute("aria-invalid", "true");
		await expect.element(link).toHaveAccessibleDescription("Invalid link");
		await expect.poll(() => shownText("Invalid link")).toBeDefined();
	});

	it("shows nothing on a new block's empty required field you leave untouched, and flags it once you empty it", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(
			"00000000-0000-4000-8000-000000000003",
		);
		await renderEditor([heroBlock]);

		await page.getByRole("button", { name: "Add block", exact: true }).click();
		await page.getByRole("option", { name: /^Hero/ }).click();
		const added = () =>
			document.querySelector('[data-block-key="00000000-0000-4000-8000-000000000003"]')!;
		const headline = control("Headline");
		await expect.element(headline).toHaveFocus();
		expect(added().contains(headline.element())).toBe(true);
		await expect.element(headline).toHaveAttribute("placeholder", "Required");
		const flagged = () => shownText("Required", added());

		await control("Subheadline").click();
		await expect.element(control("Subheadline")).toHaveFocus();
		expect(added().querySelectorAll("[aria-invalid='true']")).toHaveLength(0);
		expect(flagged()).toBeUndefined();

		await headline.fill("Every building");
		await expect.element(headline).not.toHaveAttribute("aria-invalid");
		await headline.fill("");
		await expect.element(headline).toHaveAttribute("aria-invalid", "true");
		await expect.element(headline).toHaveAccessibleDescription("Required");
		await expect.poll(flagged).toBeDefined();
		expect(headline.element().getAttribute("placeholder")).not.toBe("Required");
		expect(added().querySelectorAll("[aria-invalid='true']")).toHaveLength(1);
	});

	it("marks a new block's emptied required field when a click on empty space leaves it", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(
			"00000000-0000-4000-8000-000000000004",
		);
		await renderEditor([heroBlock]);

		await page.getByRole("button", { name: "Add block", exact: true }).click();
		await page.getByRole("option", { name: /^Hero/ }).click();
		const headline = control("Headline");
		await expect.element(headline).toHaveFocus();
		await headline.fill("Every building");
		await headline.fill("");
		await expect.element(headline).not.toHaveAttribute("aria-invalid");

		const emptySpace = document.createElement("div");
		emptySpace.style.height = "40px";
		document.body.append(emptySpace);
		await userEvent.click(emptySpace);
		await expect.element(headline).toHaveAttribute("aria-invalid", "true");
		emptySpace.remove();
	});

	it("keeps a new block's empty required photo quiet while its media picker is open", async () => {
		vi.spyOn(globalThis.crypto, "randomUUID").mockReturnValueOnce(
			"00000000-0000-4000-8000-000000000004",
		);
		await renderEditor([heroBlock], [hero, logoWall]);

		await page.getByRole("button", { name: "Add block", exact: true }).click();
		await page.getByRole("option", { name: /^Logo wall/ }).click();
		const added = blockRow("00000000-0000-4000-8000-000000000004");
		const selectImage = added.getByRole("button", { name: "Select image" });
		await selectImage.click();
		await expect
			.element(page.getByRole("dialog", { name: "Media library" }).getByRole("button"))
			.toHaveFocus();
		await expect.element(selectImage).not.toHaveAccessibleDescription("Required");
		expect(added.element().querySelectorAll("[aria-invalid='true']")).toHaveLength(0);
	});

	it("opens the closed block that fails on Save, focuses the field and marks other failing blocks", async () => {
		const onSave = vi.fn();
		await renderEditor(
			[
				heroBlock,
				{ ...heroBlock, _key: "hero-2", headline: "" },
				{ _type: "logos", _version: 1, _key: "logos-1", logos: [{ name: "Arc" }] },
			],
			[hero, logoWall],
			{ onSave },
		);

		await page.getByRole("textbox", { name: "Title" }).fill("Home page");
		await saveButton().click();

		expect(onSave).not.toHaveBeenCalled();
		await expect
			.element(blockRow("hero-2").getByRole("button", { name: "Hero", exact: true }))
			.toHaveAttribute("aria-expanded", "true");
		const headline = blockRow("hero-2").getByRole("textbox", { name: "Headline", exact: true });
		await expect.element(headline).toHaveFocus();
		await expect.element(headline).toHaveAttribute("aria-invalid", "true");
		await expect
			.element(blockRow("hero-1").getByRole("button", { name: "Hero", exact: true }))
			.toHaveAttribute("aria-expanded", "false");
		expect(blockRow("hero-1").getByRole("img", { name: "Has fields to fix" }).query()).toBeNull();
		const logos = blockRow("logos-1").getByRole("button", { name: "Logo wall", exact: true });
		await expect.element(logos).toHaveAttribute("aria-expanded", "false");
		await expect
			.element(blockRow("logos-1").getByRole("img", { name: "Has fields to fix" }))
			.toBeVisible();
		await expect.element(logos).toHaveAccessibleDescription("Has fields to fix Arc");

		await logos.click();
		await expect.element(page.getByRole("group", { name: "Featured logo" })).toBeVisible();
		await expect
			.element(page.getByRole("button", { name: "Select image" }))
			.toHaveAccessibleDescription("Required");
		const minimum = page.getByText("Add at least 2 items");
		await expect.element(minimum).toBeVisible();
		const listLabel = box(page.getByText("Logos", { exact: true }));
		expect(box(minimum).top).toBeLessThan(listLabel.bottom);
		expect(box(minimum).bottom).toBeGreaterThan(listLabel.top);
		expect(box(minimum).left).toBeGreaterThan(listLabel.right);
	});

	it("marks a required list sub-field where it is and focuses it", async () => {
		await renderEditor(
			[
				{
					_type: "logos",
					_version: 1,
					_key: "logos-1",
					logo: { id: "m", src: PHOTO },
					logos: [{ name: "Arc" }, { name: "" }],
				},
			],
			[logoWall],
		);

		await page.getByRole("textbox", { name: "Title" }).fill("Home page");
		await saveButton().click();
		const second = page.getByRole("textbox", { name: "Company name 2" });
		await expect.element(second).toHaveFocus();
		await expect.element(second).toHaveAttribute("aria-invalid", "true");
		await expect
			.element(page.getByRole("textbox", { name: "Company name 1" }))
			.not.toHaveAttribute("aria-invalid");
	});

	it("describes an empty required choice as Required and marks it invalid on Save", async () => {
		const banner = blockType("banner", "Banner", [
			{ slug: "headline", label: "Headline", type: "string" },
			{
				slug: "tone",
				label: "Tone",
				type: "select",
				required: true,
				validation: { options: ["Calm", "Loud"] },
			},
		]);
		await renderEditor(
			[{ _type: "banner", _version: 1, _key: "banner-1", headline: "Hi" }],
			[banner],
		);

		await page.getByRole("textbox", { name: "Title" }).fill("Home page");
		await saveButton().click();
		const tone = page.getByRole("combobox", { name: "Tone" });
		await expect.element(tone).toHaveAttribute("aria-invalid", "true");
		await expect.element(tone).toHaveAccessibleDescription("Required");
	});

	it("focuses the text of a required rich text field that fails on Save", async () => {
		const story = blockType("story", "Story", [
			{ slug: "headline", label: "Headline", type: "string" },
			{ slug: "body", label: "Body", type: "portableText", required: true },
		]);
		await renderEditor([{ _type: "story", _version: 1, _key: "story-1", headline: "Hi" }], [story]);

		await page.getByRole("textbox", { name: "Title" }).fill("Home page");
		await saveButton().click();
		await expect
			.element(blockRow("story-1").getByRole("button", { name: "Story", exact: true }))
			.toHaveAttribute("aria-expanded", "true");
		const text = blockRow("story-1").element().querySelector('[contenteditable="true"]');
		await expect.element(page.elementLocator(text!)).toHaveFocus();
	});

	it("shows Required beside an empty required button text's row, whose placeholder says Text", async () => {
		const strictHero = blockType(
			"hero",
			"Hero",
			heroFields.map((field) =>
				field.slug === "primary_cta_label" ? { ...field, required: true } : field,
			),
		);
		await renderEditor([{ ...heroBlock, primary_cta_label: "" }], [strictHero]);
		await openBlock();
		const text = control("Primary button text");
		const nextRowGap = () => box(control(ANNOUNCEMENT)).top - box(text).top;
		const gap = nextRowGap();
		const row = page.getByRole("group", { name: "Primary button text", exact: true }).element();

		await page.getByRole("textbox", { name: "Title" }).fill("Home page");
		await saveButton().click();
		await expect.element(text).toHaveFocus();
		await expect.element(text).toHaveAttribute("placeholder", "Text");
		await expect.element(text).toHaveAttribute("aria-invalid", "true");
		await expect.element(text).toHaveAccessibleDescription("Required");
		await expect.poll(() => shownText("Required")).toBeDefined();
		const error = shownText("Required")!.getBoundingClientRect();
		expect(error.width).toBeGreaterThan(20);
		expect(error.top).toBeGreaterThanOrEqual(row.getBoundingClientRect().top);
		expect(error.bottom).toBeLessThanOrEqual(row.getBoundingClientRect().bottom);
		expect(nextRowGap()).toBe(gap);

		await control("Headline").click();
		await expect.poll(() => shownText("Required")).toBeDefined();
	});

	it("holds autosave while a block field fails, names it in a notice, and resumes once it is fixed", async () => {
		vi.useFakeTimers();
		try {
			const onAutosave = vi.fn();
			await renderEditor([{ ...heroBlock, headline: "" }], [hero], { onAutosave });

			await page.getByRole("textbox", { name: "Title" }).fill("Home page");
			await vi.advanceTimersByTimeAsync(2500);
			expect(onAutosave).not.toHaveBeenCalled();
			await expect.element(page.getByText("Autosave paused")).toBeVisible();
			await expect
				.element(page.getByText("Fix Headline in the Hero block to resume saving."))
				.toBeVisible();

			await page.getByRole("button", { name: "Show" }).click();
			await expect
				.element(page.getByRole("button", { name: "Hero", exact: true }))
				.toHaveAttribute("aria-expanded", "true");
			const headline = control("Headline");
			await expect.element(headline).toHaveFocus();
			await expect.element(headline).toHaveAttribute("aria-invalid", "true");

			await headline.fill("Every building");
			await vi.advanceTimersByTimeAsync(2500);
			expect(onAutosave).toHaveBeenCalledTimes(1);
			expect(onAutosave.mock.lastCall?.[0].data.content[0].headline).toBe("Every building");
			await expect.element(page.getByText("Autosave paused")).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});

	it("closes the Autosave paused notice while the entry is read-only", async () => {
		vi.useFakeTimers();
		try {
			const item = makeItem([{ ...heroBlock, headline: "" }]);
			const editor = (readOnly: boolean) => (
				<ContentEditor
					collection="pages"
					collectionLabel="Page"
					fields={fieldsFor([hero])}
					isNew={false}
					item={item}
					onSave={vi.fn()}
					onAutosave={vi.fn()}
					readOnly={readOnly}
				/>
			);
			const screen = await render(editor(false), { wrapper: Toasty });

			await page.getByRole("textbox", { name: "Title" }).fill("Home page");
			await vi.advanceTimersByTimeAsync(2500);
			await expect.element(page.getByText("Autosave paused")).toBeVisible();

			await screen.rerender(editor(true));
			await expect.element(page.getByText("Autosave paused")).not.toBeInTheDocument();
		} finally {
			vi.useRealTimers();
		}
	});
});
