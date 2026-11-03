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
import { ImageFieldRenderer } from "../../src/components/ImageFieldRenderer.js";
import type { ContentItem } from "../../src/lib/api";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
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

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control";
const LINK_PATTERN = "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$";
const LINK_HINT = "Starts with /, https://, mailto:, tel: or #";
const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";
const PHOTO_HINT = "Shown at 16:9, at least 1600px wide";
const OTHER_PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='9' height='16'/%3E";

function blockType(slug: string, label: string, fields: BlockFieldDefinition[]): BlockType {
	return {
		id: `${slug}-type`,
		slug,
		label,
		category: "Layout",
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

// ---------------------------------------------------------------------------------------------
// The blocks field on its own

const SHORT = blockType("short", "Short", [{ slug: "title", label: "Title", type: "string" }]);

const LONG = blockType(
	"long",
	"Long",
	Array.from({ length: 12 }, (_, index) => ({
		slug: `line_${index}`,
		label: `Line ${index}`,
		type: "text" as const,
	})),
);

const STATS = blockType("stats", "Stats", [
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
]);

const GALLERY = blockType("gallery", "Gallery", [
	{
		slug: "shots",
		label: "Shots",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "photo", label: "Photo", type: "image" },
				{ slug: "label", label: "Label", type: "string" },
			],
		},
	},
]);

const TYPES = [SHORT, LONG, STATS, GALLERY];

const short = (key: string): StoredBlockValue => ({
	_type: "short",
	_version: 1,
	_key: key,
	title: key,
});
const long = (key: string): StoredBlockValue => ({ _type: "long", _version: 1, _key: key });
const stats = (): StoredBlockValue => ({
	_type: "stats",
	_version: 1,
	_key: "stats",
	stats: [
		{ value: "23%", label: "Lower spend" },
		{ value: "4x", label: "Faster" },
	],
});
const gallery = (): StoredBlockValue => ({
	_type: "gallery",
	_version: 1,
	_key: "gallery",
	shots: [
		{ photo: PHOTO, label: "First" },
		{ photo: OTHER_PHOTO, label: "Second" },
	],
});

/** Every value the field saved, latest last. */
const saved: StoredBlockValue[][] = [];

function Harness({ initial }: { initial: StoredBlockValue[] }) {
	const [value, setValue] = React.useState(initial);
	const props: BlocksFieldProps = {
		id: "field-layout",
		fieldPath: "layout",
		label: "Layout",
		value,
		onChange: (next) => {
			saved.push(next);
			setValue(next);
		},
		blockTypes: TYPES,
		allowedTypes: TYPES.map((type) => type.slug),
		retiredTypes: [],
		renderField: ({ name, field, value: fieldValue, onChange, chrome }) =>
			field.kind === "image" ? (
				<ImageFieldRenderer
					label={field.label ?? ""}
					labelledBy={chrome.labelledBy}
					thumbnail={chrome.thumbnail}
					value={fieldValue as string | undefined}
					onChange={(next) => onChange(next ?? undefined)}
				/>
			) : (
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

function renderField(initial: StoredBlockValue[]) {
	return render(
		<div style={{ width: 480, marginInline: 80 }}>
			<Harness initial={initial} />
		</div>,
		{ wrapper: Toasty },
	);
}

/**
 * The field in the editor's canvas, a scroller as tall as the page. At this width the field is
 * centred well clear of the toasts in the page's end corner, unless `fieldWidth` takes it there.
 */
function renderInCanvas(initial: StoredBlockValue[], { fieldWidth = 480 } = {}) {
	return render(
		<div
			data-testid="canvas"
			data-emdash-editor-canvas=""
			style={{ position: "fixed", inset: 0, overflowY: "auto", scrollPaddingTop: 52 }}
		>
			<div style={{ width: fieldWidth, marginInline: "auto", paddingBlock: 40 }}>
				<Harness initial={initial} />
			</div>
			<div style={{ height: 1200 }} />
		</div>,
		{ wrapper: Toasty },
	);
}

const rowKeys = () =>
	Array.from(
		document.querySelectorAll<HTMLElement>("[data-block-key]"),
		(row) => row.dataset.blockKey,
	);
const row = (key: string) => document.querySelector<HTMLElement>(`[data-block-key="${key}"]`)!;
const toggleOf = (key: string) => row(key).querySelector<HTMLElement>("[data-block-toggle]")!;
const menuButtonOf = (key: string) =>
	page.elementLocator(row(key)).getByRole("button", { name: /actions$/ });
const canvas = () => page.getByTestId("canvas").element() as HTMLElement;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const running = () => document.getAnimations().filter((a) => a.playState === "running");
const settled = () => expect.poll(() => running().length).toBe(0);
const undoButtons = () => page.getByRole("button", { name: "Undo" }).all();
const inView = (element: Element) => {
	const { top, bottom } = element.getBoundingClientRect();
	return top >= 0 && bottom <= innerHeight;
};

/** Presses Mod+Z at once, from wherever focus is, as a key event the page sees. */
function pressUndo() {
	(document.activeElement ?? document.body).dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "z",
			code: "KeyZ",
			bubbles: true,
			cancelable: true,
			...(MOD === "Meta" ? { metaKey: true } : { ctrlKey: true }),
		}),
	);
}

