import { Input, Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { render } from "../utils/render.js";

function blockType(slug: string, label: string, fields: BlockFieldDefinition[]): BlockType {
	return {
		id: `${slug}-id`,
		slug,
		label,
		category: "Layout",
		currentVersion: 1,
		source: "user",
		createdAt: "2026-01-01T00:00:00.000Z",
		updatedAt: "2026-01-01T00:00:00.000Z",
		versions: [
			{
				id: `${slug}-v1`,
				blockTypeId: `${slug}-id`,
				version: 1,
				fields,
				fingerprint: `${slug}-v1`,
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
}

const LONG = blockType(
	"long",
	"Long",
	Array.from({ length: 12 }, (_, index) => ({
		slug: `line_${index}`,
		label: `Line ${index}`,
		type: "string" as const,
	})),
);
const SHORT = blockType("short", "Short", [{ slug: "title", label: "Title", type: "string" }]);

function Field({ initial, types }: { initial: StoredBlockValue[]; types: BlockType[] }) {
	const [value, setValue] = React.useState<unknown>(initial);
	const props: BlocksFieldProps = {
		id: "field-layout",
		fieldPath: "layout",
		label: "Layout",
		value,
		onChange: setValue,
		blockTypes: types,
		allowedTypes: types.map((type) => type.slug),
		retiredTypes: [],
		renderField: ({ name, field }) => <Input key={name} label={field.label} />,
	};
	return <BlocksField {...props} />;
}

function renderField(ui: React.ReactElement) {
	return render(ui, { wrapper: Toasty });
}

const row = (key: string) => document.querySelector<HTMLElement>(`[data-block-key="${key}"]`)!;
const toggleOf = (key: string) => row(key).querySelector<HTMLElement>("[data-block-toggle]")!;
const bodyOf = (key: string) => row(key).querySelector<HTMLElement>("[data-block-body]");
const settled = () =>
	expect
		.poll(() => document.getAnimations().filter((a) => a.playState === "running").length)
		.toBe(0);

/** Calls `read` on every frame until nothing animates and `done` holds, and returns what it read. */
async function framesUntilSettled<T>(read: () => T, done = () => true): Promise<T[]> {
	const frames: T[] = [];
	const start = performance.now();
	await new Promise<void>((resolve) => {
		const tick = () => {
			frames.push(read());
			const moving = document.getAnimations().some((a) => a.playState === "running");
			if ((moving || !done() || frames.length < 3) && performance.now() - start < 2000) {
				requestAnimationFrame(tick);
			} else resolve();
		};
		requestAnimationFrame(tick);
	});
	return frames;
}

const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));

afterEach(async () => {
	await cdp().send("Emulation.setEmulatedMedia", { features: [] });
});

describe("Blocks field motion", () => {
	it("keeps a pinned head under the pointer while its block closes, then gives the room back", async () => {
		await renderField(
			<div data-testid="scroller" style={{ width: 480, height: 300, overflow: "auto" }}>
				<Field
					initial={[
						{ _type: "long", _version: 1, _key: "long" },
						{ _type: "short", _version: 1, _key: "short" },
					]}
					types={[LONG, SHORT]}
				/>
			</div>,
		);
		const scroller = page.getByTestId("scroller").element() as HTMLElement;
		toggleOf("long").click();
		await settled();
		scroller.scrollTop = 400;
		const head = toggleOf("long");
		const pinned = head.getBoundingClientRect().top;
		expect(pinned - scroller.getBoundingClientRect().top).toBeLessThan(12);

		head.click();
		const tops = await framesUntilSettled(
			() => head.getBoundingClientRect().top,
			() => !bodyOf("long"),
		);

		expect(bodyOf("long")).toBeNull();
		for (const top of tops) expect(Math.abs(top - pinned)).toBeLessThanOrEqual(1);

		scroller.scrollTop = 0;
		await expect.poll(() => scroller.scrollHeight).toBeLessThanOrEqual(scroller.clientHeight);
	});

	it("leaves a pinned block's fields where they were when it's reopened while closing", async () => {
		await renderField(
			<div data-testid="scroller" style={{ width: 480, height: 300, overflow: "auto" }}>
				<Field initial={[{ _type: "long", _version: 1, _key: "long" }]} types={[LONG]} />
			</div>,
		);
		const scroller = page.getByTestId("scroller").element() as HTMLElement;
		toggleOf("long").click();
		await settled();
		scroller.scrollTop = 400;
		const head = toggleOf("long");
		const field = page.getByLabelText("Line 8").element();
		const before = [head.getBoundingClientRect().top, field.getBoundingClientRect().top];
		const scrolled = scroller.scrollTop;

		head.click();
		await frame();
		await frame();
		head.click();
		const frames = await framesUntilSettled(() => [
			head.getBoundingClientRect().top,
			field.getBoundingClientRect().top,
		]);

		await expect.poll(() => Math.abs(scroller.scrollTop - scrolled)).toBeLessThanOrEqual(1);
		frames.push([head.getBoundingClientRect().top, field.getBoundingClientRect().top]);
		for (const [headTop, fieldTop] of frames) {
			expect(Math.abs(headTop! - before[0]!)).toBeLessThanOrEqual(1);
			expect(Math.abs(fieldTop! - before[1]!)).toBeLessThanOrEqual(1);
		}
	});

	it("closes from wherever an opening block has got to", async () => {
		await renderField(
			<div style={{ width: 480 }}>
				<Field initial={[{ _type: "long", _version: 1, _key: "long" }]} types={[LONG]} />
			</div>,
		);
		toggleOf("long").click();
		for (let count = 0; count < 4; count++) await frame();
		const body = bodyOf("long")!;
		const midway = body.getBoundingClientRect().height;
		expect(midway).toBeGreaterThan(0);
		expect(midway).toBeLessThan(body.firstElementChild!.getBoundingClientRect().height);

		toggleOf("long").click();
		const heights = await framesUntilSettled(
			() => bodyOf("long")?.getBoundingClientRect().height ?? 0,
			() => !bodyOf("long"),
		);

		expect(Math.max(...heights)).toBeLessThanOrEqual(midway + 1);
		expect(heights.at(-1)).toBe(0);
	});

	it("opens and closes every block at once with Expand all and Collapse all", async () => {
		const screen = await renderField(
			<div style={{ width: 480 }}>
				<Field
					initial={[
						{ _type: "long", _version: 1, _key: "one" },
						{ _type: "long", _version: 1, _key: "two" },
					]}
					types={[LONG]}
				/>
			</div>,
		);

		await screen.getByRole("button", { name: "Expand all" }).click();
		for (const key of ["one", "two"]) {
			const body = bodyOf(key)!;
			expect(body.getBoundingClientRect().height).toBe(
				body.firstElementChild!.getBoundingClientRect().height,
			);
			expect(body.getAnimations()).toHaveLength(0);
		}

		await screen.getByRole("button", { name: "Collapse all" }).click();
		expect(bodyOf("one")).toBeNull();
		expect(bodyOf("two")).toBeNull();
	});

	it("opens and closes without motion when reduced motion is preferred", async () => {
		await cdp().send("Emulation.setEmulatedMedia", {
			features: [{ name: "prefers-reduced-motion", value: "reduce" }],
		});
		await renderField(
			<div style={{ width: 480 }}>
				<Field initial={[{ _type: "long", _version: 1, _key: "long" }]} types={[LONG]} />
			</div>,
		);

		toggleOf("long").click();
		await frame();
		const body = bodyOf("long")!;
		expect(body.getBoundingClientRect().height).toBe(
			body.firstElementChild!.getBoundingClientRect().height,
		);

		toggleOf("long").click();
		await frame();
		expect(bodyOf("long")).toBeNull();
	});

	it("eases a dropped block from where it was let go into its slot", async () => {
		await renderField(
			<div style={{ width: 480, marginInline: 80 }}>
				<Field
					initial={["one", "two", "three"].map((key) => ({
						_type: "short",
						_version: 1,
						_key: key,
					}))}
					types={[SHORT]}
				/>
			</div>,
		);
		const handle = row("one").querySelector<HTMLElement>(
			'[aria-label="Block actions - drag to reorder, click for menu"]',
		)!;
		const start = row("one").getBoundingClientRect();
		const target = row("three").getBoundingClientRect();
		const x = start.left + 4;
		const y = start.top + start.height / 2;
		const pointer = (type: string, clientY: number) =>
			new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				isPrimary: true,
				pointerId: 1,
				button: 0,
				buttons: type === "pointerup" ? 0 : 1,
				clientX: x,
				clientY,
			});
		handle.dispatchEvent(pointer("pointerdown", y));
		// Let go past the last slot's center, as a hand would.
		const end = target.top + target.height / 2 + 12;
		for (let step = 1; step <= 12; step++) {
			document.dispatchEvent(pointer("pointermove", y + ((end - y) * step) / 12));
			await frame();
		}
		await new Promise((resolve) => setTimeout(resolve, 250));
		const letGo = row("one").getBoundingClientRect().top;
		document.dispatchEvent(pointer("pointerup", end));

		const tops = await framesUntilSettled(() => row("one").getBoundingClientRect().top);

		const order = Array.from(document.querySelectorAll("[data-block-key]"), (element) =>
			element.getAttribute("data-block-key"),
		);
		expect(order).toEqual(["two", "three", "one"]);
		const slot = tops.at(-1)!;
		const distance = Math.abs(letGo - slot);
		expect(distance).toBeGreaterThan(4);
		expect(Math.abs(tops[0]! - slot)).toBeGreaterThan(1);
		const path = [letGo, ...tops];
		const steps = tops.map((top, index) => Math.abs(top - path[index]!));
		expect(Math.max(...steps)).toBeLessThan(distance * 0.75);
	});
});
