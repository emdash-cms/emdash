import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import { useQuietReturnFocus } from "../../src/components/useQuietReturnFocus.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { render } from "../utils/render.js";

const LINK_PATTERN = "^(?:$|(?:https?://|mailto:|tel:|/(?!/)|#).+)$";

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

const SHORT = blockType("short", "Short", [{ slug: "title", label: "Title", type: "string" }]);

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

const LINKED = blockType("linked", "Linked", [
	{ slug: "title", label: "Title", type: "string" },
	{
		slug: "cta_url",
		label: "Link (starts with /, https://, mailto:, tel: or #)",
		type: "string",
		validation: { pattern: LINK_PATTERN },
	},
]);

const TYPES = [SHORT, STATS, LINKED];

const short = (key: string): StoredBlockValue => ({
	_type: "short",
	_version: 1,
	_key: key,
	title: key,
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
const linked = (): StoredBlockValue => ({
	_type: "linked",
	_version: 1,
	_key: "linked",
	title: "Contact",
});

/** Every value the field saved, latest last. */
const saved: StoredBlockValue[][] = [];
const savedTwoStats = (value: StoredBlockValue[]) =>
	Array.isArray(value[0]?.stats) && value[0].stats.length === 2;

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
		<div style={{ width, marginInline: 80 }}>
			<Harness initial={initial} />
		</div>,
		{ wrapper: Toasty },
	);
}

const row = (key: string) => document.querySelector<HTMLElement>(`[data-block-key="${key}"]`)!;
const toggleOf = (key: string) => row(key).querySelector<HTMLElement>("[data-block-toggle]")!;
const menuButtonOf = (key: string) =>
	page.elementLocator(row(key)).getByRole("button", { name: /actions$/ });
const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
const running = () => document.getAnimations().filter((a) => a.playState === "running");
const settled = () => expect.poll(() => running().length).toBe(0);
const toastOf = () =>
	document.querySelector<HTMLElement>('[role="region"][aria-live] > [role="dialog"]');

