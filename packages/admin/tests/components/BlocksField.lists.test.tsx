import { Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { expectGlide, holdAnimations, readAlong, readMotion } from "../utils/animation.js";
import { render } from "../utils/render.js";

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

const POINTS = blockType("points", "Points", [
	{
		slug: "points",
		label: "Points",
		type: "repeater",
		validation: { subFields: [{ slug: "text", label: "Point", type: "string" }] },
	},
]);

const TYPES = [SHORT, STATS, METRICS, POINTS];

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
const metrics = (): StoredBlockValue => ({
	_type: "metrics",
	_version: 1,
	_key: "metrics",
	metrics: [
		{ count: 12, label: "Sites" },
		{ count: 4, label: "Regions" },
	],
});
const points = (): StoredBlockValue => ({
	_type: "points",
	_version: 1,
	_key: "points",
	points: [{ text: "Fast" }, { text: "Cheap" }],
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
		renderField: ({ name, field, value: fieldValue, onChange, chrome }) => (
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

function renderField(initial: StoredBlockValue[]) {
	return render(
		<div style={{ width: 480, marginInline: 80 }}>
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

const itemOf = (control: Element) => control.closest<HTMLElement>("[data-list-item]")!;

afterEach(async () => {
	saved.length = 0;
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

describe("A table's blank row", () => {
	const cell = (name: string) => page.getByRole("textbox", { name, exact: true });
	const dataRows = () =>
		page.getByRole("table").element().querySelectorAll("[data-list-item]").length;
	const savedStats = () => {
		const latest = saved.at(-1)?.[0];
		return Array.isArray(latest?.stats) ? latest.stats.length : undefined;
	};
	const savedTwoStats = (value: StoredBlockValue[]) =>
		Array.isArray(value[0]?.stats) && value[0].stats.length === 2;

	async function addBlankRow() {
		await renderField([stats(), short("after")]);
		await page.getByRole("button", { name: "Stats", exact: true }).click();
		await settled();
		await cell("Label 2").click();
		await userEvent.keyboard("{Enter}");
		await expect.element(cell("Label 3")).toHaveFocus();
		await settled();
	}

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
		await cell("Label 2").click();
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
		await cell("Label 2").click();
		await userEvent.keyboard("{Enter}");
		await expect.element(cell("Label 3")).toHaveFocus();
		expect(dataRows()).toBe(3);

		toastOf()!.querySelector<HTMLElement>("button")!.focus();
		await expect.poll(dataRows).toBe(2);
	});

	it("shrinks away once focus leaves it, so the rows below glide up after the click lands", async () => {
		await addBlankRow();
		const head = toggleOf("after");
		const blankRow = itemOf(cell("Label 3").element());

		const { from, along, to } = await readMotion(
			(target) => target === blankRow,
			() => head.getBoundingClientRect().top,
			() => clickNearBottom(head),
		);

		expect(dataRows()).toBe(2);
		expect(head.getAttribute("aria-expanded")).toBe("true");
		expect(from - to).toBeGreaterThan(15);
		expectGlide(along, from, to);
		expect(saved.every(savedTwoStats)).toBe(true);
	});

	it("comes back when focus returns to it while it shrinks away", async () => {
		await addBlankRow();
		const label3 = cell("Label 3");
		const blankRow = itemOf(label3.element());
		const full = blankRow.getBoundingClientRect().height;

		const shrink = holdAnimations((target) => target === blankRow);
		toggleOf("after").focus();
		const [midway] = readAlong(
			await shrink.started(),
			() => blankRow.getBoundingClientRect().height,
			[0.5],
		);
		expect(midway).toBeGreaterThan(0.5);
		expect(midway).toBeLessThan(full - 0.5);
		shrink.release();
		(label3.element() as HTMLElement).focus();
		await settled();

		expect(dataRows()).toBe(3);
		expect(blankRow.isConnected).toBe(true);
		expect(blankRow.getBoundingClientRect().height).toBeCloseTo(full, 0);
		await expect.element(label3).toHaveFocus();
		expect(saved.every(savedTwoStats)).toBe(true);
	});

	it("goes at once under reduced motion once focus leaves it", async () => {
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

describe("A blank line, going once focus leaves its list", () => {
	const lines = () =>
		page
			.getByRole("list", { name: "Points", exact: true })
			.element()
			.querySelectorAll("[data-list-item]").length;
	const savedTwoPoints = (value: StoredBlockValue[]) =>
		Array.isArray(value[0]?.points) && value[0].points.length === 2;

	async function addBlankLine() {
		await renderField([points(), short("after")]);
		await page.getByRole("button", { name: "Points", exact: true }).click();
		await settled();
		await page.getByRole("textbox", { name: "Point 2", exact: true }).click();
		await userEvent.keyboard("{Enter}");
		await expect.element(page.getByRole("textbox", { name: "Point 3", exact: true })).toHaveFocus();
		await settled();
	}

	it("shrinks away, so the rows below glide up after the click lands", async () => {
		await addBlankLine();
		const head = toggleOf("after");
		const blankLine = itemOf(page.getByRole("textbox", { name: "Point 3", exact: true }).element());

		const { from, along, to } = await readMotion(
			(target) => target === blankLine,
			() => head.getBoundingClientRect().top,
			() => clickNearBottom(head),
		);

		expect(lines()).toBe(2);
		expect(head.getAttribute("aria-expanded")).toBe("true");
		expect(from - to).toBeGreaterThan(15);
		expectGlide(along, from, to);
		expect(saved.every(savedTwoPoints)).toBe(true);
	});

	it("comes back when focus returns to its list while it shrinks away", async () => {
		await addBlankLine();
		const point3 = page.getByRole("textbox", { name: "Point 3", exact: true });
		const blankLine = itemOf(point3.element());
		const full = blankLine.getBoundingClientRect().height;

		const shrink = holdAnimations((target) => target === blankLine);
		toggleOf("after").focus();
		const [midway] = readAlong(
			await shrink.started(),
			() => blankLine.getBoundingClientRect().height,
			[0.5],
		);
		expect(midway).toBeGreaterThan(0.5);
		expect(midway).toBeLessThan(full - 0.5);
		shrink.release();
		(page.getByRole("textbox", { name: "Point 1", exact: true }).element() as HTMLElement).focus();
		await settled();

		expect(lines()).toBe(3);
		expect(blankLine.isConnected).toBe(true);
		expect(blankLine.getBoundingClientRect().height).toBeCloseTo(full, 0);
		expect(saved.every(savedTwoPoints)).toBe(true);
	});

	it("goes at once under reduced motion", async () => {
		await reduceMotion();
		await addBlankLine();
		const head = toggleOf("after");

		const sampling = sampleFrames(() => head.getBoundingClientRect().top, 300);
		head.focus();
		const tops = await sampling;

		expect(lines()).toBe(2);
		expect(new Set(tops).size).toBe(2);
	});
});
