import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { flushSync } from "react-dom";
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

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control";
const LINK_PATTERN = "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$";
const LINK_HINT = "Starts with /, https://, mailto:, tel: or #";
const LINK_PROBLEM = `Invalid link. ${LINK_HINT}`;
const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";

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

const CARD = blockType("card", "Card", [
	{ slug: "title", label: "Title", type: "string" },
	{ slug: "photo", label: "Photo", type: "image" },
]);

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

const METRICS = blockType("metrics", "Metrics", [
	{
		slug: "metrics",
		label: "Metrics",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "count", label: "Count", type: "number" },
				{ slug: "label", label: "Label", type: "string" },
			],
		},
	},
]);

const LINKED = blockType("linked", "Linked", [
	{ slug: "title", label: "Title", type: "string" },
	{
		slug: "cta_url",
		label: "Link (starts with /, https://, mailto:, tel: or #)",
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
]);

const HINTED = blockType("hinted", "Hinted", [
	{
		slug: "summary",
		label: "Summary (shown under the title on cards and in search results across the site)",
		type: "string",
	},
]);

const TYPES = [SHORT, CARD, STATS, METRICS, LINKED, HINTED];

const short = (key: string): StoredBlockValue => ({
	_type: "short",
	_version: 1,
	_key: key,
	title: key,
});
const card = (key: string): StoredBlockValue => ({
	_type: "card",
	_version: 1,
	_key: key,
	title: "Riverside",
	photo: PHOTO,
});
const stats = (): StoredBlockValue => ({
	_type: "stats",
	_version: 1,
	_key: "stats",
	stats: [
		{ value: "23%", label: "Lower spend" },
		{ value: "4x", label: "Faster" },
	],
});
const metrics = (): StoredBlockValue => ({
	_type: "metrics",
	_version: 1,
	_key: "metrics",
	metrics: [
		{ count: 12, label: "Sites" },
		{ count: 4, label: "Regions" },
	],
});
const hinted = (): StoredBlockValue => ({
	_type: "hinted",
	_version: 1,
	_key: "hinted",
	summary: "Riverside",
});
const linked = (): StoredBlockValue => ({
	_type: "linked",
	_version: 1,
	_key: "linked",
	title: "Contact",
});

/** Every value the field saved, latest last. */
const saved: StoredBlockValue[][] = [];

function Harness({ initial, id = "layout" }: { initial: StoredBlockValue[]; id?: string }) {
	const [value, setValue] = React.useState(initial);
	const props: BlocksFieldProps = {
		id: `field-${id}`,
		fieldPath: id,
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
					type={field.kind === "number" ? "number" : "text"}
					aria-labelledby={chrome.labelledBy}
					className="h-8 w-full"
					value={
						typeof fieldValue === "number"
							? String(fieldValue)
							: typeof fieldValue === "string"
								? fieldValue
								: ""
					}
					onChange={(event) =>
						onChange(
							field.kind === "number" && event.target.value !== ""
								? Number(event.target.value)
								: event.target.value,
						)
					}
				/>
			),
	};
	return <BlocksField {...props} />;
}

function renderField(initial: StoredBlockValue[], { width }: { width?: number } = {}) {
	return render(
		<div data-testid="frame" style={{ width: width ?? 480, marginInline: 80 }}>
			<Harness initial={initial} />
		</div>,
		{ wrapper: Toasty },
	);
}

/** The field in the editor's canvas, a scroller as tall as the page. */
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
const headOf = (key: string) => row(key).querySelector<HTMLElement>("[data-block-head]")!;
const toggleOf = (key: string) => row(key).querySelector<HTMLElement>("[data-block-toggle]")!;
const menuButtonOf = (key: string) =>
	page.elementLocator(row(key)).getByRole("button", { name: /actions$/ });
const canvas = () => page.getByTestId("canvas").element() as HTMLElement;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const running = () => document.getAnimations().filter((a) => a.playState === "running");
const settled = () => expect.poll(() => running().length).toBe(0);
const toastOf = () =>
	document.querySelector<HTMLElement>('[role="region"][aria-live] > [role="dialog"]');

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

/** The top of `element` now and on each of the next `frames` frames. */
function topsOver(element: Element, frames: number): Promise<number[]> {
	return new Promise((resolve) => {
		const tops = [element.getBoundingClientRect().top];
		const step = () => {
			tops.push(element.getBoundingClientRect().top);
			if (tops.length > frames) resolve(tops);
			else requestAnimationFrame(step);
		};
		requestAnimationFrame(step);
	});
}

