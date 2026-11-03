import { Select, Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { QUIET_OPTION } from "../../src/components/block-field-styles.js";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import { ImageFieldRenderer } from "../../src/components/ImageFieldRenderer.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { expectGlide, holdAnimations, readAlong, readMotion } from "../utils/animation.js";
import { render } from "../utils/render.js";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));

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

const SHORT = blockType("short", "Short", [
	{ slug: "title", label: "Title", type: "string" },
	{ slug: "body", label: "Body", type: "string" },
	{ slug: "note", label: "Note", type: "string" },
]);

const LONG = blockType(
	"long",
	"Long",
	Array.from({ length: 12 }, (_, index) => ({
		slug: `line_${index}`,
		label: `Line ${index}`,
		type: "string" as const,
	})),
);

const QUOTES = blockType("quotes", "Testimonials", [
	{
		slug: "quotes",
		label: "Testimonials",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "quote", label: "Quote", type: "text" },
				{ slug: "author", label: "Author name", type: "string" },
				{ slug: "role", label: "Role or title", type: "string" },
			],
		},
	},
]);

const CARD = blockType("card", "Card", [
	{ slug: "title", label: "Title", type: "string" },
	{ slug: "photo", label: "Photo", type: "image" },
]);

const TYPES = [SHORT, LONG, QUOTES, CARD];

const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";

const short = (key: string): StoredBlockValue => ({
	_type: "short",
	_version: 1,
	_key: key,
	title: key,
});

const quotes = (key = "quotes"): StoredBlockValue => ({
	_type: "quotes",
	_version: 1,
	_key: key,
	quotes: [
		{ author: "Maya Okafor", quote: "Savings in the first month." },
		{ author: "Jonas Berg", quote: "The numbers add up." },
		{ author: "Ines Duarte", quote: "Our buildings run themselves." },
	],
});

const card = (key: string): StoredBlockValue => ({
	_type: "card",
	_version: 1,
	_key: key,
	title: "Riverside",
	photo: PHOTO,
});

