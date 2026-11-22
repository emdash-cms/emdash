import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { createPortal } from "react-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent, type Locator } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import {
	ContentEditor,
	type ContentEditorProps,
	type FieldDescriptor,
} from "../../src/components/ContentEditor.js";
import type { ContentItem } from "../../src/lib/api";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { expectGlide, holdAnimations, readAlong, readMotion } from "../utils/animation.js";
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
/** What a `url` field says of a value that isn't a safe link, too long for most lines. */
const LINK_PROBLEM = "Enter a valid URL (e.g. https://example.com)";
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

const hero = blockType("hero", "Hero", [
	{ slug: "headline", label: "Headline", type: "string", required: true },
	{ slug: "subheadline", label: "Second sentence (shown muted after the headline)", type: "text" },
	{ slug: "tagline", label: "Tagline", type: "text", validation: { maxLength: 60 } },
	{ slug: "image", label: "Image", type: "image" },
	{ slug: "image_caption", label: "Image caption (shown on the photo)", type: "string" },
	{ slug: "columns", label: "Columns", type: "integer", validation: { min: 1, max: 4 } },
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{ slug: "primary_cta_url", label: "Primary button link", type: "url" },
	{
		slug: "anchor_id",
		label: "Section ID",
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
	columns: 2,
	primary_cta_label: "Book a demo",
	primary_cta_url: "/contact",
	anchor_id: "hero",
};

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

// Its content ends with a photo that has no caption.
const card = blockType("card", "Card", [
	{ slug: "headline", label: "Headline", type: "string" },
	{ slug: "photo", label: "Photo", type: "image" },
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{ slug: "primary_cta_url", label: "Primary button link", type: "string" },
]);

const cardBlock = {
	_type: "card",
	_version: 1,
	_key: "card-1",
	headline: "Hi",
	photo: { id: "media-2", src: PHOTO, alt: "" },
	primary_cta_label: "Read more",
	primary_cta_url: "/more",
};

const linkHero = blockType("hero", "Hero", [
	{ slug: "headline", label: "Headline", type: "string", required: true },
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{ slug: "primary_cta_url", label: "Primary button link", type: "url" },
	{ slug: "site_url", label: "Website", type: "string", validation: { pattern: LINK_PATTERN } },
]);

const linkHeroBlock = {
	_type: "hero",
	_version: 1,
	_key: "hero-1",
	headline: "Every building, running at its best.",
	primary_cta_label: "Book a demo",
	primary_cta_url: "/contact",
	site_url: "/",
};

const switchHero = blockType("hero", "Hero", [
	{ slug: "headline", label: "Headline", type: "string", required: true },
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{ slug: "primary_cta_url", label: "Primary button link", type: "url" },
	{ slug: "centered", label: "Center the layout", type: "boolean" },
]);

const switchHeroBlock = {
	_type: "hero",
	_version: 1,
	_key: "hero-1",
	headline: "Every building, running at its best.",
	primary_cta_label: "Book a demo",
	primary_cta_url: "/contact",
	centered: false,
};

const simple = blockType("simple", "Simple", [
	{ slug: "headline", label: "Headline", type: "string", required: true },
]);

function makeItem(data: Record<string, unknown>): ContentItem {
	return {
		id: "page-1",
		type: "pages",
		slug: "home",
		status: "draft",
		data: { title: "Home", ...data },
		authorId: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		publishedAt: null,
		scheduledAt: null,
		liveRevisionId: null,
		draftRevisionId: null,
	};
}

function blocksField(label: string, blockTypes: BlockType[]): FieldDescriptor {
	return {
		kind: "blocks",
		label,
		validation: { allowedTypes: blockTypes.map((type) => type.slug), retiredTypes: [] },
		blockTypes,
	};
}

function renderEditor(
	content: unknown[],
	blockTypes: BlockType[],
	props: Partial<ContentEditorProps> = {},
	extra: { aside?: unknown[] } = {},
) {
	const fields: Record<string, FieldDescriptor> = {
		title: { kind: "string", label: "Title" },
		content: blocksField("Content", blockTypes),
		...(extra.aside ? { aside: blocksField("Aside", blockTypes) } : {}),
	};
	return render(
		<ContentEditor
			collection="pages"
			collectionLabel="Page"
			fields={fields}
			isNew={false}
			item={makeItem({ content, ...(extra.aside ? { aside: extra.aside } : {}) })}
			onSave={vi.fn()}
			{...props}
		/>,
		{ wrapper: Toasty },
	);
}

// The blocks field on its own

const SHORT = blockType("short", "Short", [{ slug: "title", label: "Title", type: "string" }]);

const LINKED = blockType("linked", "Linked", [
	{ slug: "title", label: "Title", type: "string" },
	{ slug: "cta_url", label: "Link", type: "url" },
]);

/** A label that alone fills a narrow label line in any font. */
const WORDY_LINK =
	"Link (starts with /, https://, mailto:, tel: or #, and goes to a page on this site or on another one)";

const WORDY = blockType("wordy", "Wordy", [
	{ slug: "title", label: "Title", type: "string" },
	{
		slug: "cta_url",
		label: WORDY_LINK,
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
]);

const FIELD_TYPES = [SHORT, LINKED, WORDY];

const short = (key: string): StoredBlockValue => ({
	_type: "short",
	_version: 1,
	_key: key,
	title: key,
});
const linked = (): StoredBlockValue => ({
	_type: "linked",
	_version: 1,
	_key: "linked",
	title: "Contact",
});
const wordy = (): StoredBlockValue => ({
	_type: "wordy",
	_version: 1,
	_key: "wordy",
	title: "Contact",
});

function Harness({ initial }: { initial: StoredBlockValue[] }) {
	const [value, setValue] = React.useState(initial);
	const props: BlocksFieldProps = {
		id: "field-layout",
		fieldPath: "layout",
		label: "Layout",
		value,
		onChange: setValue,
		blockTypes: FIELD_TYPES,
		allowedTypes: FIELD_TYPES.map((type) => type.slug),
		retiredTypes: [],
		renderField: ({ name, value: fieldValue, onChange, chrome }) => (
			<input
				id={`field-${name}`}
				aria-labelledby={chrome.labelledBy}
				className="h-8 w-full"
				value={typeof fieldValue === "string" ? fieldValue : ""}
				onChange={(event) => onChange(event.target.value)}
			/>
		),
	};
	return <BlocksField {...props} />;
}

function renderField(initial: StoredBlockValue[], { width = 480 }: { width?: number } = {}) {
	return render(
		<div data-testid="frame" style={{ width, marginInline: 80 }}>
			<Harness initial={initial} />
		</div>,
		{ wrapper: Toasty },
	);
}

const blockRow = (key: string) => document.querySelector<HTMLElement>(`[data-block-key="${key}"]`)!;
const toggleOf = (key: string) => blockRow(key).querySelector<HTMLElement>("[data-block-toggle]")!;
const textbox = (name: string) => page.getByRole("textbox", { name, exact: true });
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const running = () => document.getAnimations().filter((a) => a.playState === "running");
const settled = () => expect.poll(() => running().length).toBe(0);

async function reduceMotion() {
	await cdp().send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
}

/** Clicks the point `x`, `y` with the mouse, holding the button down for `hold` ms as a hand does. */
async function clickAt(x: number, y: number, { hold = 0 } = {}) {
	// Mouse input lands in the top-level page, which hosts this test's frame.
	const host = window.frameElement?.getBoundingClientRect() ?? new DOMRect();
	const scale = host.width ? host.width / window.innerWidth : 1;
	const point = { x: host.left + x * scale, y: host.top + y * scale };
	const button = { ...point, button: "left", clickCount: 1 } as const;
	await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	await cdp().send("Input.dispatchMouseEvent", { type: "mousePressed", ...button });
	if (hold > 0) await new Promise((resolve) => setTimeout(resolve, hold));
	await cdp().send("Input.dispatchMouseEvent", { type: "mouseReleased", ...button });
}

/** Clicks `element` near its bottom edge, which anything rising under the pointer takes away. */
async function clickNearBottom(element: Element) {
	const target = element.getBoundingClientRect();
	await clickAt(target.left + Math.min(40, target.width / 2), target.bottom - 4, { hold: 150 });
}

/** Samples `read` now and on every frame until `ms` have passed. */
function sampleFrames(read: () => number, ms: number): Promise<number[]> {
	return new Promise((resolve) => {
		const values = [read()];
		const end = performance.now() + ms;
		const step = (now: number) => {
			values.push(read());
			if (now < end) requestAnimationFrame(step);
			else resolve(values);
		};
		requestAnimationFrame(step);
	});
}

/** Whether `target` is in a blocks field, where everything that moves the rows below it is. */
const inField = (target: Element) => target.closest("[data-blocks-field]") !== null;

function box(target: Locator | Element): DOMRect {
	return (target instanceof Element ? target : target.element()).getBoundingClientRect();
}

function control(name: string): Locator {
	return page.getByRole("textbox", { name, exact: true });
}

function shown(element: Element): boolean {
	return (
		!element.closest(".sr-only, [hidden]") &&
		element.getBoundingClientRect().width > 1 &&
		element.checkVisibility({ opacityProperty: true, visibilityProperty: true })
	);
}

function ownText(element: Element): string {
	return [...element.childNodes]
		.filter((node) => node.nodeType === 3)
		.map((node) => node.textContent ?? "")
		.join("")
		.trim();
}

/** The element showing `text` on screen, leaving out copies kept for screen readers. */
function shownText(text: string, within: Element = document.body): Element | undefined {
	return [...within.querySelectorAll("*")].find(
		(element) => ownText(element) === text && shown(element),
	);
}

/** The label element that names `target`. */
function labelOf(target: Locator): HTMLElement {
	return document.getElementById(target.element().getAttribute("aria-labelledby")!)!;
}

/** The text shown in the danger colour inside `within`. */
function dangerTexts(within: Element): Element[] {
	const probe = document.createElement("span");
	probe.className = "text-kumo-danger";
	within.append(probe);
	const danger = getComputedStyle(probe).color;
	probe.remove();
	return [...within.querySelectorAll("*")].filter(
		(element) => ownText(element) && shown(element) && getComputedStyle(element).color === danger,
	);
}

function fontOf(element: Element) {
	const style = getComputedStyle(element);
	return `${style.fontSize} ${style.fontWeight} ${style.lineHeight}`;
}

/** Where each control and list item sits in the blocks field. */
function rowTops(): number[] {
	const top = document.querySelector("[data-blocks-field]")!.getBoundingClientRect().top;
	return Array.from(
		document.querySelectorAll('[class~="group/control"], [data-list-item]'),
		(element) => element.getBoundingClientRect().top - top,
	);
}

async function settle() {
	await expect.poll(() => document.getAnimations().length).toBe(0);
}

async function openBlock(name: string) {
	await page.getByRole("button", { name, exact: true }).click();
	await settle();
}

async function save() {
	await page.getByRole("textbox", { name: "Title" }).first().fill("Home page");
	await page.getByRole("button", { name: "Save" }).first().click();
}

function liveText(): string {
	return Array.from(
		document.querySelectorAll("[data-blocks-field] [aria-live]"),
		(region) => region.textContent,
	).join(" ");
}

type Rgba = [number, number, number, number];

const canvas = document.createElement("canvas");
canvas.width = canvas.height = 1;
const context = canvas.getContext("2d", { willReadFrequently: true })!;

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

function showMode(mode: "light" | "dark") {
	document.documentElement.setAttribute("data-theme", "classic");
	document.documentElement.setAttribute("data-mode", mode);
}

interface FrameTree {
	frame: { id: string; url: string };
	childFrames?: FrameTree[];
}

function frameAt(tree: FrameTree, url: string): string | undefined {
	if (tree.frame.url === url) return tree.frame.id;
	for (const child of tree.childFrames ?? []) {
		const id = frameAt(child, url);
		if (id) return id;
	}
	return undefined;
}

interface AxNode {
	ignored: boolean;
	role?: { value: string };
	name?: { value: string };
	description?: { value: string };
}

/** The accessibility tree Chromium builds for this test's page. */
async function axNodes(): Promise<AxNode[]> {
	const { frameTree } = (await cdp().send("Page.getFrameTree")) as { frameTree: FrameTree };
	const { nodes } = (await cdp().send("Accessibility.getFullAXTree", {
		frameId: frameAt(frameTree, location.href),
	})) as { nodes: AxNode[] };
	return nodes.filter((node) => !node.ignored);
}

/** The element showing `text` in the blocks field, leaving out copies kept for screen readers. */
const fieldText = (text: string) =>
	shownText(text, document.querySelector("[data-blocks-field]") ?? document.body);

afterEach(async () => {
	document.documentElement.dir = "ltr";
	document.documentElement.removeAttribute("data-theme");
	document.documentElement.removeAttribute("data-mode");
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
	await page.viewport(1280, 800);
});

describe.each(["ltr", "rtl"] as const)("A settings row's label (%s)", (dir) => {
	it("stays as it is while its control has focus", async () => {
		document.documentElement.dir = dir;
		await renderEditor([heroBlock], [hero]);
		await openBlock("Hero");
		await page.getByRole("button", { name: /^Advanced/ }).click();
		await settle();

		const sectionId = control("Section ID");
		const row = labelOf(sectionId).parentElement!;
		const label = shownText("Section ID", row)!;
		const atRest = { box: box(label).toJSON(), font: fontOf(label) };
		const tops = rowTops();
		await sectionId.click();
		await expect.element(sectionId).toHaveFocus();
		await settle();

		const focused = shownText("Section ID", row);
		expect(focused).toBeDefined();
		expect(box(focused!).toJSON()).toEqual(atRest.box);
		expect(fontOf(focused!)).toBe(atRest.font);
		expect(rowTops()).toEqual(tops);
	});
});

describe("A settings row's problem", () => {
	it("shows under its control's line when it has no room beside the value, at rest and with focus", async () => {
		await renderEditor([heroBlock], [hero]);
		await openBlock("Hero");
		const link = control("Primary button link");
		const row = page.getByRole("group", { name: "Primary button text", exact: true }).element();
		const font = fontOf(shownText("Primary button text", row)!);

		await link.fill("not a url");
		await control("Headline").click();
		await expect.element(link).toHaveAttribute("aria-invalid", "true");
		await expect.element(link).toHaveAccessibleDescription(LINK_PROBLEM);
		const atRest = dangerTexts(row);
		expect(atRest.map(ownText)).toEqual([LINK_PROBLEM]);
		expect(box(atRest[0]!).top).toBeGreaterThanOrEqual(box(link).bottom - 0.5);
		expect(fontOf(shownText("Primary button text", row)!)).toBe(font);
		const tops = rowTops();

		await link.click();
		await expect.element(link).toHaveFocus();
		await expect.poll(() => dangerTexts(row).map(ownText)).toEqual([LINK_PROBLEM]);
		expect(fontOf(shownText("Primary button text", row)!)).toBe(font);
		expect(rowTops()).toEqual(tops);

		await link.fill("/contact");
		await control("Headline").click();
		await expect.element(link).not.toHaveAttribute("aria-invalid");
		await expect.poll(() => dangerTexts(row)).toEqual([]);
	});

	it("is the red placeholder alone when the control is empty, and leaves the label as it was", async () => {
		await renderEditor([featuresBlock], [features]);
		await openBlock("Features");
		await page.getByRole("button", { name: /^Add item/ }).click();
		await userEvent.keyboard("Live alerts");
		const icon = page.getByRole("combobox", { name: "Icon", exact: true }).last();
		const row = labelOf(icon).parentElement!;
		const font = fontOf(shownText("Icon", row)!);

		await save();
		await expect.element(icon).toHaveAttribute("aria-invalid", "true");
		(document.activeElement as HTMLElement).blur();
		const red = dangerTexts(row);
		expect(red.map(ownText)).toEqual(["Required"]);
		expect(icon.element().contains(red[0]!)).toBe(true);
		expect(fontOf(shownText("Icon", row)!)).toBe(font);
	});
});

describe.each(["ltr", "rtl"] as const)(
	"A settings row's problem with no room beside its value (%s)",
	(dir) => {
		it("goes on its own line under the value once focus leaves, and stays put with focus", async () => {
			document.documentElement.dir = dir;
			await renderEditor([linkHeroBlock], [linkHero]);
			await openBlock("Hero");
			const link = control("Primary button link");
			const input = link.element() as HTMLInputElement;
			const group = page.getByRole("group", { name: "Primary button text", exact: true }).element();

			await link.fill("contact us");
			await control("Headline").click();
			await expect.element(link).toHaveAttribute("aria-invalid", "true");
			await expect.poll(() => dangerTexts(group).map(ownText)).toEqual([LINK_PROBLEM]);
			await settle();
			const problem = dangerTexts(group)[0]!;
			expect(box(problem).top).toBeGreaterThanOrEqual(box(link).bottom - 0.5);
			expect(input.scrollWidth).toBeLessThanOrEqual(input.clientWidth);
			const atRest = {
				width: input.clientWidth,
				end: getComputedStyle(input).paddingInlineEnd,
				tops: rowTops(),
				problem: box(problem).toJSON(),
			};

			await link.click();
			await expect.element(link).toHaveFocus();
			await settle();
			expect(input.clientWidth).toBe(atRest.width);
			expect(getComputedStyle(input).paddingInlineEnd).toBe(atRest.end);
			expect(rowTops()).toEqual(atRest.tops);
			expect(dangerTexts(group).map(ownText)).toEqual([LINK_PROBLEM]);
			expect(box(dangerTexts(group)[0]!).toJSON()).toEqual(atRest.problem);
		});
	},
);

describe.each(["ltr", "rtl"] as const)("A short settings-row problem (%s)", (dir) => {
	it("stays at the end of its value's line, moving nothing, with or without focus", async () => {
		document.documentElement.dir = dir;
		await renderEditor([linkHeroBlock], [linkHero]);
		await openBlock("Hero");
		const website = control("Website");
		const field = website.element().closest('[class~="group/control"]')!;
		const tops = rowTops();

		await website.fill("abc");
		await control("Headline").click();
		await expect.element(website).toHaveAttribute("aria-invalid", "true");
		await expect.poll(() => dangerTexts(field).map(ownText)).toEqual(["Invalid link"]);
		const note = dangerTexts(field)[0]!;
		expect(box(note).top).toBeGreaterThanOrEqual(box(website).top - 0.5);
		expect(box(note).bottom).toBeLessThanOrEqual(box(website).bottom + 0.5);
		expect(rowTops()).toEqual(tops);
		const atRest = box(note).toJSON();

		await website.click();
		await expect.element(website).toHaveFocus();
		await settle();
		expect(rowTops()).toEqual(tops);
		expect(box(dangerTexts(field)[0]!).toJSON()).toEqual(atRest);
	});
});

describe("A settings row's problem line", () => {
	const center = () => page.getByRole("switch", { name: "Center the layout" });
	const buttonRow = () =>
		page.getByRole("group", { name: "Primary button text", exact: true }).element();
	const problem = () => fieldText(LINK_PROBLEM);

	async function openLinked(width?: number) {
		await renderField([linked(), short("after")], { width });
		await page.getByRole("button", { name: "Linked", exact: true }).click();
		await settled();
	}

	it("comes after a click below it has landed, rather than moving it away", async () => {
		await renderEditor([switchHeroBlock], [switchHero]);
		await openBlock("Hero");
		const link = control("Primary button link");

		await link.fill("contact us");
		const target = box(center());
		await clickAt(target.left + target.width / 2, target.top + 3, { hold: 150 });

		await expect.element(center()).toBeChecked();
		await expect.poll(() => dangerTexts(buttonRow()).map(ownText)).toEqual([LINK_PROBLEM]);
	});

	it("goes after a click below it has landed, rather than moving it away", async () => {
		await renderEditor([switchHeroBlock], [switchHero]);
		await openBlock("Hero");
		const link = control("Primary button link");
		await link.fill("contact us");
		await control("Headline").click();
		await expect.poll(() => dangerTexts(buttonRow()).map(ownText)).toEqual([LINK_PROBLEM]);
		await settled();

		await link.click();
		await link.fill("/contact");
		await clickNearBottom(center().element());

		await expect.element(center()).toBeChecked();
		await expect.poll(() => dangerTexts(buttonRow())).toEqual([]);
	});

	it("moves the rows below smoothly as it comes and goes", async () => {
		await renderEditor([switchHeroBlock], [switchHero]);
		await openBlock("Hero");
		const link = control("Primary button link");
		const switchElement = center().element();
		const top = () => switchElement.getBoundingClientRect().top;

		await link.fill("contact us");
		const down = await readMotion(inField, top, () => userEvent.keyboard("{Tab}"));
		expect(down.to - down.from).toBeGreaterThan(15);
		expectGlide(down.along, down.from, down.to);

		await link.click();
		await link.fill("/contact");
		const up = await readMotion(inField, top, () => userEvent.keyboard("{Tab}"));
		expect(up.from - up.to).toBeGreaterThan(15);
		expectGlide(up.along, up.from, up.to);
	});

	it("comes at once under reduced motion", async () => {
		await reduceMotion();
		await renderEditor([switchHeroBlock], [switchHero]);
		await openBlock("Hero");
		const link = control("Primary button link");
		const before = box(center()).top;

		await link.fill("contact us");
		await userEvent.keyboard("{Tab}");
		await frame();

		expect(box(center()).top - before).toBeGreaterThan(15);
		expect(running()).toEqual([]);
	});

	it("keeps its problem until it has shrunk away", async () => {
		await openLinked(560);
		await textbox("Link").fill("contact us");
		await textbox("Title").click();
		await expect.poll(() => problem() !== undefined).toBe(true);
		await settled();
		const line = [...document.querySelectorAll("[data-blocks-field] p:not([hidden])")].find(
			(element) => element.textContent?.trim() === LINK_PROBLEM,
		)!;
		const panel = line.parentElement!;
		const full = panel.getBoundingClientRect().height;

		await textbox("Link").click();
		await textbox("Link").fill("/contact");
		const shrink = holdAnimations((target) => target === panel);
		(textbox("Title").element() as HTMLElement).focus();
		const heights = readAlong(await shrink.started(), () => {
			expect(line.textContent?.trim()).toBe(LINK_PROBLEM);
			return panel.getBoundingClientRect().height;
		});
		shrink.release();
		await settled();

		expectGlide(heights, full, 0);
		expect(panel.getBoundingClientRect().height).toBeLessThan(1);
	});

	it("fades a problem fixed while typing, and holds its line until focus leaves", async () => {
		await openLinked(560);
		await textbox("Link").fill("contact us");
		await textbox("Title").click();
		await expect.poll(() => problem() !== undefined).toBe(true);
		await settled();
		const line = [...document.querySelectorAll("[data-blocks-field] p:not([hidden])")].find(
			(element) => element.textContent?.trim() === LINK_PROBLEM,
		)!;
		const panel = line.parentElement!;
		const full = panel.getBoundingClientRect().height;

		await textbox("Link").click();
		await textbox("Link").fill("/contact");
		await settled();
		expect(Number(getComputedStyle(line.firstElementChild!).opacity)).toBe(0);
		expect(panel.getBoundingClientRect().height).toBeCloseTo(full, 0);
	});

	it("moves to a line of its own when a resize takes the room beside the value", async () => {
		await openLinked(1100);
		const link = textbox("Link");
		await link.fill("contact us");
		await textbox("Title").click();
		await expect.poll(problem).toBeDefined();
		expect(box(problem()!).bottom).toBeLessThanOrEqual(box(link).bottom + 0.5);

		(page.getByTestId("frame").element() as HTMLElement).style.width = "560px";
		await expect.poll(() => problem() && box(problem()!).top >= box(link).bottom - 0.5).toBe(true);
		await settled();
		const line = problem()!;
		expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
	});

	it("moves back beside the value once a resize past the stacked width gives it room", async () => {
		await openLinked(400);
		const link = textbox("Link");
		await link.fill("contact us");
		await textbox("Title").click();
		await expect.poll(problem).toBeDefined();

		(page.getByTestId("frame").element() as HTMLElement).style.width = "1100px";
		await expect
			.poll(() => problem() && box(problem()!).bottom <= box(link).bottom + 0.5)
			.toBe(true);
		await settled();
		const field = link.element().closest('[class~="group/control"]')!;
		expect(dangerTexts(field.parentElement!).length).toBe(1);
	});
});

describe("A problem under a label that fills its narrow line", () => {
	const link = () => textbox(WORDY_LINK);
	const label = () => document.getElementById("field-layout.wordy.cta_url-label")!;

	/** Opens the block at a width its label fills, and returns the label's height at rest. */
	async function openWordy() {
		await renderField([wordy(), short("after")], { width: 300 });
		await page.getByRole("button", { name: "Wordy", exact: true }).click();
		await settled();
		return label().getBoundingClientRect().height;
	}

	it("goes whole on a line of its own under the label", async () => {
		await openWordy();
		await link().fill("contact us");
		await textbox("Title").click();
		await expect.poll(() => dangerTexts(label()).map(ownText)).toEqual(["Invalid link"]);
		await settled();

		const problem = dangerTexts(label())[0]!;
		const text = label().firstElementChild!;
		expect(box(problem).top).toBeGreaterThanOrEqual(box(text).bottom - 0.5);
		expect(box(problem).height).toBeLessThanOrEqual(
			Number.parseFloat(getComputedStyle(problem).lineHeight) + 0.5,
		);
		expect(problem.scrollWidth).toBeLessThanOrEqual(problem.clientWidth);
	});

	it("moves the rows below smoothly as it comes", async () => {
		const atRest = await openWordy();
		const head = toggleOf("after");

		const { from, along, to } = await readMotion(
			inField,
			() => head.getBoundingClientRect().top,
			async () => {
				await link().fill("contact us");
				await textbox("Title").click();
			},
		);

		expect(label().getBoundingClientRect().height).toBeGreaterThan(atRest + 8);
		expect(to - from).toBeGreaterThan(8);
		expectGlide(along, from, to);
	});

	it("moves the rows below smoothly as it goes", async () => {
		const atRest = await openWordy();
		await link().fill("contact us");
		await textbox("Title").click();
		await settled();
		const twoLines = label().getBoundingClientRect().height;
		expect(twoLines).toBeGreaterThan(atRest + 8);
		const head = toggleOf("after");

		const { from, along, to } = await readMotion(
			inField,
			() => head.getBoundingClientRect().top,
			async () => {
				await link().fill("/contact");
				await textbox("Title").click();
			},
		);

		expect(label().getBoundingClientRect().height).toBeLessThan(twoLines - 8);
		expect(from - to).toBeGreaterThan(8);
		expectGlide(along, from, to);
	});

	it("comes at once under reduced motion", async () => {
		await reduceMotion();
		const atRest = await openWordy();
		await link().fill("contact us");

		(textbox("Title").element() as HTMLElement).focus();
		await expect.poll(() => label().getBoundingClientRect().height).toBeGreaterThan(atRest + 8);

		expect(running()).toEqual([]);
	});

	it("moves nothing as focus comes back to its control", async () => {
		await openWordy();
		await link().fill("contact us");
		await textbox("Title").click();
		await settled();
		const head = toggleOf("after");

		const sampling = sampleFrames(() => head.getBoundingClientRect().top, 300);
		(link().element() as HTMLElement).focus();
		const tops = await sampling;

		expect(new Set(tops).size).toBe(1);
	});
});

describe("A field's notes on a narrow screen", () => {
	it("wrap onto another line instead of being cut off", async () => {
		await page.viewport(320, 800);
		await renderEditor([heroBlock], [hero]);
		await openBlock("Hero");
		const uncut = (element: Element) => element.scrollWidth <= element.clientWidth + 1;

		const link = control("Primary button link");
		await link.fill("not a url");
		await control("Headline").click();
		const row = page.getByRole("group", { name: "Primary button text", exact: true }).element();
		await expect.poll(() => dangerTexts(row).map(ownText)).toEqual([LINK_PROBLEM]);
		const problem = dangerTexts(row)[0]!;
		expect(uncut(problem)).toBe(true);
		expect(box(problem).height).toBeGreaterThan(
			Number.parseFloat(getComputedStyle(problem).lineHeight),
		);
	});
});

describe.each(["light", "dark"] as const)("A Required placeholder in %s mode", (mode) => {
	it("is drawn at text contrast, in a text area and in a select", async () => {
		showMode(mode);
		await renderEditor([featuresBlock], [features]);
		await openBlock("Features");
		await page.getByRole("button", { name: /^Add item/ }).click();
		(document.activeElement as HTMLElement).blur();

		const description = page
			.getByRole("textbox", { name: "Description", exact: true })
			.last()
			.element() as HTMLTextAreaElement;
		expect(description.placeholder).toBe("Required");
		expect(
			contrast(getComputedStyle(description, "::placeholder").color, description),
		).toBeGreaterThanOrEqual(4.5);

		const icon = page.getByRole("combobox", { name: "Icon", exact: true }).last().element();
		const placeholder = [...icon.querySelectorAll("*")].find((el) => ownText(el) === "Required")!;
		expect(placeholder).toBeDefined();
		expect(contrast(getComputedStyle(placeholder).color, icon)).toBeGreaterThanOrEqual(4.5);
	});
});

describe("After a save finds problems", () => {
	const brokenHero = { ...heroBlock, headline: "" };
	const brokenFeatures = {
		...featuresBlock,
		features: [{ icon: "", title: "Every meter", description: "" }],
	};

	it("shows how many are left, and goes to the next on each press, across blocks and round again", async () => {
		await renderEditor([brokenHero, brokenFeatures], [hero, features]);
		expect(page.getByRole("button", { name: /to fix/ }).query()).toBeNull();
		await save();
		const headline = control("Headline").first();
		await expect.element(headline).toHaveFocus();

		const next = page.getByRole("button", { name: "3 to fix" });
		await expect.element(next).toBeVisible();
		await next.click();
		const description = page.getByRole("textbox", { name: "Description", exact: true });
		await expect.element(description).toHaveFocus();
		await next.click();
		const icon = page.getByRole("combobox", { name: "Icon", exact: true });
		await expect.element(icon).toHaveFocus();
		await next.click();
		await expect.element(headline).toHaveFocus();

		await headline.fill("Every building");
		await expect.element(page.getByRole("button", { name: "2 to fix" })).toBeVisible();
		await description.fill("All in one view.");
		await icon.click();
		await page.getByRole("option", { name: "bell" }).click();
		await expect.element(page.getByRole("button", { name: /to fix/ })).not.toBeInTheDocument();
	});

	it("says how many there are once, across every blocks field, and stops once they're fixed", async () => {
		await renderEditor([brokenHero], [hero, features], {}, { aside: [brokenFeatures] });
		await save();
		await expect.element(control("Headline").first()).toHaveFocus();
		await expect.poll(liveText).toContain("3 fields need attention");
		expect(liveText()).not.toMatch(/\b[12] fields? needs? attention/);
		expect(liveText().match(/need attention/g)).toHaveLength(1);

		await control("Headline").first().fill("Every building");
		// The save left the item with problems open, ready for when its block opens.
		await openBlock("Features");
		await control("Description").fill("All in one view.");
		await page.getByRole("combobox", { name: "Icon", exact: true }).click();
		await page.getByRole("option", { name: "bell" }).click();
		await expect.poll(liveText).not.toContain("need attention");
	});

	it("names its count button by what it does", async () => {
		await renderEditor(
			[
				{ _type: "simple", _version: 1, _key: "a", headline: "" },
				{ _type: "simple", _version: 1, _key: "b", headline: "" },
			],
			[simple],
		);
		await save();
		const next = page.getByRole("button", { name: /to fix/ });
		await expect.element(next).toBeVisible();
		await expect.element(next).toHaveAccessibleName("2 to fix. Go to the next problem");
	});

	it("goes on from the last problem shown when the control it focused has left the page", async () => {
		await renderEditor(
			["a", "b", "c"].map((key) => ({ _type: "simple", _version: 1, _key: key, headline: "" })),
			[simple],
		);
		await save();
		const focusedId = () => document.activeElement?.id;
		await expect.poll(focusedId).toBe("field-content.a.headline");
		const next = page.getByRole("button", { name: /to fix/ });
		await next.click();
		await expect.poll(focusedId).toBe("field-content.b.headline");

		// Safari doesn't focus a clicked button, so closing the block leaves focus nowhere.
		blockRow("b").querySelector<HTMLElement>("[data-block-toggle]")!.click();
		await settle();
		expect(document.getElementById("field-content.b.headline")).toBeNull();
		await next.click();
		await expect.poll(focusedId).toBe("field-content.c.headline");
	});
});

describe("Autosave paused", () => {
	it("names the first problem on screen, which Show then goes to", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		try {
			await renderEditor([heroBlock, featuresBlock], [hero, features], { onAutosave: vi.fn() });
			await openBlock("Features");
			await page.getByRole("button", { name: /^Add item/ }).click();
			await userEvent.keyboard("Live alerts");
			await vi.advanceTimersByTimeAsync(3000);
			await page.getByRole("textbox", { name: "Title" }).first().click();

			await expect
				.element(page.getByText("Fix Description in the Features block to resume saving."))
				.toBeVisible();
			await page.getByRole("button", { name: "Show" }).click();
			await expect
				.element(page.getByRole("textbox", { name: "Description", exact: true }).last())
				.toHaveFocus();
		} finally {
			vi.useRealTimers();
		}
	});

	it("waits for a popup the block opened, but not for one it didn't", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		const elsewhere = document.createElement("div");
		elsewhere.setAttribute("role", "menu");
		elsewhere.innerHTML = "<button type='button' role='menuitem'>Elsewhere</button>";
		try {
			await renderEditor([heroBlock, featuresBlock], [hero, features], { onAutosave: vi.fn() });
			await openBlock("Features");
			await page.getByRole("button", { name: /^Add item/ }).click();
			await userEvent.keyboard("Live alerts");
			await vi.advanceTimersByTimeAsync(3000);

			await page.getByRole("combobox", { name: "Icon", exact: true }).last().click();
			await expect.element(page.getByRole("listbox")).toBeVisible();
			await vi.advanceTimersByTimeAsync(500);
			expect(page.getByText("Autosave paused").query()).toBeNull();
			await userEvent.keyboard("{Escape}");

			document.body.append(elsewhere);
			elsewhere.querySelector("button")!.focus();
			await expect.element(page.getByText("Autosave paused")).toBeVisible();
		} finally {
			elsewhere.remove();
			vi.useRealTimers();
		}
	});
});

describe("A field's count and range", () => {
	it("reach assistive technology with the control", async () => {
		await renderEditor([heroBlock], [hero]);
		await openBlock("Hero");

		await expect.element(control("Tagline")).toHaveAccessibleDescription("5 of 60 characters");
		await expect
			.element(page.getByRole("spinbutton", { name: "Columns", exact: true }))
			.toHaveAccessibleDescription("Between 1 and 4");
		const nodes = await axNodes();
		const tagline = nodes.find(
			(node) => node.role?.value === "textbox" && node.name?.value === "Tagline",
		);
		expect(tagline?.description?.value).toBe("5 of 60 characters");
	});
});

describe("Forced colors", () => {
	it("mark the active option of a select and of the block picker, and keep a closed row's problem dot", async () => {
		await cdp().send("Emulation.setEmulatedMedia", {
			features: [{ name: "forced-colors", value: "active" }],
		});
		const outlined = (element: Element) => {
			const style = getComputedStyle(element);
			return style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) >= 2;
		};
		try {
			await renderEditor(
				[
					{ ...heroBlock, headline: "" },
					{ ...featuresBlock, features: [{ title: "Every meter" }] },
				],
				[hero, features],
			);
			await save();
			const dot = page
				.getByRole("listitem")
				.filter({ has: page.getByRole("button", { name: "Features", exact: true }) })
				.getByRole("img", { name: "Has fields to fix" })
				.first();
			await expect.element(dot).toBeVisible();
			expect(rgba(getComputedStyle(dot.element()).backgroundColor)).not.toEqual(
				backdrop(dot.element().parentElement!),
			);

			await openBlock("Features");
			const icon = page.getByRole("combobox", { name: "Icon", exact: true });
			(icon.element() as HTMLElement).focus();
			await userEvent.keyboard("{ArrowDown}");
			await expect.element(page.getByRole("listbox")).toBeVisible();
			await userEvent.keyboard("{ArrowDown}");
			const option = document.querySelector('[role="option"][data-highlighted]');
			expect(option).not.toBeNull();
			expect(outlined(option!)).toBe(true);
			await userEvent.keyboard("{Escape}");

			await page.getByRole("button", { name: "Add block", exact: true }).click();
			await expect
				.element(page.getByRole("combobox", { name: "Search block types" }))
				.toHaveFocus();
			await userEvent.keyboard("{ArrowDown}");
			const active = document.querySelector('[role="option"][aria-selected="true"]');
			expect(active).not.toBeNull();
			expect(outlined(active!)).toBe(true);
		} finally {
			await cdp().send("Emulation.setEmulatedMedia", { features: [] });
		}
	});
});