async function reduceMotion() {
	await cdp().send("Emulation.setEmulatedMedia", {
		features: [{ name: "prefers-reduced-motion", value: "reduce" }],
	});
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

/** How far `values` travel from first to last, and the largest move between two frames. */
function motion(values: number[]) {
	const travel = Math.abs(values.at(-1)! - values[0]!);
	const steps = values.slice(1).map((value, index) => Math.abs(value - values[index]!));
	return { travel, maxStep: Math.max(0, ...steps) };
}

afterEach(async () => {
	saved.length = 0;
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

describe("A table row Enter added, going once focus leaves it blank", () => {
	const dataRows = () =>
		page.getByRole("table").element().querySelectorAll("[data-list-item]").length;

	async function addBlankRow() {
		await renderField([stats(), short("after")]);
		await page.getByRole("button", { name: "Stats", exact: true }).click();
		await settled();
		await page.getByRole("textbox", { name: "Label 2", exact: true }).click();
		await userEvent.keyboard("{Enter}");
		await expect.element(page.getByRole("textbox", { name: "Label 3", exact: true })).toHaveFocus();
		await settled();
	}

	it("shrinks away, so the rows below glide up after the click lands", async () => {
		await addBlankRow();
		const head = toggleOf("after");

		const sampling = sampleFrames(() => head.getBoundingClientRect().top, 700);
		await clickNearBottom(head);
		const tops = await sampling;
		await settled();

		expect(dataRows()).toBe(2);
		expect(head.getAttribute("aria-expanded")).toBe("true");
		const { travel, maxStep } = motion(tops);
		expect(tops[0]! - tops.at(-1)!).toBeGreaterThan(15);
		expect(maxStep).toBeLessThan(travel * 0.4);
		expect(saved.every(savedTwoStats)).toBe(true);
	});

	it("comes back when focus returns to it while it shrinks away", async () => {
		await addBlankRow();
		const label3 = page.getByRole("textbox", { name: "Label 3", exact: true });
		const blankRow = label3.element().closest<HTMLElement>("[data-list-item]")!;
		const full = blankRow.getBoundingClientRect().height;

		toggleOf("after").focus();
		await until(() => blankRow.getAnimations().some((a) => a.playState === "running"));
		await frame();
		(label3.element() as HTMLElement).focus();
		await settled();

		expect(dataRows()).toBe(3);
		expect(blankRow.isConnected).toBe(true);
		expect(blankRow.getBoundingClientRect().height).toBeCloseTo(full, 0);
		await expect.element(label3).toHaveFocus();
		expect(saved.every(savedTwoStats)).toBe(true);
	});

	it("goes at once under reduced motion", async () => {
		await reduceMotion();
		await addBlankRow();
		const head = toggleOf("after");

		const sampling = sampleFrames(() => head.getBoundingClientRect().top, 300);
		head.focus();
		const tops = await sampling;

		expect(dataRows()).toBe(2);
		expect(new Set(tops).size).toBe(2);
	});
});

describe("A long problem that wraps its narrow field's label line", () => {
	const link = () => page.getByRole("textbox", { name: "Link", exact: true });
	const label = () => document.getElementById("field-layout.linked.cta_url-label")!;

	async function openLinked() {
		await renderField([linked(), short("after")], { width: 300 });
		await page.getByRole("button", { name: "Linked", exact: true }).click();
		await settled();
		await link().fill("contact us");
	}

	it("moves the rows below smoothly as it comes", async () => {
		await openLinked();
		const oneLine = label().getBoundingClientRect().height;
		const head = toggleOf("after");

		const sampling = sampleFrames(() => head.getBoundingClientRect().top, 500);
		await page.getByRole("textbox", { name: "Title", exact: true }).click();
		const tops = await sampling;
		await settled();

		expect(label().getBoundingClientRect().height).toBeGreaterThan(oneLine + 8);
		const { travel, maxStep } = motion(tops);
		expect(tops.at(-1)! - tops[0]!).toBeGreaterThan(8);
		expect(maxStep).toBeLessThan(travel * 0.4);
	});

	it("moves the rows below smoothly as it goes", async () => {
		await openLinked();
		await page.getByRole("textbox", { name: "Title", exact: true }).click();
		await settled();
		const twoLines = label().getBoundingClientRect().height;
		const head = toggleOf("after");

		const sampling = sampleFrames(() => head.getBoundingClientRect().top, 600);
		await link().fill("/contact");
		await page.getByRole("textbox", { name: "Title", exact: true }).click();
		const tops = await sampling;
		await settled();

		expect(label().getBoundingClientRect().height).toBeLessThan(twoLines - 8);
		const { travel, maxStep } = motion(tops);
		expect(tops[0]! - tops.at(-1)!).toBeGreaterThan(8);
		expect(maxStep).toBeLessThan(travel * 0.4);
	});

	it("comes at once under reduced motion", async () => {
		await reduceMotion();
		await openLinked();
		const oneLine = label().getBoundingClientRect().height;

		(page.getByRole("textbox", { name: "Title", exact: true }).element() as HTMLElement).focus();
		await expect.poll(() => label().getBoundingClientRect().height).toBeGreaterThan(oneLine + 8);

		expect(running()).toEqual([]);
	});

	it("moves nothing as focus comes back to its control", async () => {
		await openLinked();
		await page.getByRole("textbox", { name: "Title", exact: true }).click();
		await settled();
		const head = toggleOf("after");

		const sampling = sampleFrames(() => head.getBoundingClientRect().top, 300);
		(link().element() as HTMLElement).focus();
		const tops = await sampling;

		expect(new Set(tops).size).toBe(1);
	});
});

describe("Focus coming back to an opener from a toast", () => {
	/** An opener whose popup didn't open, as a picker that fails to load. */
	function Opener() {
		const quiet = useQuietReturnFocus();
		return (
			<button type="button" {...quiet.groupProps} onClick={quiet.markOpener}>
				Choose
			</button>
		);
	}

	it("counts as focus from anywhere else, so the opener's controls show", async () => {
		await render(
			<>
				<div style={{ width: 480, marginInline: 80 }}>
					<Harness initial={[short("one"), short("two")]} />
				</div>
				<Opener />
			</>,
			{ wrapper: Toasty },
		);
		await menuButtonOf("one").click();
		await page.getByRole("menuitem", { name: "Delete" }).click();
		await until(() => toastOf() !== null);
		await settled();
		const opener = page.getByRole("button", { name: "Choose", exact: true });
		await opener.click();

		toastOf()!.querySelector<HTMLElement>("button")!.focus();
		(opener.element() as HTMLElement).focus();
		await frame();

		await expect.element(opener).toHaveFocus();
		expect(opener.element().closest("[data-quiet-focus]")).toBeNull();
	});
});
