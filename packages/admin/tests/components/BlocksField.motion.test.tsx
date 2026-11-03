import { Input, Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { afterEach, describe, expect, it } from "vitest";
import { cdp, page } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
import { expectGlide, holdAnimations, readAlong, readMotion } from "../utils/animation.js";
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
const LIST = blockType("list", "List", [
	{
		slug: "items",
		label: "Items",
		type: "repeater",
		validation: {
			subFields: [
				{ slug: "title", label: "Title", type: "string" },
				...Array.from({ length: 16 }, (_, index) => ({
					slug: `detail_${index}`,
					label: `Detail ${index}`,
					type: "string",
				})),
			],
		},
	},
]);

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

		const tops = () => [head.getBoundingClientRect().top, field.getBoundingClientRect().top];
		const panels = holdAnimations((target) => row("long").contains(target));

		head.click();
		const frames = readAlong(await panels.started(), tops, [0.25, 0.5]);
		head.click();
		frames.push(...readAlong(panels.held, tops));
		panels.release();
		await settled();

		await expect.poll(() => Math.abs(scroller.scrollTop - scrolled)).toBeLessThanOrEqual(1);
		frames.push(tops());
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
		const height = () => bodyOf("long")?.getBoundingClientRect().height ?? 0;
		const panel = holdAnimations((target) => target.matches("[data-block-body]"));
		toggleOf("long").click();
		const [midway] = readAlong(await panel.started(), height, [0.5]);
		expect(midway).toBeGreaterThan(0);
		expect(midway).toBeLessThan(bodyOf("long")!.firstElementChild!.getBoundingClientRect().height);

		toggleOf("long").click();
		const heights = readAlong(await panel.started(), height);
		panel.release();
		await expect.poll(() => bodyOf("long")).toBeNull();

		expectGlide(heights, midway!, 0);
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

	it.each(["auto", "none"])(
		"keeps the block being read at the top across Collapse all, with nothing blank under it (overflow-anchor: %s)",
		async (overflowAnchor) => {
			await renderField(
				<div
					data-testid="scroller"
					style={{ width: 480, height: 300, overflow: "auto", overflowAnchor }}
				>
					<Field
						initial={["one", "two", "three", "four"].map((key) => ({
							_type: "long",
							_version: 1,
							_key: key,
						}))}
						types={[LONG]}
					/>
					<div style={{ height: 600 }} />
				</div>,
			);
			const scroller = page.getByTestId("scroller").element() as HTMLElement;
			const height = scroller.getBoundingClientRect().height;
			(page.getByRole("button", { name: "Expand all" }).element() as HTMLElement).click();
			await settled();
			scroller.scrollTop +=
				row("three").getBoundingClientRect().top - scroller.getBoundingClientRect().top + 300;
			const head = toggleOf("three");
			const pinned = head.getBoundingClientRect().top;
			expect(pinned - scroller.getBoundingClientRect().top).toBeLessThan(12);

			(page.getByRole("button", { name: "Collapse all" }).element() as HTMLElement).click();
			await frame();

			expect(bodyOf("three")).toBeNull();
			expect(scroller.getBoundingClientRect().height).toBe(height);
			expect(Math.abs(head.getBoundingClientRect().top - pinned)).toBeLessThanOrEqual(1);
			const view = scroller.getBoundingClientRect();
			const bottom = document.elementFromPoint(view.left + 40, view.bottom - 20);
			expect(bottom !== scroller && scroller.contains(bottom)).toBe(true);
		},
	);

	it("reserves no more room while two blocks close at once than their closing needs", async () => {
		await renderField(
			<div data-testid="scroller" style={{ width: 480, height: 300, overflow: "auto" }}>
				<div style={{ height: 600 }} />
				<Field
					initial={[
						{ _type: "short", _version: 1, _key: "one" },
						{ _type: "short", _version: 1, _key: "two" },
					]}
					types={[SHORT]}
				/>
			</div>,
		);
		const scroller = page.getByTestId("scroller").element() as HTMLElement;
		const field = scroller.querySelector("#field-layout")!;
		(page.getByRole("button", { name: "Expand all" }).element() as HTMLElement).click();
		await settled();
		scroller.scrollTop = scroller.scrollHeight;
		// The space under the field, which is all room added to keep the view in place.
		const blank = () =>
			scroller.scrollHeight -
			(field.getBoundingClientRect().bottom -
				scroller.getBoundingClientRect().top +
				scroller.scrollTop);
		expect(blank()).toBeLessThanOrEqual(0.5);

		toggleOf("one").click();
		await frame();
		await frame();
		await frame();
		toggleOf("two").click();
		const blanks = [blank(), ...(await framesUntilSettled(blank, () => !bodyOf("two")))];

		expect(bodyOf("one")).toBeNull();
		const kept = blanks.at(-1)!;
		expect(kept).toBeGreaterThan(0);
		expect(Math.max(...blanks)).toBeLessThanOrEqual(kept + 2);
	});

	it("never grows its scroller to make room, even for an item closing out of view", async () => {
		await renderField(
			<div data-testid="scroller" style={{ width: 480, height: 300, overflow: "auto" }}>
				<Field
					initial={[
						{
							_type: "list",
							_version: 1,
							_key: "list",
							items: [{ title: "First" }, { title: "Second" }],
						},
					]}
					types={[LIST]}
				/>
				<div style={{ height: 250 }} />
			</div>,
		);
		const scroller = page.getByTestId("scroller").element() as HTMLElement;
		const height = scroller.getBoundingClientRect().height;
		toggleOf("list").click();
		await settled();
		const item = page.getByRole("button", { name: "First", exact: true }).element() as HTMLElement;
		item.click();
		await settled();
		scroller.scrollTop = scroller.scrollHeight;
		expect(item.closest('[role="listitem"]')!.getBoundingClientRect().bottom).toBeLessThan(
			scroller.getBoundingClientRect().top,
		);

		item.click();
		const heights = await framesUntilSettled(
			() => scroller.getBoundingClientRect().height,
			() => item.getAttribute("aria-expanded") === "false",
		);

		for (const each of heights) expect(each).toBe(height);
	});

	it.each(["the field goes away", "the scroller's content is replaced"])(
		"gives the room back once %s",
		async (change) => {
			function Page({ content }: { content: "field" | "other" }) {
				return (
					<div data-testid="scroller" style={{ width: 480, height: 300, overflow: "auto" }}>
						{change === "the field goes away" ? (
							<div>
								<div style={{ height: 400 }} />
								{content === "field" && (
									<Field
										initial={[{ _type: "short", _version: 1, _key: "short" }]}
										types={[SHORT]}
									/>
								)}
							</div>
						) : (
							<div key={content}>
								<div style={{ height: 400 }} />
								{content === "field" && (
									<Field
										initial={[{ _type: "short", _version: 1, _key: "short" }]}
										types={[SHORT]}
									/>
								)}
							</div>
						)}
					</div>
				);
			}
			const screen = await renderField(<Page content="field" />);
			const scroller = page.getByTestId("scroller").element() as HTMLElement;
			toggleOf("short").click();
			await settled();
			scroller.scrollTop = scroller.scrollHeight;
			toggleOf("short").click();
			await settled();
			await frame();
			expect(scroller.scrollHeight).toBeGreaterThan(scroller.firstElementChild!.scrollHeight);

			await screen.rerender(<Page content="other" />);

			await expect
				.poll(() => scroller.scrollHeight)
				.toBe(scroller.firstElementChild!.getBoundingClientRect().height);
		},
	);

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
		const handle = row("one").querySelector<HTMLElement>('[aria-label="Reorder Short"]')!;
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
		const { from, along, to } = await readMotion(
			(element) => element === row("one"),
			() => row("one").getBoundingClientRect().top,
			() => document.dispatchEvent(pointer("pointerup", end)),
		);

		const order = Array.from(document.querySelectorAll("[data-block-key]"), (element) =>
			element.getAttribute("data-block-key"),
		);
		expect(order).toEqual(["two", "three", "one"]);
		expect(Math.abs(from - to)).toBeGreaterThan(4);
		expectGlide(along, from, to);
	});

	it("follows the pointer at once when a block is dragged again while it settles", async () => {
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
		const handle = () => row("one").querySelector<HTMLElement>('[aria-label="Reorder Short"]')!;
		const pointer = (type: string, clientX: number, clientY: number) =>
			new PointerEvent(type, {
				bubbles: true,
				cancelable: true,
				isPrimary: true,
				pointerId: 1,
				button: 0,
				buttons: type === "pointerup" ? 0 : 1,
				clientX,
				clientY,
			});
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

		// Picked up again straight away, and drawn back up 10px a frame.
		handle().dispatchEvent(pointer("pointerdown", x, end));
		const tops: number[] = [];
		for (let step = 1; step <= 5; step++) {
			document.dispatchEvent(pointer("pointermove", x, end - step * 10));
			await frame();
			tops.push(row("one").getBoundingClientRect().top);
		}
		document.dispatchEvent(pointer("pointerup", x, end - 50));
		await settled();

		// The first move only starts the drag.
		const steps = tops.slice(2).map((top, index) => top - tops[index + 1]!);
		for (const step of steps) expect(step).toBeCloseTo(-10, 0);
	});
});
