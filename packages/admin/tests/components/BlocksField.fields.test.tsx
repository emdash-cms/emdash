import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, type Locator } from "vitest/browser";

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
		props.open ? <div data-testid="media-picker" /> : null,
}));

const LINK_PATTERN = "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$";
const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";

const heroFields: BlockFieldDefinition[] = [
	{ slug: "headline", label: "Headline", type: "string", required: true },
	{ slug: "subheadline", label: "Subheadline", type: "text" },
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{
		slug: "primary_cta_url",
		label: "Primary button link (starts with /, https://, mailto:, tel: or #)",
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
	{ slug: "image", label: "Image", type: "image" },
	{ slug: "image_caption", label: "Image caption (shown on the photo)", type: "string" },
	{ slug: "eyebrow", label: "Announcement (shown above the headline)", type: "string" },
	{
		slug: "eyebrow_url",
		label: "Announcement link (starts with /, https://, mailto:, tel: or #)",
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
	{ slug: "centered", label: "Center the layout", type: "boolean", defaultValue: false },
	{
		slug: "anchor_id",
		label: "Section ID (lowercase, for links like /#pricing)",
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
		const caption = control("Image caption");
		const buttonText = control("Primary button text");
		const buttonLink = control("Primary button link");
		const announcement = page.getByRole("group", { name: "Announcement" });
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
		expect(Number.parseFloat(headlineStyle.fontSize)).toBeGreaterThan(
			Number.parseFloat(subheadlineStyle.fontSize),
		);
		expect(Number(headlineStyle.fontWeight)).toBeGreaterThanOrEqual(600);

		const primary = page.getByRole("group", { name: "Primary button", exact: true });
		await expect
			.element(primary.getByRole("textbox", { name: "Primary button text" }))
			.toHaveValue("Book a demo");
		await expect
			.element(primary.getByRole("textbox", { name: "Primary button link" }))
			.toHaveValue("/contact");
		expect(Math.abs(box(buttonText).top - box(buttonLink).top)).toBeLessThan(2);
		expect(box(buttonText).right).toBeLessThanOrEqual(box(buttonLink).left);
		expect(box(primary.getByText("Primary button", { exact: true })).right).toBeLessThanOrEqual(
			box(buttonText).left,
		);

		await expect.element(advanced).toHaveAttribute("aria-expanded", "false");
		await expect.element(advanced).toHaveTextContent("pricing");
		expect(control("Section ID").query()).toBeNull();
		await advanced.click();
		await expect.element(control("Section ID")).toHaveValue("pricing");
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

	it("shows a label's hint in the empty field, under the field while typing, and to screen readers", async () => {
		await renderEditor([heroBlock]);
		await openBlock();

		const caption = control("Image caption");
		await expect.element(caption).toHaveAttribute("placeholder", "Shown on the photo");
		await expect.element(caption).toHaveAccessibleDescription("Shown on the photo");
		const hint = page.getByText("Shown on the photo", { exact: true });
		const hintBox = () => hint.element().parentElement!.getBoundingClientRect();
		await caption.click();
		expect(hintBox().width).toBeLessThanOrEqual(1);

		await caption.fill("Riverside Tower");
		expect(hintBox().width).toBeGreaterThan(20);
		expect(hintBox().top).toBeGreaterThanOrEqual(box(caption).bottom);

		await control("Headline").click();
		expect(hintBox().width).toBeLessThanOrEqual(1);
	});

	it("keeps the Text and Link placeholders in a button row", async () => {
		await renderEditor([{ ...heroBlock, eyebrow: "New: reports" }]);
		await openBlock();

		await expect.element(control("Announcement")).toHaveValue("New: reports");
		await expect.element(control("Announcement link")).toHaveAttribute("placeholder", "Link");
		await expect
			.element(control("Announcement link"))
			.toHaveAccessibleDescription("Starts with /, https://, mailto:, tel: or #");
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
			const link = control("Primary button link");
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

	it("says so when a block has no fields", async () => {
		await renderEditor(
			[{ _type: "divider", _version: 1, _key: "divider-1" }],
			[blockType("divider", "Divider", [])],
		);
		await openBlock("Divider");

		await expect.element(page.getByText("This block has no fields.")).toBeVisible();
	});
});