afterEach(async () => {
	saved.length = 0;
	document.documentElement.dir = "ltr";
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
	await page.viewport(1280, 800);
});

describe.each(["ltr", "rtl"] as const)("A block's head (%s)", (dir) => {
	it("opens and closes from anywhere on its row but its menu, its photo and edges included", async () => {
		document.documentElement.dir = dir;
		await renderField([card("card"), short("after")]);
		const head = headOf("card");
		const toggle = toggleOf("card");
		const photo = head.querySelector("img")!;
		const menu = menuButtonOf("card").element();
		const rtl = dir === "rtl";
		const h = head.getBoundingClientRect();
		const t = toggle.getBoundingClientRect();
		const m = menu.getBoundingClientRect();
		const p = photo.getBoundingClientRect();
		const middle = h.top + h.height / 2;
		const inset = (rect: DOMRect, by: number) => (rtl ? rect.right - by : rect.left + by);
		const points: Array<[string, number, number]> = [
			["top edge", inset(t, 60), h.top + 3],
			["bottom edge", inset(t, 60), h.bottom - 3],
			["photo", p.left + p.width / 2, p.top + p.height / 2],
			["start edge", inset(h, 3), middle],
			["before the menu", rtl ? m.right + 4 : m.left - 4, middle],
		];

		let open = false;
		for (const [where, x, y] of points) {
			await clickAt(x, y);
			open = !open;
			await settled();
			expect(toggle.getAttribute("aria-expanded"), where).toBe(String(open));
			expect(head.getBoundingClientRect().top, where).toBe(h.top);
		}
	});
});

describe("Keeping focus clear of a toast", () => {
	it("scrolls the block focus goes to after a deletion clear of the Undo toast", async () => {
		await page.viewport(700, 900);
		await renderInCanvas(
			Array.from({ length: 30 }, (_, index) => short(`block-${index}`)),
			{ fieldWidth: 600 },
		);
		canvas().scrollTop += headOf("block-20").getBoundingClientRect().top - 831;
		await frame();
		expect(Math.round(headOf("block-20").getBoundingClientRect().top)).toBe(831);

		(menuButtonOf("block-20").element() as HTMLElement).focus();
		await userEvent.keyboard("{Enter}");
		await expect.element(page.getByRole("menu")).toBeVisible();
		await userEvent.keyboard("{End}{Enter}");
		await expect.poll(rowKeys).not.toContain("block-20");
		await expect.element(page.elementLocator(toggleOf("block-21"))).toHaveFocus();
		await settled();

		const toast = toastOf()!;
		expect(toggleOf("block-21").getBoundingClientRect().bottom).toBeLessThanOrEqual(
			toast.getBoundingClientRect().top,
		);
	});

	it("keeps clear of a toast over one of two fields on the canvas", async () => {
		await page.viewport(700, 900);
		await render(
			<div
				data-testid="canvas"
				data-emdash-editor-canvas=""
				style={{ position: "fixed", inset: 0, overflowY: "auto" }}
			>
				<div style={{ width: 600, marginInline: "auto", paddingBlock: 40 }}>
					<Harness id="wide" initial={[short("one"), short("two")]} />
				</div>
				<div style={{ width: 200, paddingBlock: 40 }}>
					<Harness id="narrow" initial={[short("three")]} />
				</div>
			</div>,
			{ wrapper: Toasty },
		);

		await deleteFromMenu("one");
		await until(() => toastOf() !== null);
		await frame();
		expect(getComputedStyle(canvas()).scrollPaddingBottom).toBe("136px");
	});

	it("keeps clear of a toast once a resize takes the field under it", async () => {
		await page.viewport(1280, 900);
		await renderInCanvas([short("one"), short("two")]);
		await deleteFromMenu("one");
		await until(() => toastOf() !== null);
		await frame();
		expect(getComputedStyle(canvas()).scrollPaddingBottom).not.toBe("136px");

		await page.viewport(700, 900);
		await expect.poll(() => getComputedStyle(canvas()).scrollPaddingBottom).toBe("136px");
	});
});

