import { Select, Toasty } from "@cloudflare/kumo";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { QUIET_OPTION, QUIET_SELECT } from "../../src/components/block-field-styles.js";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import type { StoredBlockValue } from "../../src/lib/block-field-state.js";
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

const SHORT = blockType("short", "Short", [{ slug: "title", label: "Title", type: "string" }]);
const OPTIONS = blockType("options", "Options", [
	{ slug: "icon", label: "Icon", type: "select", validation: { options: ["bolt", "leaf"] } },
	{ slug: "tone", label: "Tone", type: "select", validation: { options: ["calm", "bold"] } },
]);
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
const TYPES = [SHORT, QUOTES, OPTIONS];

const short = (key: string): StoredBlockValue => ({
	_type: "short",
	_version: 1,
	_key: key,
	title: key,
});
const quotes = (): StoredBlockValue => ({
	_type: "quotes",
	_version: 1,
	_key: "quotes",
	quotes: [
		{ author: "Maya Okafor", quote: "Savings in the first month." },
		{ author: "Jonas Berg", quote: "The numbers add up." },
	],
});

function Harness({ initial }: { initial: StoredBlockValue[] }) {
	const [value, setValue] = React.useState(initial);
	const props: BlocksFieldProps = {
		id: "field-layout",
		fieldPath: "layout",
		label: "Layout",
		value,
		onChange: setValue,
		blockTypes: TYPES,
		allowedTypes: TYPES.map((type) => type.slug),
		retiredTypes: [],
		renderField: ({ name, field, value: fieldValue, onChange, chrome }) =>
			field.kind === "select" ? (
				<Select
					aria-label={field.label}
					items={Object.fromEntries(
						(Array.isArray(field.options) ? field.options : []).map((option) => [
							option.value,
							option.label,
						]),
					)}
					value={typeof fieldValue === "string" ? fieldValue : null}
					onValueChange={(next) => onChange(next)}
					className={QUIET_SELECT}
				>
					{(Array.isArray(field.options) ? field.options : []).map((option) => (
						<Select.Option key={option.value} value={option.value} className={QUIET_OPTION}>
							{option.label}
						</Select.Option>
					))}
				</Select>
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

function renderField(initial: StoredBlockValue[], { width = 360 } = {}) {
	return render(
		<div style={{ width, margin: "40px 16px" }}>
			<Harness initial={initial} />
		</div>,
		{ wrapper: Toasty },
	);
}

/**
 * Runs `test` on a touch screen. A page that isn't one becomes one for the test only: turning
 * touch emulation off afterwards puts back the hover and pointer the page started with.
 */
async function onTouchScreen(test: () => Promise<void>) {
	if (matchMedia("(pointer: coarse)").matches) {
		await test();
		return;
	}
	await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 5 });
	try {
		expect(matchMedia("(pointer: coarse)").matches).toBe(true);
		await test();
	} finally {
		await cdp().send("Emulation.setTouchEmulationEnabled", { enabled: false });
	}
}

/** Taps the element with real touch input, as a finger would. */
async function tap(element: Element) {
	// Touch input lands in the top-level page, which hosts this test's frame.
	const frame = window.frameElement?.getBoundingClientRect() ?? new DOMRect();
	const scale = frame.width ? frame.width / window.innerWidth : 1;
	const box = element.getBoundingClientRect();
	const x = frame.left + (box.left + box.width / 2) * scale;
	const y = frame.top + (box.top + box.height / 2) * scale;
	await cdp().send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
	await cdp().send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
}

/** Whether a tap `by` px outside the element's edge, on the side `side`, lands on it. */
function reaches(element: HTMLElement, side: "start" | "end" | "above" | "below", by: number) {
	const box = element.getBoundingClientRect();
	const point =
		side === "above" || side === "below"
			? [box.left + box.width / 2, side === "above" ? box.top - by : box.bottom + by]
			: [side === "end" ? box.right + by : box.left - by, box.top + box.height / 2];
	return element.contains(document.elementFromPoint(point[0]!, point[1]!));
}

const settled = () =>
	expect
		.poll(() => document.getAnimations().filter((a) => a.playState === "running").length)
		.toBe(0);

describe("Blocks field on a touch screen", () => {
	it("gives the Undo toast 44px targets and leaves out its keyboard shortcut", async () => {
		await onTouchScreen(async () => {
			await renderField([short("one"), short("two")]);
			await page
				.getByRole("button", { name: /actions$/ })
				.first()
				.click();
			await page.getByRole("menuitem", { name: "Delete" }).click();
			const toast = page.getByRole("dialog");
			await expect.element(toast.getByText("Deleted Short")).toBeVisible();
			await settled();

			expect((toast.element() as HTMLElement).innerText).not.toMatch(/⌘|Ctrl/);
			const undo = toast.getByRole("button", { name: "Undo" }).element() as HTMLElement;
			expect(undo.getBoundingClientRect().height).toBeGreaterThanOrEqual(44);
			const close = toast.element().querySelector<HTMLElement>('[data-kumo-part="close"]')!;
			for (const side of ["start", "end", "above", "below"] as const) {
				expect(reaches(close, side, 11)).toBe(true);
			}
		});
	});

	it("gives Expand all, menu items and an open item's caret 44px targets", async () => {
		await onTouchScreen(async () => {
			await renderField([quotes()]);
			const expand = page.getByRole("button", { name: "Expand all" }).element() as HTMLElement;
			// Earlier test files can leave the page scrolled, which would put the probe above the view.
			expand.scrollIntoView({ block: "center" });
			expect(reaches(expand, "above", 8)).toBe(true);
			expect(reaches(expand, "below", 8)).toBe(true);

			await page.getByRole("button", { name: /actions$/ }).click();
			await expect.element(page.getByRole("menu")).toBeVisible();
			await settled();
			for (const item of page.getByRole("menuitem").all()) {
				expect((item.element() as HTMLElement).getBoundingClientRect().height).toBe(44);
			}
			await userEvent.keyboard("{Escape}");
			await expect.element(page.getByRole("menu")).not.toBeInTheDocument();

			await page.getByRole("button", { name: "Testimonials", exact: true }).click();
			await page.getByRole("button", { name: "Maya Okafor", exact: true }).click();
			await settled();
			const caret = document.querySelector<HTMLElement>('[data-item-focus][aria-expanded="true"]')!;
			for (const side of ["start", "end", "above", "below"] as const) {
				expect(reaches(caret, side, 9)).toBe(true);
			}
		});
	});

	it("gives a quiet select a 44px target at the same height", async () => {
		await onTouchScreen(async () => {
			await render(
				<div style={{ width: 240, paddingBlock: 40 }}>
					<Select
						aria-label="Icon"
						items={{ bolt: "Bolt", leaf: "Leaf" }}
						value={null}
						className={QUIET_SELECT}
					>
						<Select.Option value="bolt" className={QUIET_OPTION}>
							Bolt
						</Select.Option>
						<Select.Option value="leaf" className={QUIET_OPTION}>
							Leaf
						</Select.Option>
					</Select>
				</div>,
			);
			const trigger = page.getByRole("combobox", { name: "Icon" }).element() as HTMLElement;
			trigger.scrollIntoView({ block: "center" });
			expect(trigger.getBoundingClientRect().height).toBe(32);
			expect(reaches(trigger, "above", 5)).toBe(true);
			expect(reaches(trigger, "below", 5)).toBe(true);
		});
	});

	it("keeps a settings row's select out of the rows beside it", async () => {
		await onTouchScreen(async () => {
			await renderField(
				[{ _type: "options", _version: 1, _key: "options", icon: "bolt", tone: "calm" }],
				{
					width: 600,
				},
			);
			await page.getByRole("button", { name: "Options", exact: true }).click();
			await settled();
			const icon = page.getByRole("combobox", { name: "Icon" }).element() as HTMLElement;
			const tone = page.getByRole("combobox", { name: "Tone" }).element() as HTMLElement;
			icon.scrollIntoView({ block: "center" });
			const upper = icon.getBoundingClientRect();
			const lower = tone.getBoundingClientRect();
			expect(lower.top - upper.bottom).toBeLessThan(6);

			const x = upper.left + upper.width / 2;
			expect(icon.contains(document.elementFromPoint(x, upper.bottom - 1))).toBe(true);
			expect(tone.contains(document.elementFromPoint(x, lower.top + 1))).toBe(true);
		});
	});

	it("keeps Undo open as long after a tap as after the keyboard", async () => {
		await onTouchScreen(async () => {
			await renderField([short("one"), short("two")]);
			await tap(
				page
					.getByRole("button", { name: /actions$/ })
					.first()
					.element(),
			);
			const remove = page.getByRole("menuitem", { name: "Delete" });
			await expect.element(remove).toBeVisible();
			await settled();
			await tap(remove.element());
			await expect.element(page.getByText("Deleted Short")).toBeVisible();

			await new Promise((resolve) => setTimeout(resolve, 8000));
			await expect.element(page.getByRole("button", { name: "Undo" })).toBeVisible();
		});
	}, 20_000);

	it("opens the block picker from the keyboard ready to type in", async () => {
		await onTouchScreen(async () => {
			await renderField([short("one")]);
			(
				page.getByRole("button", { name: "Add block", exact: true }).element() as HTMLElement
			).focus();
			await userEvent.keyboard("{Enter}");
			const search = page.getByRole("combobox", { name: "Search block types" });
			await expect.element(search).toHaveFocus();

			await userEvent.keyboard("{ArrowDown}{Enter}");
			await expect.poll(() => document.querySelectorAll("[data-block-key]").length).toBe(2);
		});
	});

	it("opens a tapped item without putting the caret in its title", async () => {
		await onTouchScreen(async () => {
			await renderField([quotes()]);
			await page.getByRole("button", { name: "Testimonials", exact: true }).click();
			await settled();
			const item = page.getByRole("button", { name: "Jonas Berg", exact: true });

			await tap(item.element());
			await expect.element(item).toHaveAttribute("aria-expanded", "true");
			await settled();
			expect(document.activeElement).not.toBeInstanceOf(HTMLInputElement);
		});
	});

	it("opens the block picker from a tap without focusing its search, which a tap then focuses", async () => {
		await onTouchScreen(async () => {
			await renderField([short("one")]);
			await tap(page.getByRole("button", { name: "Add block", exact: true }).element());
			const search = page.getByRole("combobox", { name: "Search block types" });
			await expect.element(search).toBeVisible();
			await settled();
			expect(document.activeElement).not.toBeInstanceOf(HTMLInputElement);

			await tap(search.element());
			await expect.element(search).toHaveFocus();
		});
	});
});