async function deleteFromMenu(key: string) {
	await menuButtonOf(key).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
}

/** Waits, frame by frame, for `done`. */
async function until(done: () => boolean) {
	for (let count = 0; count < 120 && !done(); count++) await frame();
	expect(done()).toBe(true);
}

/** The animation shrinking a deleted row away. */
function shrinking(element: HTMLElement): Animation | undefined {
	return element
		.getAnimations()
		.find(
			(animation) =>
				animation.effect instanceof KeyframeEffect &&
				animation.effect.getKeyframes().some((keyframe) => "height" in keyframe),
		);
}

afterEach(async () => {
	saved.length = 0;
	document.documentElement.dir = "ltr";
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
	await page.viewport(1280, 800);
});

describe("Undo puts a block back", () => {
	it("where it was, growing in place without scrolling the page under it", async () => {
		await renderInCanvas([short("one"), long("big"), short("three")]);
		toggleOf("big").click();
		await settled();
		canvas().scrollTop = toggleOf("big").getBoundingClientRect().top - 360;
		await frame();
		const before = toggleOf("big").getBoundingClientRect().top;
		expect(
			toggleOf("big").closest("[data-block-key]")!.getBoundingClientRect().bottom,
		).toBeGreaterThan(innerHeight - 120);

		await deleteFromMenu("big");
		await expect.poll(rowKeys).toEqual(["one", "three"]);
		await settled();
		await page.getByRole("button", { name: "Undo" }).click();
		await expect.poll(rowKeys).toEqual(["one", "big", "three"]);
		await settled();

		expect(Math.abs(toggleOf("big").getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
		await expect.element(page.elementLocator(toggleOf("big"))).toHaveFocus();
	});

	it("into view, with focus, when it went back somewhere scrolled away", async () => {
		await renderInCanvas(Array.from({ length: 24 }, (_, index) => short(`block-${index}`)));
		await deleteFromMenu("block-1");
		await expect.poll(rowKeys).not.toContain("block-1");
		await settled();
		canvas().scrollTop = canvas().scrollHeight;
		await frame();
		expect(inView(toggleOf("block-0"))).toBe(false);

		pressUndo();
		await expect.poll(rowKeys).toContain("block-1");
		await expect.element(page.elementLocator(toggleOf("block-1"))).toHaveFocus();
		await expect.poll(() => inView(toggleOf("block-1"))).toBe(true);
	});

	it("with focus on it when Mod+Z calls the deletion off while the row shrinks away", async () => {
		await renderField([short("one"), short("two"), short("three")]);
		await menuButtonOf("two").click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await until(() => shrinking(row("two"))?.playState === "running");

		pressUndo();
		await settled();
		expect(rowKeys()).toEqual(["one", "two", "three"]);
		await expect.element(page.elementLocator(toggleOf("two"))).toHaveFocus();
	});

	it("when Mod+Z comes once the row has shrunk away but before it's taken out", async () => {
		await renderField([short("one"), short("two"), short("three")]);
		await menuButtonOf("two").click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await until(() => shrinking(row("two"))?.playState === "running");

		shrinking(row("two"))!.finish();
		pressUndo();
		await new Promise((resolve) => setTimeout(resolve, 400));
		await settled();

		expect(rowKeys()).toEqual(["one", "two", "three"]);
		expect(row("two").getBoundingClientRect().height).toBeGreaterThan(30);
	});
});

describe("Mod+Z", () => {
	it("puts nothing back while focus is in a menu or a popup", async () => {
		await renderField([short("one"), short("two")]);
		await deleteFromMenu("one");
		await expect.element(page.getByText("Deleted Short")).toBeVisible();

		await menuButtonOf("two").click();
		await expect.element(page.getByRole("menu")).toBeVisible();
		await until(() => Boolean(document.activeElement?.closest('[role="menu"]')));
		pressUndo();
		await frame();
		expect(rowKeys()).toEqual(["two"]);
		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

		await page.getByRole("button", { name: "Add block", exact: true }).click();
		const picker = page.getByRole("dialog", { name: "Add block" });
		await expect.element(picker).toBeVisible();
		(picker.element() as HTMLElement).focus();
		pressUndo();
		await frame();
		expect(rowKeys()).toEqual(["two"]);
	});
});

describe("Keeping focus clear of a toast", () => {
	it("leaves the page alone while the toast is beside the field, not over it", async () => {
		await renderInCanvas(Array.from({ length: 30 }, (_, index) => short(`block-${index}`)));
		await deleteFromMenu("block-0");
		await expect.element(page.getByText("Deleted Short")).toBeVisible();
		await settled();
		const toast = page.getByRole("dialog").element() as HTMLElement;
		const toastTop = toast.getBoundingClientRect().top;
		const beside = [...document.querySelectorAll<HTMLElement>("[data-block-toggle]")].find(
			(toggle) => {
				const { top, bottom } = toggle.getBoundingClientRect();
				return top > toastTop + 4 && bottom < innerHeight - 4;
			},
		)!;
		const scrolled = canvas().scrollTop;

		beside.focus();
		await frame();
		expect(canvas().scrollTop).toBe(scrolled);
	});
});

describe("A table's blank row", () => {
	const cell = (name: string) => page.getByRole("textbox", { name, exact: true });
	const dataRows = () =>
		page.getByRole("table").element().querySelectorAll("[data-list-item]").length;
	const savedStats = () => {
		const latest = saved.at(-1)?.[0];
		return Array.isArray(latest?.stats) ? latest.stats.length : undefined;
	};

	it("that Enter added goes once focus leaves it, leaving the value as it was", async () => {
		await renderField([stats()]);
		await page.getByRole("button", { name: "Stats", exact: true }).click();
		await cell("Label 2").click();

		await userEvent.keyboard("{Enter}");
		await expect.element(cell("Label 3")).toHaveFocus();
		expect(dataRows()).toBe(3);
		await userEvent.keyboard("{Tab}");
		expect(dataRows()).toBe(3);
		await userEvent.keyboard("{Tab}");

		await expect.poll(dataRows).toBe(2);
		expect(saved).toEqual([]);
		expect(page.getByRole("table").element().querySelector('[aria-invalid="true"]')).toBeNull();
	});

	it("stays once something is typed in it", async () => {
		await renderField([stats()]);
		await page.getByRole("button", { name: "Stats", exact: true }).click();
		await cell("Label 2").click();

		await userEvent.keyboard("{Enter}x{Tab}{Tab}");
		await expect.poll(savedStats).toBe(3);
		expect(dataRows()).toBe(3);
	});

	it("goes with Backspace in its empty first cell, back to the row above", async () => {
		await renderField([stats()]);
		await page.getByRole("button", { name: "Stats", exact: true }).click();
		await cell("Value 2").click();

		await userEvent.keyboard("{Enter}");
		await expect.element(cell("Value 3")).toHaveFocus();
		await userEvent.keyboard("{Backspace}");

		await expect.poll(dataRows).toBe(2);
		await expect.element(cell("Value 2")).toHaveFocus();
		const value = cell("Value 2").element() as HTMLInputElement;
		expect(value.selectionStart).toBe(value.value.length);
		expect(saved).toEqual([]);
	});
});

describe("A removed photo's Undo", () => {
	it("stays with the photo's row when another row moves into its place", async () => {
		await renderField([gallery()]);
		await page.getByRole("button", { name: "Gallery", exact: true }).click();
		await settled();
		await page.getByRole("button", { name: "Remove Photo" }).first().click();
		await expect.element(page.getByText("Removed Photo")).toBeVisible();

		await page.getByRole("button", { name: "Second actions" }).click();
		await page.getByRole("menuitem", { name: "Move up" }).click();
		await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
		// A toast closing fades out over half a second.
		await new Promise((resolve) => setTimeout(resolve, 700));
		expect(undoButtons()).toHaveLength(1);

		await page.getByRole("button", { name: "Undo" }).click();
		const shots = () =>
			(saved.at(-1)?.[0]?.shots as Array<{ photo?: string; label: string }>) ?? [];
		await expect
			.poll(() => shots().map((shot) => [shot.label, shot.photo]))
			.toEqual([
				["Second", OTHER_PHOTO],
				["First", PHOTO],
			]);
	});
});

describe("The Undo toast", () => {
	it("fades in and out in place of sliding under reduced motion, whatever its region is called", async () => {
		await cdp().send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		await renderField([short("one"), short("two")]);
		for (const region of document.querySelectorAll('[role="region"][aria-live]')) {
			region.setAttribute("aria-label", "Benachrichtigungen");
		}
		await menuButtonOf("one").click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await until(() => document.querySelector('[role="region"] > [role="dialog"]') !== null);
		const toast = document.querySelector<HTMLElement>('[role="region"] > [role="dialog"]')!;
		const opacities: number[] = [];
		for (let count = 0; count < 6; count++) {
			opacities.push(Number(getComputedStyle(toast).opacity));
			await frame();
		}

		const slides = toast
			.getAnimations()
			.filter((a) => a instanceof CSSTransition && a.transitionProperty === "transform");
		expect(slides).toHaveLength(0);
		expect(Math.min(...opacities)).toBeLessThan(0.9);
	});
});

// ---------------------------------------------------------------------------------------------
// The blocks field in the editor

const hero = blockType("hero", "Hero", [
	{ slug: "headline", label: "Headline", type: "string", required: true },
	{ slug: "primary_cta_label", label: "Primary button text", type: "string" },
	{
		slug: "primary_cta_url",
		label: "Primary button link (starts with /, https://, mailto:, tel: or #)",
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
	{ slug: "site_url", label: "Website", type: "string", validation: { pattern: LINK_PATTERN } },
]);

const heroBlock = {
	_type: "hero",
	_version: 1,
	_key: "hero-1",
	headline: "Every building, running at its best.",
	primary_cta_label: "Book a demo",
	primary_cta_url: "/contact",
	site_url: "/",
};

const simple = blockType("simple", "Simple", [
	{ slug: "headline", label: "Headline", type: "string", required: true },
]);

const cards = blockType("cards", "Cards", [
	{
		slug: "cards",
		label: "Cards",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "title", label: "Title", type: "string" },
				{ slug: "body", label: "Body", type: "text" },
				{ slug: "photo", label: `Photo (${PHOTO_HINT.toLowerCase()})`, type: "image" },
			],
		},
	},
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
			item={makeItem({ content })}
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

describe.each(["ltr", "rtl"] as const)(
	"A settings row's problem with no room beside its value (%s)",
	(dir) => {
		it("goes on its own line under the value once focus leaves, and stays put with focus", async () => {
			document.documentElement.dir = dir;
			await renderEditor([heroBlock], [hero]);
			await openBlock("Hero");
			const link = control("Primary button link");
			const input = link.element() as HTMLInputElement;
			const group = page.getByRole("group", { name: "Primary button", exact: true }).element();
			const message = `Invalid link. ${LINK_HINT}`;

			await link.fill("contact us");
			await control("Headline").click();
			await expect.element(link).toHaveAttribute("aria-invalid", "true");
			await expect.poll(() => dangerTexts(group).map(ownText)).toEqual([message]);
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
			expect(dangerTexts(group).map(ownText)).toEqual([message]);
			expect(box(dangerTexts(group)[0]!).toJSON()).toEqual(atRest.problem);
		});
	},
);

describe.each(["ltr", "rtl"] as const)("A short settings-row problem (%s)", (dir) => {
	it("stays at the end of its value's line, moving nothing, with or without focus", async () => {
		document.documentElement.dir = dir;
		await renderEditor([heroBlock], [hero]);
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

describe("After a save finds problems", () => {
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
		row("b").querySelector<HTMLElement>("[data-block-toggle]")!.click();
		await settle();
		expect(document.getElementById("field-content.b.headline")).toBeNull();
		await next.click();
		await expect.poll(focusedId).toBe("field-content.c.headline");
	});
});

describe("An item's photo row", () => {
	it("shows its hint beside Replace and Remove only where it fits there", async () => {
		await renderEditor(
			[
				{
					_type: "cards",
					_version: 1,
					_key: "cards-1",
					cards: [
						{ title: "Riverside", body: "Tower", photo: { id: "media-1", src: PHOTO, alt: "" } },
					],
				},
			],
			[cards],
		);
		await openBlock("Cards");
		await page.getByRole("button", { name: "Riverside", exact: true }).click();
		await settle();
		const replace = page.getByRole("button", { name: "Replace", exact: true });
		const remove = page.getByRole("button", { name: "Remove", exact: true });
		const hint = () =>
			[...document.querySelectorAll("[data-blocks-field] *")].find(
				(element) => ownText(element) === PHOTO_HINT && shown(element),
			);
		const clear = (note: Element) =>
			[replace, remove].every((button) => {
				const a = box(note);
				const b = box(button);
				return a.right <= b.left || a.left >= b.right;
			});

		(replace.element() as HTMLElement).focus();
		await expect.poll(hint).toBeDefined();
		expect(clear(hint()!)).toBe(true);

		(document.activeElement as HTMLElement).blur();
		await page.viewport(600, 800);
		await settle();
		(replace.element() as HTMLElement).focus();
		await settle();
		const narrow = hint();
		if (narrow) expect(clear(narrow)).toBe(true);
	});
});