describe("The Undo toast under reduced motion", () => {
	it("fades out where it rests instead of dropping first", async () => {
		await cdp().send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		await renderField([short("one"), short("two")]);
		await deleteFromMenu("one");
		await until(() => toastOf() !== null);
		await settled();
		const toast = toastOf()!;
		const rest = toast.getBoundingClientRect().top;

		pressUndo();
		const tops: number[] = [];
		const opacities: number[] = [];
		for (let count = 0; count < 60 && toast.isConnected; count++) {
			await frame();
			if (!toast.isConnected) break;
			tops.push(toast.getBoundingClientRect().top);
			opacities.push(Number(getComputedStyle(toast).opacity));
		}

		expect(tops.length).toBeGreaterThan(2);
		expect(Math.max(...tops.map((top) => Math.abs(top - rest)))).toBeLessThanOrEqual(1);
		expect(Math.min(...opacities)).toBeLessThan(0.9);
	});
});

describe("A table's blank row", () => {
	const dataRows = () =>
		page.getByRole("table").element().querySelectorAll("[data-list-item]").length;

	it("keeps Backspace for a number cell that holds half-typed input", async () => {
		await renderField([metrics()]);
		await page.getByRole("button", { name: "Metrics", exact: true }).click();
		const count = (index: number) =>
			page.getByRole("spinbutton", { name: `Count ${index}`, exact: true });
		await count(2).click();

		await userEvent.keyboard("{Enter}");
		await expect.element(count(3)).toHaveFocus();
		await userEvent.keyboard("-");
		const input = count(3).element() as HTMLInputElement;
		expect(input.validity.badInput).toBe(true);

		await userEvent.keyboard("{Backspace}");
		expect(dataRows()).toBe(3);
		await expect.element(count(3)).toHaveFocus();
		expect(input.validity.badInput).toBe(false);
	});

	it("that Enter added goes after a click below it has landed, rather than moving it away", async () => {
		await renderField([stats(), short("after")]);
		await page.getByRole("button", { name: "Stats", exact: true }).click();
		await settled();
		await page.getByRole("textbox", { name: "Label 2", exact: true }).click();
		await userEvent.keyboard("{Enter}");
		expect(dataRows()).toBe(3);

		await clickNearBottom(toggleOf("after"));

		await expect.poll(dataRows).toBe(2);
		await settled();
		expect(toggleOf("after").getAttribute("aria-expanded")).toBe("true");
	});

	it("that Enter added goes once focus moves into a toast", async () => {
		await renderField([short("one"), stats()]);
		await deleteFromMenu("one");
		await until(() => toastOf() !== null);
		await page.getByRole("button", { name: "Stats", exact: true }).click();
		await page.getByRole("textbox", { name: "Label 2", exact: true }).click();
		await userEvent.keyboard("{Enter}");
		await expect.element(page.getByRole("textbox", { name: "Label 3", exact: true })).toHaveFocus();
		expect(dataRows()).toBe(3);

		toastOf()!.querySelector<HTMLElement>("button")!.focus();
		await expect.poll(dataRows).toBe(2);
	});
});

describe("A hint that wraps on a narrow field's label line", () => {
	it("goes after a click below it has landed, rather than moving it away", async () => {
		await renderField([hinted(), short("after")], { width: 300 });
		await page.getByRole("button", { name: "Hinted", exact: true }).click();
		await settled();
		const label = document.getElementById("field-layout.hinted.summary-label")!;
		const oneLine = label.getBoundingClientRect().height;
		await page.getByRole("textbox", { name: "Summary", exact: true }).click();
		await expect.poll(() => label.getBoundingClientRect().height).toBeGreaterThan(oneLine);

		await clickNearBottom(toggleOf("after"));

		await settled();
		expect(toggleOf("after").getAttribute("aria-expanded")).toBe("true");
		expect(label.getBoundingClientRect().height).toBe(oneLine);
	});
});

describe("The block picker", () => {
	it("opened by a tap while it still closes from a keyboard opening keeps its search out of focus", async () => {
		await renderField([short("one")]);
		const add = page
			.getByRole("button", { name: "Add block", exact: true })
			.element() as HTMLElement;
		add.focus();
		await userEvent.keyboard("{Enter}");
		const search = () =>
			document.querySelector<HTMLInputElement>(
				'[role="combobox"][aria-label="Search block types"]',
			);
		await until(() => document.activeElement === search());
		await settled();

		flushSync(() => {
			search()!.dispatchEvent(
				new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }),
			);
		});
		expect(search()).not.toBeNull();
		flushSync(() => {
			add.dispatchEvent(
				new PointerEvent("pointerdown", { pointerType: "touch", bubbles: true, isPrimary: true }),
			);
			add.click();
		});
		for (let count = 0; count < 4; count++) await frame();

		expect(search()?.tabIndex).toBe(-1);
		expect(document.activeElement).not.toBe(search());
	});
});