function Harness({
	initial,
	retiredTypes = [],
}: {
	initial: StoredBlockValue[];
	retiredTypes?: string[];
}) {
	const [value, setValue] = React.useState(initial);
	const props: BlocksFieldProps = {
		id: "field-layout",
		fieldPath: "layout",
		label: "Layout",
		value,
		onChange: setValue,
		blockTypes: TYPES,
		allowedTypes: TYPES.map((type) => type.slug),
		retiredTypes,
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

/** The field with room beside it for its gutter, in a scroller with the editor canvas's scroll padding. */
function renderField(
	initial: StoredBlockValue[],
	{ height, retiredTypes }: { height?: number; retiredTypes?: string[] } = {},
) {
	return render(
		<div
			data-testid="scroller"
			style={height ? { height, overflowY: "auto", scrollPaddingTop: 52 } : undefined}
		>
			{height ? <div style={{ height: 200 }} /> : null}
			<div style={{ width: 480, marginInline: 80 }}>
				<Harness initial={initial} retiredTypes={retiredTypes} />
			</div>
			{height ? <div style={{ height: 600 }} /> : null}
		</div>,
		{ wrapper: Toasty },
	);
}

const field = () => document.querySelector<HTMLElement>("[data-blocks-field]")!;
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
const handleOf = (key: string) => row(key).querySelector<HTMLElement>('[aria-label^="Reorder"]')!;
const addBlock = () => page.getByRole("button", { name: "Add block", exact: true });
const addItem = () => page.getByRole("button", { name: "Add item" });
const fieldTop = () => field().getBoundingClientRect().top;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const running = () => document.getAnimations().filter((a) => a.playState === "running");
/** Animations started by script, as the rows' own motion is, rather than by a stylesheet. */
const scripted = () =>
	running().filter((a) => !(a instanceof CSSTransition) && !(a instanceof CSSAnimation));
const settled = () => expect.poll(() => running().length).toBe(0);
const announced = () => field().querySelector('[aria-live="polite"]')?.textContent ?? "";

/** Calls `read` on every frame for `ms`, and returns what it read with the time of each frame. */
async function sample<T>(read: () => T, ms: number): Promise<Array<{ t: number; value: T }>> {
	const frames: Array<{ t: number; value: T }> = [];
	const start = performance.now();
	await new Promise<void>((resolve) => {
		const tick = (now: number) => {
			frames.push({ t: now - start, value: read() });
			if (now - start < ms) requestAnimationFrame(tick);
			else resolve();
		};
		requestAnimationFrame(tick);
	});
	return frames;
}

/** Whether `target` is in the blocks field, where everything that moves its rows is. */
const inField = (target: Element) => field().contains(target);

async function reduceMotion() {
	await cdp().send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
}

/** Lays out each row's gutter, which the stylesheet shows only with a hover-capable fine pointer. */
function showGutters() {
	for (const add of document.querySelectorAll<HTMLElement>('[aria-label^="Add block below"]')) {
		add.parentElement!.style.display = "flex";
	}
}

function pointer(type: string, x: number, y: number) {
	return new PointerEvent(type, {
		bubbles: true,
		cancelable: true,
		isPrimary: true,
		pointerId: 1,
		button: 0,
		buttons: type === "pointerup" ? 0 : 1,
		clientX: x,
		clientY: y,
	});
}

/** Picks a block up by its grip and carries it 12px past the center of the row `to`, still held. */
async function dragOver(key: string, to: string) {
	const start = row(key).getBoundingClientRect();
	const x = start.left + 4;
	const y = start.top + start.height / 2;
	const target = row(to).getBoundingClientRect();
	const end = target.top + target.height / 2 + 12;
	handleOf(key).dispatchEvent(pointer("pointerdown", x, y));
	for (let step = 1; step <= 12; step++) {
		document.dispatchEvent(pointer("pointermove", x, y + ((end - y) * step) / 12));
		await frame();
	}
	return { x, y: end };
}

/** Clicks the point `x`, `y` with the mouse. */
async function clickAt(x: number, y: number) {
	// Mouse input lands in the top-level page, which hosts this test's frame.
	const host = window.frameElement?.getBoundingClientRect() ?? new DOMRect();
	const scale = host.width ? host.width / window.innerWidth : 1;
	const point = { x: host.left + x * scale, y: host.top + y * scale };
	const button = { ...point, button: "left", clickCount: 1 } as const;
	await cdp().send("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
	await cdp().send("Input.dispatchMouseEvent", { type: "mousePressed", ...button });
	await cdp().send("Input.dispatchMouseEvent", { type: "mouseReleased", ...button });
}

afterEach(async () => {
	document.documentElement.dir = "ltr";
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

describe("Blocks field popups", () => {
	/**
	 * Watches for a popup to appear, and reads its entrance there, before a frame can run it: its
	 * animation, and its opacity 60ms in.
	 */
	function watchPopup(find: () => HTMLElement | null | undefined) {
		return new Promise<{
			animation: string;
			easing: string;
			duration: string;
			running: boolean;
			early: number;
		}>((resolve) => {
			const observer = new MutationObserver(() => {
				const popup = find();
				if (!popup) return;
				observer.disconnect();
				const style = getComputedStyle(popup);
				const entrance = popup.getAnimations().find((each) => each instanceof CSSAnimation);
				const first = {
					animation: style.animationName,
					easing: style.animationTimingFunction,
					duration: style.animationDuration,
					running: entrance?.playState === "running",
				};
				entrance?.pause();
				if (entrance) entrance.currentTime = 60;
				const early = Number(getComputedStyle(popup).opacity);
				entrance?.play();
				resolve({ ...first, early });
			});
			observer.observe(document.body, { childList: true, subtree: true, attributes: true });
		});
	}

	function expectPopupMotion(first: Awaited<ReturnType<typeof watchPopup>>) {
		expect(first.animation).toBe("emdash-popup-in");
		expect(first.easing).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
		expect(first.duration).toBe("0.15s");
		expect(first.running).toBe(true);
		expect(first.early).toBeGreaterThanOrEqual(0.4);
	}

	it("opens the block menu, the picker and an item menu with one motion, from their first frame", async () => {
		await renderField([short("one"), quotes()]);
		await page.getByRole("button", { name: "Testimonials", exact: true }).click();
		await settled();

		const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
		const blockMenu = watchPopup(menu);
		await menuButtonOf("one").click();
		expectPopupMotion(await blockMenu);
		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

		const picker = () => document.querySelector<HTMLElement>('[role="dialog"]');
		const pickerFrames = watchPopup(picker);
		await addBlock().click();
		expectPopupMotion(await pickerFrames);
		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();

		const itemMenu = watchPopup(menu);
		await page.getByRole("button", { name: "Jonas Berg actions" }).click();
		expectPopupMotion(await itemMenu);
	});

	it("opens a quiet select's options with the same motion and closes them at once on a choice", async () => {
		await render(
			<Select aria-label="Icon" items={{ bolt: "Bolt", leaf: "Leaf" }} value={null}>
				<Select.Option value="bolt" className={QUIET_OPTION}>
					Bolt
				</Select.Option>
				<Select.Option value="leaf" className={QUIET_OPTION}>
					Leaf
				</Select.Option>
			</Select>,
		);
		const popup = () =>
			document.querySelector('[role="listbox"]')?.parentElement as HTMLElement | undefined;
		const frames = watchPopup(popup);
		await page.getByRole("combobox", { name: "Icon" }).click();
		expectPopupMotion(await frames);

		await settled();
		// A closed select keeps its popup mounted, hidden.
		const closing = sample(() => {
			const element = popup();
			const shown = element?.checkVisibility({ opacityProperty: true, visibilityProperty: true });
			return shown ? Number(getComputedStyle(element!).opacity) : 0;
		}, 600);
		await page.getByRole("option", { name: "Leaf" }).click();
		const opacities = (await closing).map((each) => each.value);
		const firstBelowFull = opacities.findIndex((opacity) => opacity < 0.99);
		expect(firstBelowFull).toBeGreaterThanOrEqual(0);
		expect(opacities[firstBelowFull]).toBeLessThanOrEqual(0.01);
	});

	it("opens its menus and picker without motion when reduced motion is preferred", async () => {
		await reduceMotion();
		await renderField([short("one")]);
		const animated = (popup: Element) => getComputedStyle(popup).animationName !== "none";

		await menuButtonOf("one").click();
		await expect.element(page.getByRole("menu")).toBeVisible();
		expect(animated(document.querySelector('[role="menu"]')!)).toBe(false);
		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

		await addBlock().click();
		await expect.element(page.getByRole("dialog", { name: "Add block" })).toBeVisible();
		expect(animated(document.querySelector('[role="dialog"]')!)).toBe(false);
	});

	it("takes the picker away in the frame its new block appears, and at once on Escape", async () => {
		await renderField([short("one")]);
		const picker = () => document.querySelector<HTMLElement>('[role="dialog"]');

		await addBlock().click();
		await expect.element(page.getByRole("dialog", { name: "Add block" })).toBeVisible();
		await settled();
		const pick = sample(
			() => ({
				rows: rowKeys().length,
				picker: picker()?.isConnected ? Number(getComputedStyle(picker()!).opacity) : 0,
			}),
			300,
		);
		await page.getByRole("option", { name: /Short/ }).click();
		const frames = (await pick).map((each) => each.value);
		const added = frames.findIndex((each) => each.rows === 2);
		expect(added).toBeGreaterThanOrEqual(0);
		for (const each of frames.slice(added + 1)) expect(each.picker).toBeLessThanOrEqual(0.01);

		await addBlock().click();
		await expect.element(page.getByRole("dialog", { name: "Add block" })).toBeVisible();
		await settled();
		const dismiss = sample(
			() => (picker()?.isConnected ? Number(getComputedStyle(picker()!).opacity) : 0),
			250,
		);
		await userEvent.keyboard("{Escape}");
		const opacities = (await dismiss).map((each) => each.value);
		const leaving = opacities.findIndex((opacity) => opacity < 0.99);
		expect(leaving).toBeGreaterThanOrEqual(0);
		expect(opacities[leaving]).toBeLessThanOrEqual(0.01);
	});
});

describe("Blocks field structure motion", () => {
	it("grows a new item from nothing, so the rows under it glide down", async () => {
		await renderField([quotes()]);
		await page.getByRole("button", { name: "Testimonials", exact: true }).click();
		await settled();
		const button = addItem().element() as HTMLElement;

		const { from, along, to } = await readMotion(
			inField,
			() => button.getBoundingClientRect().top - fieldTop(),
			() => addItem().click(),
		);

		expect(to - from).toBeGreaterThan(60);
		expectGlide(along, from, to);
	});

	it("grows an inserted block and a duplicate in place of a jump", async () => {
		await renderField([short("one"), short("two")]);
		const button = addBlock().element() as HTMLElement;

		await addBlock().click();
		const inserted = await readMotion(
			inField,
			() => button.getBoundingClientRect().top - fieldTop(),
			() => page.getByRole("option", { name: /Short/ }).click(),
		);
		expect(inserted.to - inserted.from).toBeGreaterThan(60);
		expectGlide(inserted.along, inserted.from, inserted.to);

		await menuButtonOf("one").click();
		const duplicated = await readMotion(
			inField,
			() => row("two").getBoundingClientRect().top - fieldTop(),
			() => page.getByRole("menuitem", { name: "Duplicate" }).click(),
		);
		expect(duplicated.to - duplicated.from).toBeGreaterThan(30);
		expectGlide(duplicated.along, duplicated.from, duplicated.to);
	});

	it("shrinks a deleted block before it goes, then focuses its neighbour, and Undo still restores it", async () => {
		await renderField([short("one"), short("two"), short("three")]);

		await menuButtonOf("two").click();
		const top = () => row("three").getBoundingClientRect().top - fieldTop();
		const from = top();
		const shrink = holdAnimations(inField);
		await page.getByRole("menuitem", { name: "Delete" }).click();
		const along = readAlong(await shrink.started(), top, [0.25, 0.5, 0.75, 1]);
		expect(rowKeys()).toHaveLength(3);
		shrink.release();
		await expect.poll(() => rowKeys().length).toBe(2);
		await settled();

		const to = top();
		expect(to - from).toBeLessThan(-30);
		expectGlide(along.slice(0, -1), from, to);
		// Taking out the row once it has shrunk away moves the rows below no more than a pixel.
		expect(Math.abs(along.at(-1)! - to)).toBeLessThanOrEqual(1);
		await expect.element(page.elementLocator(toggleOf("three"))).toHaveFocus();

		await page.getByRole("button", { name: "Undo" }).click();
		await expect.poll(rowKeys).toEqual(["one", "two", "three"]);
	});

	it("shrinks a deleted item before it goes", async () => {
		await renderField([quotes()]);
		await page.getByRole("button", { name: "Testimonials", exact: true }).click();
		await settled();
		const ines = () =>
			page.getByRole("button", { name: "Ines Duarte", exact: true }).element() as HTMLElement;
		const before = ines().getBoundingClientRect().top;

		await page.getByRole("button", { name: "Jonas Berg actions" }).click();
		const { from, along, to } = await readMotion(
			inField,
			() => ines().getBoundingClientRect().top - fieldTop(),
			() => page.getByRole("menuitem", { name: "Delete" }).click(),
		);

		expect(to - from).toBeLessThan(-20);
		expectGlide(along, from, to);
		expect(ines().getBoundingClientRect().top).toBeLessThan(before);
	});

	it("leaves a menu opened while a deleted block or item shrinks away open", async () => {
		await renderField([short("one"), short("two"), quotes()]);
		await page.getByRole("button", { name: "Testimonials", exact: true }).click();
		await settled();
		const item = (name: string) =>
			page
				.getByRole("button", { name, exact: true })
				.element()
				.closest<HTMLElement>("[data-item-key]")!;
		/** Holds the row's shrink, so the next press comes while it's still on its way out. */
		const holdShrink = async (shrinking: HTMLElement) => {
			await expect.poll(() => shrinking.getAnimations().length).toBe(1);
			const shrink = shrinking.getAnimations()[0]!;
			shrink.pause();
			return shrink;
		};

		await menuButtonOf("two").click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		const block = await holdShrink(row("two"));
		await menuButtonOf("one").click();
		await expect.element(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
		block.finish();
		await expect.poll(rowKeys).toEqual(["one", "quotes"]);
		await frame();
		expect(document.activeElement).not.toBe(toggleOf("quotes"));
		await expect.element(menuButtonOf("one")).toHaveAttribute("aria-expanded", "true");
		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

		await page.getByRole("button", { name: "Jonas Berg actions" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		const listItem = await holdShrink(item("Jonas Berg"));
		await page.getByRole("button", { name: "Maya Okafor actions" }).click();
		await expect.element(page.getByRole("menuitem", { name: "Delete" })).toBeVisible();
		listItem.finish();
		await expect
			.element(page.getByRole("button", { name: "Jonas Berg", exact: true }))
			.not.toBeInTheDocument();
		await frame();
		expect(document.activeElement).not.toBe(
			page.getByRole("button", { name: "Ines Duarte", exact: true }).element(),
		);
		await expect
			.element(page.getByRole("button", { name: "Maya Okafor actions" }))
			.toHaveAttribute("aria-expanded", "true");
	});

	it("slides the rows a menu move swaps, and moves at once with Alt+Shift+Arrow", async () => {
		await renderField([short("one"), short("two"), short("three")]);
		const slides = () =>
			running().filter(
				(animation) =>
					animation.effect instanceof KeyframeEffect &&
					animation.effect.target instanceof HTMLElement &&
					animation.effect.target.matches("[data-block-key]") &&
					animation.effect.getKeyframes().some((keyframe) => "transform" in keyframe),
			).length;

		await menuButtonOf("one").click();
		await page.getByRole("menuitem", { name: "Move down" }).click();
		expect(rowKeys()).toEqual(["two", "one", "three"]);
		expect(slides()).toBeGreaterThanOrEqual(2);
		await settled();

		toggleOf("three").focus();
		await userEvent.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
		expect(rowKeys()).toEqual(["two", "three", "one"]);
		expect(slides()).toBe(0);
	});

	it("adds, duplicates, moves and deletes without motion when reduced motion is preferred", async () => {
		await reduceMotion();
		await renderField([short("one"), short("two"), quotes()]);
		await page.getByRole("button", { name: "Testimonials", exact: true }).click();
		await settled();

		await addItem().click();
		expect(scripted()).toHaveLength(0);
		await menuButtonOf("one").click();
		await page.getByRole("menuitem", { name: "Duplicate" }).click();
		await expect.poll(() => rowKeys().length).toBe(4);
		expect(scripted()).toHaveLength(0);
		await menuButtonOf("two").click();
		await page.getByRole("menuitem", { name: "Move up" }).click();
		expect(scripted()).toHaveLength(0);
		await menuButtonOf("two").click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await expect.poll(() => rowKeys().length).toBe(3);
		expect(scripted()).toHaveLength(0);
	});
});

describe("Blocks field structure feedback", () => {
	it("duplicates a closed block as a closed copy, focuses the copy and says so", async () => {
		await renderField([short("one"), short("two")]);

		await menuButtonOf("one").click();
		await page.getByRole("menuitem", { name: "Duplicate" }).click();

		await expect.poll(() => rowKeys().length).toBe(3);
		const copy = rowKeys()[1]!;
		expect(toggleOf(copy).getAttribute("aria-expanded")).toBe("false");
		await expect.element(page.elementLocator(toggleOf(copy))).toHaveFocus();
		await expect.poll(announced).toBe("Duplicated Short");
	});

	it("duplicates an open block as an open copy", async () => {
		await renderField([short("one"), short("two")]);
		toggleOf("one").click();
		await settled();

		await menuButtonOf("one").click();
		await page.getByRole("menuitem", { name: "Duplicate" }).click();

		await expect.poll(() => rowKeys().length).toBe(3);
		expect(toggleOf(rowKeys()[1]!).getAttribute("aria-expanded")).toBe("true");
	});

	it("duplicates a closed item as a closed copy, focuses the copy and says so", async () => {
		await renderField([quotes()]);
		await page.getByRole("button", { name: "Testimonials", exact: true }).click();
		await settled();

		await page.getByRole("button", { name: "Jonas Berg actions" }).click();
		await page.getByRole("menuitem", { name: "Duplicate" }).click();

		const copies = page.getByRole("button", { name: "Jonas Berg", exact: true });
		await expect.poll(() => copies.all().length).toBe(2);
		await expect.element(copies.nth(1)).toHaveAttribute("aria-expanded", "false");
		await expect.element(copies.nth(1)).toHaveFocus();
		await expect
			.poll(() => document.querySelector("[data-list-item]")?.closest("[data-field]")?.textContent)
			.toContain("Duplicated Jonas Berg");
	});

	/** The scroller's view under its scroll padding. */
	function view() {
		const scroller = page.getByTestId("scroller").element() as HTMLElement;
		const box = scroller.getBoundingClientRect();
		return { top: box.top + 52, bottom: box.bottom };
	}

	it("brings a row moved from the menu into view with room under it", async () => {
		await renderField(["one", "two", "three", "four", "five", "six"].map(short), { height: 300 });
		const scroller = page.getByTestId("scroller").element() as HTMLElement;
		scroller.scrollTop = row("four").getBoundingClientRect().bottom - view().bottom + 4;
		expect(row("four").getBoundingClientRect().bottom).toBeGreaterThan(view().bottom - 8);

		await menuButtonOf("four").click();
		await page.getByRole("menuitem", { name: "Move down" }).click();
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 250));

		const moved = row("four").getBoundingClientRect();
		expect(moved.top).toBeGreaterThanOrEqual(view().top - 1);
		expect(moved.bottom).toBeLessThanOrEqual(view().bottom - 32);
	});

	it("brings an added block and a duplicate into view with room under them", async () => {
		await renderField(["one", "two", "three", "four", "five"].map(short), { height: 300 });
		const scroller = page.getByTestId("scroller").element() as HTMLElement;
		scroller.scrollTop = row("five").getBoundingClientRect().bottom - view().bottom + 4;

		await menuButtonOf("five").click();
		await page.getByRole("menuitem", { name: "Duplicate" }).click();
		await expect.poll(() => rowKeys().length).toBe(6);
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 250));
		const copy = row(rowKeys()[5]!).getBoundingClientRect();
		expect(copy.top).toBeGreaterThanOrEqual(view().top - 1);
		expect(copy.bottom).toBeLessThanOrEqual(view().bottom - 32);

		await addBlock().click();
		await page.getByRole("option", { name: /Short/ }).click();
		await expect.poll(() => rowKeys().length).toBe(7);
		await settled();
		await new Promise((resolve) => setTimeout(resolve, 250));
		const added = row(rowKeys()[6]!).getBoundingClientRect();
		expect(added.top).toBeGreaterThanOrEqual(view().top - 1);
		expect(added.bottom).toBeLessThanOrEqual(view().bottom - 32);
	});
});

describe("Blocks field drag", () => {
	it("doesn't slide rows aside during a drag when reduced motion is preferred", async () => {
		await reduceMotion();
		await renderField([short("one"), short("two"), short("three")]);

		const { x, y } = await dragOver("one", "three");
		const durations = rowKeys().flatMap((key) =>
			getComputedStyle(row(key!)).transitionDuration.split(",").map(Number.parseFloat),
		);
		document.dispatchEvent(pointer("pointerup", x, y));

		expect(durations.every((duration) => duration === 0)).toBe(true);
	});

	it("announces a drag politely in its own words, naming the block", async () => {
		await renderField([short("one"), short("two"), short("three")]);

		const { x, y } = await dragOver("one", "three");
		await expect.poll(announced).toMatch(/Short/);
		document.dispatchEvent(pointer("pointerup", x, y));

		await expect.poll(announced).toBe("Moved Short to position 3 of 3");
		const dndRegion = document.querySelector('[id^="DndLiveRegion"]');
		expect(dndRegion?.textContent ?? "").toBe("");
		expect(document.querySelector('[id^="DndDescribedBy"]')?.textContent ?? "").toBe("");
	});

	it("fades the lifted row's shadow in on pickup and out while it settles", async () => {
		await renderField([short("one"), short("two"), short("three")]);
		const shadow = () => {
			const lifted = row("one");
			if (getComputedStyle(lifted).boxShadow !== "none") return 1;
			const after = getComputedStyle(lifted, "::after");
			return after.boxShadow === "none" ? 0 : Number(after.opacity);
		};
		// The shadow lifts on a stylesheet transition. One is created by the first style update after
		// the row's class changes, which a script reading the row's layout can bring forward to the
		// commit, so it's caught there, before a frame can run it.
		const lifts: Animation[] = [];
		const holdLift = new MutationObserver(() => {
			for (const transition of row("one").getAnimations({ subtree: true })) {
				if (
					transition instanceof CSSTransition &&
					(transition.effect as KeyframeEffect).pseudoElement === "::after" &&
					!lifts.includes(transition)
				) {
					transition.pause();
					lifts.push(transition);
				}
			}
		});
		holdLift.observe(row("one"), { attributes: true });

		const start = row("one").getBoundingClientRect();
		const x = start.left + 4;
		const y = start.top + start.height / 2;
		handleOf("one").dispatchEvent(pointer("pointerdown", x, y));
		for (let step = 1; step <= 4; step++) {
			document.dispatchEvent(pointer("pointermove", x, y + step * 6));
			await frame();
		}
		holdLift.disconnect();
		expect(lifts.length, "the shadow's lift to start").toBeGreaterThan(0);
		const lifting = readAlong(lifts, shadow);
		for (const transition of lifts) transition.play();
		await settled();
		expect(shadow()).toBeGreaterThan(0.98);
		expectGlide(lifting, 0, 1);

		const target = row("three").getBoundingClientRect();
		const end = target.top + target.height / 2 + 12;
		for (let step = 1; step <= 8; step++) {
			document.dispatchEvent(pointer("pointermove", x, y + 24 + ((end - y - 24) * step) / 8));
			await frame();
		}
		const drop = holdAnimations((element) => element === row("one"));
		document.dispatchEvent(pointer("pointerup", x, end));
		const settling = await drop.started();
		const dropping = readAlong(settling, shadow);
		expectGlide(dropping, 1, 0);
		for (const animation of settling) animation.currentTime = 220;
		expect(shadow()).toBeLessThanOrEqual(0.02);
	});
});

describe("Blocks field quiet return focus", () => {
	const shows = (element: Element) => element.checkVisibility({ opacityProperty: true });
	// A pointer left where the menu opens would highlight an item, which keeps focus on the button.
	const parkPointer = () => userEvent.hover(page.getByText("Layout", { exact: true }));

	it("hides a menu button opened with the pointer once Escape closes its menu and the pointer has left", async () => {
		await renderField([short("one"), short("two")]);
		const menuButton = menuButtonOf("two");
		await parkPointer();

		await menuButton.click();
		// The menu takes focus a frame after it shows.
		await expect.poll(() => document.activeElement?.closest('[role="menu"]')).toBeTruthy();
		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByRole("menu")).not.toBeInTheDocument();
		await expect.element(menuButton).toHaveFocus();
		await userEvent.hover(page.getByText("Layout", { exact: true }));

		await expect.poll(() => shows(menuButton.element())).toBe(false);
	});

	it("puts focus back on the drag handle after Escape in a picker its menu opened, with the gutter hidden", async () => {
		await renderField([short("one"), short("two")]);
		showGutters();
		const handle = page.elementLocator(handleOf("one"));
		await parkPointer();

		await handle.click();
		await page.getByRole("menuitem", { name: "Add block above" }).click();
		await expect.element(page.getByRole("combobox", { name: "Search block types" })).toHaveFocus();
		await userEvent.keyboard("{Escape}");
		await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
		await expect.element(handle).toHaveFocus();
		await userEvent.hover(page.getByText("Layout", { exact: true }));

		await expect.poll(() => shows(handleOf("one"))).toBe(false);
	});
});

describe("Blocks field disclosure", () => {
	it("lands a block's caret and fields together when it's closed while opening", async () => {
		await renderField([{ _type: "long", _version: 1, _key: "long" }]);
		const caret = () => toggleOf("long").querySelector("svg")!;
		const angle = () => Math.abs(Number.parseFloat(getComputedStyle(caret()).rotate) || 0);
		const body = () => row("long").querySelector<HTMLElement>("[data-block-body]");

		const motion = holdAnimations((target) => row("long").contains(target));

		// A caret styled for the first time as it opens has nothing to turn from.
		await frame();
		toggleOf("long").click();
		// Reverse about a third of the way open, with the caret's own transition as far along.
		const [opening] = await motion.started();
		const reverseAt = Number(opening!.effect!.getComputedTiming().endTime) * 0.12;
		opening!.currentTime = reverseAt;
		for (const turn of caret().getAnimations()) {
			turn.pause();
			turn.currentTime = reverseAt;
		}
		const full = body()!.firstElementChild!.getBoundingClientRect().height;
		expect(body()!.getBoundingClientRect().height).toBeGreaterThan(full * 0.2);
		expect(body()!.getBoundingClientRect().height).toBeLessThan(full * 0.7);
		expect(angle()).toBeGreaterThan(5);
		toggleOf("long").click();
		const closing = await motion.started();
		const duration = Math.max(
			...closing.map((animation) => Number(animation.effect!.getComputedTiming().endTime)),
		);
		const at = (time: number) => {
			for (const animation of closing) animation.currentTime = time;
			return { angle: angle(), height: body()?.getBoundingClientRect().height ?? 0 };
		};

		// On one clock, the caret has as much of its turn left as the fields have of their height.
		const reversed = at(0);
		expect(reversed.angle).toBeGreaterThan(5);
		for (const share of [0.25, 0.5, 0.75]) {
			const { angle: turned, height } = at(duration * share);
			expect(turned / reversed.angle).toBeCloseTo(height / reversed.height, 1);
		}
		const landed = at(duration);
		expect(landed.angle).toBeLessThan(0.5);
		expect(landed.height).toBeLessThan(0.5);
		motion.release();
		await expect.poll(body).toBeNull();
	});

	it.each(["ltr", "rtl"] as const)(
		"opens and closes a block from anywhere on its head but its menu, its photo and edges included (%s)",
		async (dir) => {
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
		},
	);

	it("opens and closes a block from its status badge like the rest of its head", async () => {
		await renderField([short("old"), short("after")], { retiredTypes: ["short"] });
		const toggle = toggleOf("old");
		await expect.element(page.elementLocator(toggle)).toHaveAccessibleDescription(/Retired/);
		const badge = page.elementLocator(row("old")).getByText("Retired", { exact: true });

		await badge.click();
		await settled();
		expect(toggle.getAttribute("aria-expanded")).toBe("true");
		await badge.click();
		await settled();
		expect(toggle.getAttribute("aria-expanded")).toBe("false");
	});
});

describe("Blocks field touch targets", () => {
	/** Whether a tap `by` px outside the button's edge, on its end, lands on it. */
	function reachesEnd(button: HTMLElement, by: number) {
		const box = button.getBoundingClientRect();
		return button.contains(document.elementFromPoint(box.right + by, box.top + box.height / 2));
	}

	it("keeps row menu hit areas to the button with a mouse", async () => {
		await renderField([short("one")]);
		const blockMenu = menuButtonOf("one").element() as HTMLElement;
		expect(reachesEnd(blockMenu, 8)).toBe(false);
	});
});
