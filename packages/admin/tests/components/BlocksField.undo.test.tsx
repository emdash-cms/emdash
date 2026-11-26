import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import { ImageFieldRenderer } from "../../src/components/ImageFieldRenderer.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { expectGlide, holdAnimations, readAlong, readMotion } from "../utils/animation.js";
import { render } from "../utils/render.js";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));

const MOD = /Mac|iPhone|iPad/.test(navigator.platform) ? "Meta" : "Control";
const PHOTO =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='9'/%3E";
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

/** Taller when open than `LONG`, as its fields are text areas. */
const TALL = blockType(
	"tall",
	"Tall",
	Array.from({ length: 12 }, (_, index) => ({
		slug: `line_${index}`,
		label: `Line ${index}`,
		type: "text" as const,
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

const CARD = blockType("card", "Card", [
	{ slug: "headline", label: "Headline", type: "string" },
	{ slug: "photo", label: "Background image", type: "image" },
	{ slug: "caption", label: "Footnote", type: "string" },
]);

const EMBED = blockType("embed", "Embed", [{ slug: "body", label: "Body", type: "text" }]);

const LINKED = blockType("linked", "Linked", [
	{ slug: "link", label: "Link (starts with / or https://)", type: "string" },
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

const TYPES = [SHORT, LONG, TALL, QUOTES, STATS, CARD, EMBED, LINKED, GALLERY];

const short = (key: string): StoredBlockValue => ({
	_type: "short",
	_version: 1,
	_key: key,
	title: key,
});
const long = (key: string): StoredBlockValue => ({ _type: "long", _version: 1, _key: key });
const tall = (key: string): StoredBlockValue => ({ _type: "tall", _version: 1, _key: key });
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

/** The next field to mount takes this long, as a rich text editor's mount can. */
const slowMount = { ms: 0 };

function SlowMount({ children }: { children: React.ReactNode }) {
	React.useLayoutEffect(() => {
		const done = performance.now() + slowMount.ms;
		slowMount.ms = 0;
		while (performance.now() < done) {
			// Busy, as a heavy editor's mount is.
		}
	}, []);
	return children;
}

const setters = new Map<
	string,
	{ value: (value: StoredBlockValue[]) => void; readOnly: (readOnly: boolean) => void }
>();

function Harness({
	id = "layout",
	label = "Layout",
	initial,
}: {
	id?: string;
	label?: string;
	initial: StoredBlockValue[];
}) {
	const [value, setValue] = React.useState(initial);
	const [readOnly, setReadOnly] = React.useState(false);
	setters.set(id, { value: setValue, readOnly: setReadOnly });
	const props: BlocksFieldProps = {
		id: `field-${id}`,
		fieldPath: id,
		label,
		value,
		onChange: (next) => {
			saved.push(next);
			setValue(next);
		},
		blockTypes: TYPES,
		allowedTypes: TYPES.map((type) => type.slug),
		retiredTypes: [],
		readOnly,
		renderField: ({ name, field, value: fieldValue, onChange, chrome }) => {
			if (field.kind === "image") {
				return (
					<ImageFieldRenderer
						label={field.label ?? ""}
						labelledBy={chrome.labelledBy}
						thumbnail={chrome.thumbnail}
						value={fieldValue as string | undefined}
						onChange={(next) => onChange(next ?? undefined)}
					/>
				);
			}
			if (field.blockType === "embed") {
				return (
					<div contentEditable suppressContentEditableWarning aria-labelledby={chrome.labelledBy}>
						Text{" "}
						<span contentEditable={false}>
							<button type="button">Embedded</button>
						</span>
					</div>
				);
			}
			return (
				<SlowMount>
					<input
						id={`field-${name}`}
						aria-labelledby={chrome.labelledBy}
						className="h-8 w-full"
						value={typeof fieldValue === "string" ? fieldValue : ""}
						onChange={(event) => onChange(event.target.value)}
					/>
				</SlowMount>
			);
		},
	};
	return <BlocksField {...props} />;
}

/**
 * The field with room beside it for its gutter, in a scroller with the editor canvas's scroll
 * padding, and `before` and `after` it the room it scrolls through.
 */
function renderField(
	initial: StoredBlockValue[],
	{ height, before = 0, after = 0 }: { height?: number; before?: number; after?: number } = {},
) {
	return render(
		<div
			data-testid="scroller"
			style={height ? { height, overflowY: "auto", scrollPaddingTop: 52 } : undefined}
		>
			<div style={{ height: before }} />
			<div style={{ width: 480, marginInline: 80 }}>
				<Harness initial={initial} />
			</div>
			<div style={{ height: after }} />
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
const headOf = (key: string) => row(key).querySelector<HTMLElement>("[data-block-head]")!;
const toggleOf = (key: string) => row(key).querySelector<HTMLElement>("[data-block-toggle]")!;
const menuButtonOf = (key: string) =>
	page.elementLocator(row(key)).getByRole("button", { name: /actions$/ });
const field = () => document.querySelector<HTMLElement>("[data-blocks-field]")!;
const fieldTop = () => field().getBoundingClientRect().top;
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const running = () => document.getAnimations().filter((a) => a.playState === "running");
const settled = () => expect.poll(() => running().length).toBe(0);
const announced = () =>
	Array.from(
		document.querySelectorAll('[data-blocks-field] [aria-live="polite"]'),
		(region) => region.textContent,
	).join(" ");
const undoButtons = () => page.getByRole("button", { name: "Undo" }).all();
const canvas = () => page.getByTestId("canvas").element() as HTMLElement;
const toastOf = () =>
	document.querySelector<HTMLElement>('[role="region"][aria-live] > [role="dialog"]');
const inView = (element: Element) => {
	const { top, bottom } = element.getBoundingClientRect();
	return top >= 0 && bottom <= innerHeight;
};

/** Presses Mod+Z at once, from wherever focus is, as a key event the page sees. */
function pressUndo(init: KeyboardEventInit = {}) {
	(document.activeElement ?? document.body).dispatchEvent(
		new KeyboardEvent("keydown", {
			key: "z",
			code: "KeyZ",
			bubbles: true,
			cancelable: true,
			...(MOD === "Meta" ? { metaKey: true } : { ctrlKey: true }),
			...init,
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

async function reduceMotion() {
	await cdp().send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
}

/**
 * Calls `read` on every frame until `done`, or for at most 300 frames, and returns what it read
 * with the time of each frame.
 */
async function sample<T>(
	read: () => T,
	done: () => boolean,
): Promise<Array<{ t: number; value: T }>> {
	const frames: Array<{ t: number; value: T }> = [];
	const start = performance.now();
	await new Promise<void>((resolve) => {
		const tick = (now: number) => {
			frames.push({ t: now - start, value: read() });
			if (done() || frames.length >= 300) resolve();
			else requestAnimationFrame(tick);
		};
		requestAnimationFrame(tick);
	});
	return frames;
}

/** Whether `target` is in the blocks field, where everything that moves its rows is. */
const inField = (target: Element) => field().contains(target);

/** Deletes the block `key` from its menu, and holds its row halfway through shrinking away. */
async function deleteHalfway(key: string) {
	const shrinkingRow = row(key);
	const shrink = holdAnimations((target) => target === shrinkingRow);
	await menuButtonOf(key).click();
	await page.getByRole("menuitem", { name: "Delete" }).click();
	const [height] = readAlong(
		await shrink.started(),
		() => shrinkingRow.getBoundingClientRect().height,
		[0.5],
	);
	return { shrink, height: height! };
}

/**
 * Reverses a block's panel a share of the way through opening, with its caret's own transition as
 * far along, and returns the panel's closing motion, read at a time into it.
 */
async function closeWhileOpening(key: string, share: number) {
	const caret = () => toggleOf(key).querySelector("svg")!;
	const angle = () => Math.abs(Number.parseFloat(getComputedStyle(caret()).rotate) || 0);
	const body = () => row(key).querySelector<HTMLElement>("[data-block-body]");
	const motion = holdAnimations((target) => row(key).contains(target));

	// A caret styled for the first time as it opens has nothing to turn from.
	await frame();
	toggleOf(key).click();
	const [opening] = await motion.started();
	const reverseAt = Number(opening!.effect!.getComputedTiming().endTime) * share;
	opening!.currentTime = reverseAt;
	for (const turn of caret().getAnimations()) {
		turn.pause();
		turn.currentTime = reverseAt;
	}
	const full = body()!.firstElementChild!.getBoundingClientRect().height;
	toggleOf(key).click();
	const closing = await motion.started();
	return {
		full,
		motion,
		duration: Math.max(...closing.map((each) => Number(each.effect!.getComputedTiming().endTime))),
		at(time: number) {
			for (const animation of closing) animation.currentTime = time;
			return { angle: angle(), height: body()?.getBoundingClientRect().height ?? 0 };
		},
	};
}

afterEach(async () => {
	slowMount.ms = 0;
	saved.length = 0;
	vi.useRealTimers();
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
	await page.viewport(1280, 800);
});

describe("One Undo for the page", () => {
	it("puts nothing back with Mod+Z once the Undo toast has gone", async () => {
		vi.useFakeTimers({ shouldAdvanceTime: true });
		await renderField([short("one"), short("two")]);
		await deleteFromMenu("one");
		await expect.element(page.getByText("Deleted Short")).toBeVisible();

		await vi.advanceTimersByTimeAsync(16_000);
		await expect.element(page.getByText("Deleted Short")).not.toBeInTheDocument();
		toggleOf("two").focus();
		await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
		await frame();
		expect(rowKeys()).toEqual(["two"]);
	});

	it("undoes only the latest deletion across two blocks fields", async () => {
		await render(
			<div style={{ display: "grid", gap: 16, width: 480, marginInline: 80 }}>
				<Harness id="first" label="First" initial={[short("a1"), short("a2")]} />
				<Harness id="second" label="Second" initial={[short("b1"), short("b2")]} />
			</div>,
			{ wrapper: Toasty },
		);
		await deleteFromMenu("a1");
		await expect.poll(rowKeys).toEqual(["a2", "b1", "b2"]);
		await deleteFromMenu("b1");
		await expect.poll(rowKeys).toEqual(["a2", "b2"]);
		await expect.poll(undoButtons).toHaveLength(1);

		toggleOf("b2").focus();
		await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
		await expect.poll(rowKeys).toEqual(["a2", "b1", "b2"]);
		await expect.element(page.getByText("Deleted Short")).not.toBeInTheDocument();
	});

	it("calls off the deletion whose row is shrinking away, rather than undoing an older one", async () => {
		await renderField([short("one"), short("two"), short("three")]);
		await deleteFromMenu("one");
		await expect.poll(rowKeys).toEqual(["two", "three"]);
		await settled();
		const full = row("two").getBoundingClientRect().height;

		const height = () => row("two").getBoundingClientRect().height;
		const { shrink, height: shrunk } = await deleteHalfway("two");
		expect(shrunk).toBeLessThan(full - 1);
		shrink.release();
		pressUndo();
		const [back] = shrink.held;
		back!.pause();
		// Seeking settles a reversal still pending, so the rate reads the way the row now goes.
		back!.currentTime = Number(back!.currentTime);
		const now = Number(back!.currentTime);
		const ahead = [0.25, 0.5, 0.75].map((share) => {
			back!.currentTime = now + back!.playbackRate * now * share;
			return height();
		});
		back!.play();
		await settled();

		expect(rowKeys()).toEqual(["two", "three"]);
		// From where Undo caught it, the row only grows, back to its full height.
		expectGlide(ahead, shrunk, full);
		expect(height()).toBeCloseTo(full, 0);
		await expect.element(page.elementLocator(toggleOf("two"))).toHaveFocus();
		await expect.poll(undoButtons).toHaveLength(0);
	});

	it("takes the Z key's place for Mod+Z on a layout without a Latin Z", async () => {
		await renderField([short("one"), short("two")]);
		await deleteFromMenu("one");
		await expect.element(page.getByText("Deleted Short")).toBeVisible();

		toggleOf("two").focus();
		pressUndo({ key: "я" });
		await expect.poll(rowKeys).toEqual(["one", "two"]);
	});

	it("leaves Mod+Z to rich text when focus is on a control inside it", async () => {
		await renderField([short("one"), { _type: "embed", _version: 1, _key: "embed" }]);
		await deleteFromMenu("one");
		await expect.element(page.getByText("Deleted Short")).toBeVisible();
		await page.getByRole("button", { name: "Embed", exact: true }).click();

		await page.getByRole("button", { name: "Embedded" }).click();
		await userEvent.keyboard(`{${MOD}>}z{/${MOD}}`);
		await frame();
		expect(rowKeys()).toEqual(["embed"]);
	});
});

describe("Undo puts a block back", () => {
	it("where it was, growing in place without scrolling the page under it", async () => {
		await renderInCanvas([short("one"), tall("big"), short("three")]);
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
		const { shrink } = await deleteHalfway("two");

		shrink.release();
		pressUndo();
		await settled();
		expect(rowKeys()).toEqual(["one", "two", "three"]);
		await expect.element(page.elementLocator(toggleOf("two"))).toHaveFocus();
	});

	it("when Mod+Z comes once the row has shrunk away but before it's taken out", async () => {
		await renderField([short("one"), short("two"), short("three")]);
		const { shrink } = await deleteHalfway("two");

		shrink.release();
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

describe("A deletion that can't happen", () => {
	it("leaves a value replaced while the deleted row shrinks away as it is", async () => {
		await renderField([short("one"), short("two"), short("three")]);

		const { shrink } = await deleteHalfway("two");
		shrink.release();
		setters.get("layout")!.value([short("x"), short("y")]);
		// The page no longer lists the motion of a row taken out of it, which still runs its course.
		await new Promise((resolve) => setTimeout(resolve, 400));

		expect(rowKeys()).toEqual(["x", "y"]);
	});

	it("keeps the block when the field turns read-only while it shrinks away", async () => {
		await renderField([short("one"), short("two"), short("three")]);

		const { shrink } = await deleteHalfway("two");
		shrink.release();
		setters.get("layout")!.readOnly(true);
		await settled();

		expect(rowKeys()).toEqual(["one", "two", "three"]);
		expect(row("two").getBoundingClientRect().height).toBeGreaterThan(30);
	});
});

describe("Structure motion", () => {
	it("grows a deleted block back in when Undo puts it back", async () => {
		await renderField([short("one"), short("two"), short("three")]);
		await deleteFromMenu("two");
		await expect.poll(rowKeys).toEqual(["one", "three"]);
		await settled();

		const { from, along, to } = await readMotion(
			inField,
			() => toggleOf("three").getBoundingClientRect().top - fieldTop(),
			() => page.getByRole("button", { name: "Undo" }).click(),
		);

		expect(rowKeys()).toEqual(["one", "two", "three"]);
		expect(to - from).toBeGreaterThan(30);
		expectGlide(along, from, to);
	});

	it("grows a deleted item back in when Undo puts it back", async () => {
		await renderField([quotes()]);
		await page.getByRole("button", { name: "Testimonials", exact: true }).click();
		await settled();
		const ines = () =>
			page.getByRole("button", { name: "Ines Duarte", exact: true }).element() as HTMLElement;
		await page.getByRole("button", { name: "Jonas Berg actions" }).click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await expect.element(page.getByText("Deleted Jonas Berg")).toBeVisible();
		await settled();

		const { from, along, to } = await readMotion(
			inField,
			() => ines().getBoundingClientRect().top - fieldTop(),
			() => page.getByRole("button", { name: "Undo" }).click(),
		);

		expect(to - from).toBeGreaterThan(20);
		expectGlide(along, from, to);
	});

	it("starts an open duplicate from nothing even when its fields take long to mount", async () => {
		await renderField([short("open"), short("after")]);
		toggleOf("open").click();
		await settled();

		await menuButtonOf("open").click();
		const copyKey = () => rowKeys().find((key) => key !== "open" && key !== "after");
		const copyHeight = () => {
			const copy = copyKey();
			return copy ? row(copy).getBoundingClientRect().height : null;
		};
		const duplicate = page.getByRole("menuitem", { name: "Duplicate" }).element() as HTMLElement;
		/** The copy's height on the first frame it shows in. */
		const firstShown = new Promise<number>((resolve) => {
			const tick = () => {
				const height = copyHeight();
				if (height === null) requestAnimationFrame(tick);
				else resolve(height);
			};
			requestAnimationFrame(tick);
		});
		slowMount.ms = 80;
		// The menu commits its choice in a frame callback, where a long mount delays that frame.
		requestAnimationFrame(() => duplicate.click());
		const first = await firstShown;
		const grow = row(copyKey()!)
			.getAnimations()
			.find(
				(animation) =>
					animation.effect instanceof KeyframeEffect &&
					animation.effect.getKeyframes().some((keyframe) => "height" in keyframe),
			)!;
		// A zero rate holds the grow wherever it's sought, even once the row plays it.
		grow.playbackRate = 0;
		const heights = readAlong([grow], () => copyHeight()!);
		grow.playbackRate = 1;
		await grow.finished;
		await settled();
		const final = copyHeight()!;

		expect(final).toBeGreaterThan(100);
		expect(first).toBeLessThanOrEqual(final * 0.45);
		expectGlide(heights, first, final);
	});

	it("takes a reversed block a moment to close, with its caret on the same clock", async () => {
		await renderField([long("big")]);

		// A fifth of the way open.
		const closing = await closeWhileOpening("big", 0.08);
		const reversed = closing.at(0);
		expect(reversed.height).toBeGreaterThan(closing.full * 0.15);
		expect(reversed.angle).toBeGreaterThan(5);

		expect(closing.at(90).height).toBeGreaterThan(0.5);
		// On one clock, the caret has as much of its turn left as the fields have of their height.
		for (const share of [0.25, 0.5, 0.75]) {
			const { angle, height } = closing.at(closing.duration * share);
			expect(angle / reversed.angle).toBeCloseTo(height / reversed.height, 1);
		}
		const landed = closing.at(closing.duration);
		expect(landed.angle).toBeLessThan(0.5);
		expect(landed.height).toBeLessThan(0.5);
		closing.motion.release();
		await settled();
	});

	it("eases the rows below when a photo is removed, and names the field in its Undo", async () => {
		await renderField([
			{ _type: "card", _version: 1, _key: "card", headline: "Hi", photo: PHOTO, caption: "Under" },
		]);
		await page.getByRole("button", { name: "Card", exact: true }).click();
		await settled();
		const under = () => document.getElementById("field-layout.card.caption")!;

		const { from, along, to } = await readMotion(
			inField,
			() => under().getBoundingClientRect().top - fieldTop(),
			() => page.getByRole("button", { name: "Remove image" }).click(),
		);

		expect(to - from).toBeLessThan(-30);
		expectGlide(along, from, to);
		await expect.element(page.getByText("Removed Background image")).toBeVisible();
	});

	it("leaves the rows above in place when the last block is deleted at the end of the page", async () => {
		await renderField([short("one"), short("two"), short("three"), short("four")], {
			height: 200,
		});
		const scroller = page.getByTestId("scroller").element() as HTMLElement;
		scroller.scrollTop = scroller.scrollHeight;
		await frame();

		await menuButtonOf("four").click();
		const tops = sample(
			() => toggleOf("three").getBoundingClientRect().top,
			() => !rowKeys().includes("four") && running().length === 0,
		);
		await page.getByRole("menuitem", { name: "Delete" }).click();
		const values = (await tops).map((each) => each.value);

		expect(rowKeys()).toEqual(["one", "two", "three"]);
		expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
	});
});

describe("Dragging", () => {
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

	it("lifts a row's shadow again when it's picked up while it settles", async () => {
		await renderField([short("one"), short("two"), short("three")]);
		const handle = () => row("one").querySelector<HTMLElement>('[aria-label^="Reorder"]')!;
		const shadow = () => Number(getComputedStyle(row("one"), "::after").opacity);
		const start = row("one").getBoundingClientRect();
		const x = start.left + 4;
		const y = start.top + start.height / 2;
		const end = row("three").getBoundingClientRect().bottom - 4;
		handle().dispatchEvent(pointer("pointerdown", x, y));
		for (let step = 1; step <= 12; step++) {
			document.dispatchEvent(pointer("pointermove", x, y + ((end - y) * step) / 12));
			await frame();
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		document.dispatchEvent(pointer("pointerup", x, end));
		await frame();

		handle().dispatchEvent(pointer("pointerdown", x, end));
		const values: number[] = [];
		for (let step = 1; step <= 16; step++) {
			document.dispatchEvent(pointer("pointermove", x, end - step * 4));
			await frame();
			values.push(shadow());
		}
		document.dispatchEvent(pointer("pointerup", x, end - 64));

		// The row is picked up again once the pointer has moved 8px, on the second move.
		const held = values.slice(1);
		expect(held.at(-1)).toBeGreaterThan(0.98);
		const falling = held.slice(1).filter((value, index) => value < held[index]! - 0.01);
		expect(falling).toHaveLength(0);
	});
});

describe("Easing", () => {
	it("moves and fades everything on the system's two curves", async () => {
		await renderField([
			{ _type: "card", _version: 1, _key: "card", headline: "Hi", photo: PHOTO },
			{ _type: "linked", _version: 1, _key: "linked" },
		]);
		const curves = new Set<string>();
		const collect = () => {
			for (const element of document.querySelectorAll(
				"[data-blocks-field], [data-blocks-field] *",
			)) {
				for (const pseudo of [null, "::after"]) {
					const style = getComputedStyle(element, pseudo);
					const durations = style.transitionDuration.split(", ").map(Number.parseFloat);
					const easings = style.transitionTimingFunction.split(/,\s*(?![^(]*\))/);
					durations.forEach((duration, index) => {
						if (duration > 0) curves.add(easings[index % easings.length]!);
					});
				}
			}
			for (const animation of document.getAnimations()) {
				if (animation.effect instanceof KeyframeEffect && !(animation instanceof CSSTransition)) {
					curves.add(animation.effect.getTiming().easing ?? "linear");
				}
			}
		};

		await page.getByRole("button", { name: "Expand all" }).click();
		await page.getByRole("button", { name: "Remove image" }).hover();
		collect();
		document.getElementById("field-layout.linked.link")!.focus();
		await frame();
		collect();
		await menuButtonOf("linked").click();
		await page.getByRole("menuitem", { name: "Duplicate" }).click();
		for (let count = 0; count < 4; count++) {
			collect();
			await frame();
		}

		const allowed = new Set([
			"cubic-bezier(0.22, 1, 0.36, 1)",
			"cubic-bezier(0.33, 1, 0.68, 1)",
			"linear",
		]);
		expect([...curves].filter((curve) => !allowed.has(curve))).toEqual([]);
	});
});

describe("Moving with the keyboard", () => {
	it("keeps an open block's head where it was on screen as it moves down past another", async () => {
		await renderField([long("first"), long("second"), short("third")], {
			height: 400,
			before: 100,
			after: 600,
		});
		await page.getByRole("button", { name: "Expand all" }).click();
		const toggle = toggleOf("first");
		toggle.focus();
		const before = toggle.getBoundingClientRect().top;

		await userEvent.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}");

		expect(rowKeys()).toEqual(["second", "first", "third"]);
		await expect.element(page.elementLocator(toggle)).toHaveFocus();
		expect(Math.abs(toggle.getBoundingClientRect().top - before)).toBeLessThanOrEqual(1);
	});

	it("says so when a block or an item is already at the end it's moved toward", async () => {
		await renderField([short("one"), quotes()]);
		toggleOf("one").focus();
		await userEvent.keyboard("{Alt>}{Shift>}{ArrowUp}{/Shift}{/Alt}");
		await expect.poll(announced).toContain("Short is already first");

		await page.getByRole("button", { name: "Testimonials", exact: true }).click();
		page.getByRole("button", { name: "Ines Duarte", exact: true }).element().focus();
		await userEvent.keyboard("{Alt>}{Shift>}{ArrowDown}{/Shift}{/Alt}");
		await expect.poll(announced).toContain("Ines Duarte is already last");
	});
});

describe("Tables", () => {
	const cell = (name: string) => page.getByRole("textbox", { name, exact: true });

	it("moves Enter down a column, adding a row under the last, and the arrow keys up and down it", async () => {
		await renderField([
			{
				_type: "stats",
				_version: 1,
				_key: "stats",
				stats: [
					{ value: "23%", label: "Lower spend" },
					{ value: "4x", label: "Faster" },
				],
			},
		]);
		await page.getByRole("button", { name: "Stats", exact: true }).click();

		await cell("Label 1").click();
		await userEvent.keyboard("{Enter}");
		await expect.element(cell("Label 2")).toHaveFocus();
		await userEvent.keyboard("{Enter}");
		await expect.element(cell("Label 3")).toHaveFocus();
		expect(page.getByRole("table").getByRole("row").all()).toHaveLength(4);

		await userEvent.keyboard("{ArrowUp}");
		await expect.element(cell("Label 2")).toHaveFocus();
		await cell("Value 1").click();
		await userEvent.keyboard("{ArrowDown}");
		await expect.element(cell("Value 2")).toHaveFocus();
	});
});

describe("An item's menu", () => {
	it("adds an item above or below it, in the block menu's order", async () => {
		await renderField([quotes()]);
		await page.getByRole("button", { name: "Testimonials", exact: true }).click();

		await page.getByRole("button", { name: "Jonas Berg actions" }).click();
		const items = page.getByRole("menu").getByRole("menuitem").all();
		expect(items.map((item) => item.element().textContent)).toEqual([
			"Add item above",
			"Add item below",
			"Duplicate",
			"Move up",
			"Move down",
			"Move to top",
			"Move to bottom",
			"Delete",
		]);

		await page.getByRole("menuitem", { name: "Add item above" }).click();
		const titles = () =>
			Array.from(
				document.querySelectorAll<HTMLElement>("[data-item-key]"),
				(item) => item.querySelector('[id$="-name"]')?.textContent,
			);
		await expect.poll(() => titles().length).toBe(4);
		expect(titles()[0]).toBe("Maya Okafor");
		expect(titles()[2]).toBe("Jonas Berg");
		const added = document.querySelectorAll<HTMLElement>("[data-item-key]")[1]!;
		await expect.poll(() => added.contains(document.activeElement)).toBe(true);
		expect(document.activeElement).toBeInstanceOf(HTMLInputElement);
	});
});

describe("The Undo toast", () => {
	it("fades in place of sliding when reduced motion is preferred", async () => {
		await reduceMotion();
		await renderField([short("one"), short("two")]);
		await deleteFromMenu("one");
		const toast = page.getByRole("dialog").element() as HTMLElement;

		const slides = toast
			.getAnimations()
			.filter((a) => a instanceof CSSTransition && a.transitionProperty === "transform");
		expect(slides).toHaveLength(0);
	});

	it("fades in and out in place of sliding under reduced motion, whatever its region is called", async () => {
		await reduceMotion();
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

	it("fades out where it rests under reduced motion instead of dropping first", async () => {
		await reduceMotion();
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

describe("Keeping focus clear of a toast", () => {
	it("keeps focus brought into view in the editor clear of the toast while it covers the field", async () => {
		await render(
			<div
				data-testid="scroller"
				data-emdash-editor-canvas=""
				style={{ position: "fixed", inset: 0, overflowY: "auto" }}
			>
				<div style={{ marginInline: 80, paddingBlock: 40 }}>
					<Harness initial={Array.from({ length: 30 }, (_, index) => short(`block-${index}`))} />
				</div>
			</div>,
			{ wrapper: Toasty },
		);
		await deleteFromMenu("block-0");
		await expect.element(page.getByText("Deleted Short")).toBeVisible();
		await settled();
		const toast = page.getByRole("dialog").element() as HTMLElement;
		const toastTop = toast.getBoundingClientRect().top;
		const below = [...document.querySelectorAll<HTMLElement>("[data-block-toggle]")].find(
			(toggle) => {
				const box = toggle.getBoundingClientRect();
				return box.top > toastTop - 20 && box.bottom < innerHeight;
			},
		)!;

		below.focus();
		await frame();
		expect(below.getBoundingClientRect().bottom).toBeLessThanOrEqual(toastTop);
	});

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