describe("A settings row's problem with no room beside its value", () => {
	const problem = () =>
		[...document.querySelectorAll("[data-blocks-field] *")].find(
			(element) => ownText(element) === LINK_PROBLEM && shown(element),
		);

	it("moves to a line of its own when a resize takes the room beside the value", async () => {
		await renderField([linked()], { width: 1100 });
		await page.getByRole("button", { name: "Linked", exact: true }).click();
		await settled();
		const link = page.getByRole("textbox", { name: "Link", exact: true });
		await link.fill("contact us");
		await page.getByRole("textbox", { name: "Title", exact: true }).click();
		await expect.poll(problem).toBeDefined();
		expect(box(problem()!).bottom).toBeLessThanOrEqual(box(link).bottom + 0.5);

		(page.getByTestId("frame").element() as HTMLElement).style.width = "560px";
		await expect.poll(() => problem() && box(problem()!).top >= box(link).bottom - 0.5).toBe(true);
		await settled();
		const line = problem()!;
		expect(line.scrollWidth).toBeLessThanOrEqual(line.clientWidth);
	});

	it("moves back beside the value once a resize past the stacked width gives it room", async () => {
		await renderField([linked()], { width: 400 });
		await page.getByRole("button", { name: "Linked", exact: true }).click();
		await settled();
		const link = page.getByRole("textbox", { name: "Link", exact: true });
		await link.fill("contact us");
		await page.getByRole("textbox", { name: "Title", exact: true }).click();
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
	{ slug: "centered", label: "Center the layout", type: "boolean" },
]);

const heroBlock = {
	_type: "hero",
	_version: 1,
	_key: "hero-1",
	headline: "Every building, running at its best.",
	primary_cta_label: "Book a demo",
	primary_cta_url: "/contact",
	centered: false,
};

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

async function openBlock(name: string) {
	await page.getByRole("button", { name, exact: true }).click();
	await settled();
}

describe("A settings row's problem line", () => {
	const center = () => page.getByRole("switch", { name: "Center the layout" });
	const buttonRow = () =>
		page.getByRole("group", { name: "Primary button", exact: true }).element();

	it("comes after a click below it has landed, rather than moving it away", async () => {
		await renderEditor([heroBlock], [hero]);
		await openBlock("Hero");
		const link = control("Primary button link");

		await link.fill("contact us");
		const target = box(center());
		await clickAt(target.left + target.width / 2, target.top + 3, { hold: 150 });

		await expect.element(center()).toBeChecked();
		await expect.poll(() => dangerTexts(buttonRow()).map(ownText)).toEqual([LINK_PROBLEM]);
	});

	it("goes after a click below it has landed, rather than moving it away", async () => {
		await renderEditor([heroBlock], [hero]);
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
		await renderEditor([heroBlock], [hero]);
		await openBlock("Hero");
		const link = control("Primary button link");
		const switchElement = center().element();
		/** The largest move between two frames, as a share of the whole way. */
		const largestShare = (tops: number[]) => {
			const steps = tops.slice(1).map((top, index) => Math.abs(top - tops[index]!));
			return Math.max(0, ...steps) / Math.abs(tops.at(-1)! - tops[0]!);
		};

		await link.fill("contact us");
		const coming = topsOver(switchElement, 30);
		await userEvent.keyboard("{Tab}");
		const down = await coming;
		await settled();
		expect(down.at(-1)! - down[0]!).toBeGreaterThan(15);
		expect(largestShare(down)).toBeLessThanOrEqual(0.5);

		await link.click();
		await link.fill("/contact");
		const going = topsOver(switchElement, 30);
		await userEvent.keyboard("{Tab}");
		const up = await going;
		await settled();
		expect(up[0]! - up.at(-1)!).toBeGreaterThan(15);
		expect(largestShare(up)).toBeLessThanOrEqual(0.5);
	});

	it("comes at once under reduced motion", async () => {
		await cdp().send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		await renderEditor([heroBlock], [hero]);
		await openBlock("Hero");
		const link = control("Primary button link");
		const before = box(center()).top;

		await link.fill("contact us");
		await userEvent.keyboard("{Tab}");
		await frame();

		expect(box(center()).top - before).toBeGreaterThan(15);
		expect(running()).toEqual([]);
	});
});