describe("Names and counts for assistive technology", () => {
	it("give Add item and Advanced the list or block they belong to, and a list's count its unit", async () => {
		await renderEditor([heroBlock, featuresBlock], [hero, features]);
		await openBlock("Hero");
		await openBlock("Features");

		await expect
			.element(page.getByRole("button", { name: "Add item to Features", exact: true }))
			.toBeVisible();
		await expect
			.element(page.getByRole("button", { name: "Advanced: Hero", exact: true }))
			.toBeVisible();
		const texts = (await axNodes())
			.filter((node) => node.role?.value === "StaticText")
			.map((node) => node.name?.value);
		expect(texts).toContain("1 item");
		expect(texts).not.toContain("1");
	});

	it("don't describe a current block's menu by its version", async () => {
		await renderEditor([heroBlock], [hero]);
		await expect
			.element(page.getByRole("button", { name: "Hero actions" }))
			.not.toHaveAccessibleDescription();
	});
});

describe("An open block's settings", () => {
	it("are ruled off from its content whether the content ends with a caption or a photo", async () => {
		await renderEditor([heroBlock, cardBlock], [hero, card]);
		await openBlock("Hero");
		await openBlock("Card");
		for (const key of ["hero-1", "card-1"]) {
			const body = document.querySelector(`[data-block-key="${key}"] [data-block-body]`)!;
			const photo = body.querySelector("img")!;
			const firstSetting = body.querySelector('[role="group"][aria-labelledby$="-row"]')!;
			const rules = [...body.querySelectorAll("*")].filter((element) => {
				const style = getComputedStyle(element);
				const rect = box(element);
				return (
					style.borderTopStyle !== "none" &&
					Number.parseFloat(style.borderTopWidth) >= 1 &&
					rect.height <= 1.5 &&
					rect.top >= box(photo).bottom &&
					rect.bottom <= box(firstSetting).top
				);
			});
			expect(rules, key).toHaveLength(1);
		}
	});

	it.each(["ltr", "rtl"] as const)(
		"end the closed Advanced row with its caret, after the summary (%s)",
		async (dir) => {
			document.documentElement.dir = dir;
			await renderEditor([heroBlock], [hero]);
			await openBlock("Hero");
			const advanced = page.getByRole("button", { name: /^Advanced/ }).element();
			const caret = advanced.querySelector("svg")!;
			const summary = shownText("Section ID: hero", advanced)!;
			expect(summary).toBeDefined();
			if (dir === "ltr") expect(box(caret).left).toBeGreaterThanOrEqual(box(summary).right - 0.5);
			else expect(box(caret).right).toBeLessThanOrEqual(box(summary).left + 0.5);
		},
	);
});

describe.each(["light", "dark"] as const)("An open list item in %s mode", (mode) => {
	it("has an edge a hovered row doesn't, that reads against its fill", async () => {
		showMode(mode);
		await renderEditor([featuresBlock], [features]);
		await openBlock("Features");
		await page.getByRole("button", { name: "Every meter", exact: true }).click();
		await settle();
		const item = page.getByRole("listitem").filter({ hasText: "Description" }).last().element();
		const ring = getComputedStyle(item)
			.boxShadow.split(/,(?![^(]*\))/)
			.find((layer) => /inset/.test(layer) && /\s1px/.test(layer.replace(COLOR_FUNCTION, "")));
		expect(ring).toBeDefined();
		const color = ring!.match(COLOR_FUNCTION)![0];
		expect(contrast(color, item)).toBeGreaterThanOrEqual(1.2);
	});
});
