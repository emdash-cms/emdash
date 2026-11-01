import { Input, Toasty } from "@cloudflare/kumo";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField, type BlocksFieldProps } from "../../src/components/BlocksField.js";
import type { BlockFieldDefinition, BlockType } from "../../src/lib/api/schema.js";
import { render } from "../utils/render.js";

function blockType(
	slug: string,
	label: string,
	description?: string,
	fields: BlockFieldDefinition[] = [{ slug: "title", label: "Title", type: "string" }],
): BlockType {
	return {
		id: `${slug}-id`,
		slug,
		label,
		description,
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

function Field(props: Partial<BlocksFieldProps> & Pick<BlocksFieldProps, "value" | "blockTypes">) {
	return (
		<BlocksField
			id="field-layout"
			fieldPath="layout"
			label="Layout"
			onChange={() => {}}
			allowedTypes={props.blockTypes.map((type) => type.slug)}
			retiredTypes={[]}
			renderField={() => null}
			{...props}
		/>
	);
}

function renderField(ui: React.ReactElement) {
	return render(ui, { wrapper: Toasty });
}

/**
 * Shows each row's gutter, which the stylesheet shows only with a hover-capable fine pointer.
 * Chromium on Linux loses both once an earlier test file in the same page ends touch emulation,
 * and can't emulate them.
 */
function showGutters() {
	for (const add of document.querySelectorAll<HTMLElement>('[aria-label="Add block below"]')) {
		add.parentElement!.style.display = "flex";
	}
}

afterEach(async () => {
	document.documentElement.dir = "ltr";
	await page.viewport(1280, 800);
});

describe("Block picker layout", () => {
	it("wraps a long block type description inside the picker", async () => {
		const description =
			"A full-width section with a heading, a paragraph of supporting copy and two call-to-action buttons";
		const screen = await renderField(
			<div style={{ width: 640 }}>
				<Field
					value={[]}
					blockTypes={[blockType("hero", "Hero", description), blockType("quote", "Quote")]}
				/>
			</div>,
		);

		await screen.getByRole("button", { name: "Add block", exact: true }).click();
		const listbox = screen.getByRole("listbox").element();
		const hero = screen.getByRole("option", { name: /^Hero/ }).element();
		const listboxBox = listbox.getBoundingClientRect();
		const heroBox = hero.getBoundingClientRect();

		expect(listbox.scrollWidth).toBeLessThanOrEqual(listbox.clientWidth);
		expect(heroBox.left).toBeGreaterThanOrEqual(listboxBox.left);
		expect(heroBox.right).toBeLessThanOrEqual(listboxBox.right);
		expect(screen.getByText(description).element().getBoundingClientRect().height).toBeGreaterThan(
			20,
		);
	});
});

describe("Block row layout", () => {
	it.each(["ltr", "rtl"] as const)(
		"fits a phone-width column and truncates a long summary at its end (%s)",
		async (dir) => {
			await page.viewport(375, 812);
			document.documentElement.dir = dir;
			const statement =
				"An independent design studio making identities, books and websites for culture and commerce.";
			const screen = await renderField(
				<div data-testid="column" dir={dir} style={{ width: 360 }}>
					<Field
						value={[{ _type: "statement", _version: 1, _key: "statement", title: statement }]}
						blockTypes={[blockType("statement", "Statement")]}
						renderField={({ name, field, value }) => (
							<Input
								key={name}
								label={field.label}
								defaultValue={typeof value === "string" ? value : ""}
							/>
						)}
					/>
				</div>,
			);

			const summary = screen.getByText(statement).element();
			const summaryBox = summary.getBoundingClientRect();
			const firstCharacter = document.createRange();
			firstCharacter.setStart(summary.firstChild!, 0);
			firstCharacter.setEnd(summary.firstChild!, 1);
			const firstCharacterBox = firstCharacter.getBoundingClientRect();
			expect(summary.scrollWidth).toBeGreaterThan(summary.clientWidth);
			expect(firstCharacterBox.left).toBeGreaterThanOrEqual(Math.floor(summaryBox.left));
			expect(firstCharacterBox.right).toBeLessThanOrEqual(Math.ceil(summaryBox.right));

			await screen.getByRole("button", { name: "Statement", exact: true }).click();
			const column = screen.getByTestId("column").element();
			const columnBox = column.getBoundingClientRect();
			expect(column.querySelectorAll("[data-block-key]")).toHaveLength(1);
			expect(column.querySelectorAll("input")).toHaveLength(1);
			for (const element of column.querySelectorAll("[data-block-key], button, input")) {
				if (element.getClientRects().length === 0) continue;
				const box = element.getBoundingClientRect();
				expect(box.left).toBeGreaterThanOrEqual(Math.floor(columnBox.left));
				expect(box.right).toBeLessThanOrEqual(Math.ceil(columnBox.right));
			}
			await expect.element(screen.getByRole("button", { name: "Statement actions" })).toBeVisible();
		},
	);

	it("puts a short left-to-right summary right after the name in a right-to-left admin", async () => {
		const screen = await renderField(
			<div dir="rtl" style={{ width: 360 }}>
				<Field
					value={[{ _type: "statement", _version: 1, _key: "statement", title: "Hello" }]}
					blockTypes={[blockType("statement", "Statement")]}
				/>
			</div>,
		);

		const label = screen.getByText("Statement").element().getBoundingClientRect();
		const summaryText = document.createRange();
		summaryText.selectNodeContents(screen.getByText("Hello").element());
		const summary = summaryText.getBoundingClientRect();
		expect(summary.right).toBeLessThanOrEqual(label.left);
		expect(label.left - summary.right).toBeLessThan(16);
		expect(
			Math.abs(summary.top + summary.height / 2 - (label.top + label.height / 2)),
		).toBeLessThan(2);
	});

	it("wraps a long one-word block type label before the block actions", async () => {
		const label = "Kundenreferenzenkarussellvorlage";
		const screen = await renderField(
			<div style={{ width: 360 }}>
				<Field
					value={[{ _type: "testimonials", _version: 1, _key: "testimonials" }]}
					blockTypes={[blockType("testimonials", label)]}
				/>
			</div>,
		);

		const labelBox = screen.getByText(label).element().getBoundingClientRect();
		const actions = screen.getByRole("button", { name: `${label} actions` }).element();
		expect(labelBox.right).toBeLessThanOrEqual(actions.getBoundingClientRect().left);
	});

	it("keeps the name and actions in place when a block opens", async () => {
		const screen = await renderField(
			<div style={{ width: 480 }}>
				<Field
					value={[{ _type: "statement", _version: 1, _key: "statement", title: "Hello" }]}
					blockTypes={[blockType("statement", "Statement")]}
				/>
			</div>,
		);
		const toggle = screen.getByRole("button", { name: "Statement", exact: true });
		const measure = () =>
			[
				screen.getByText("Statement").element(),
				screen.getByText("Hello").element(),
				screen.getByRole("button", { name: "Statement actions" }).element(),
			].map((element) => {
				const { left, top, width, height } = element.getBoundingClientRect();
				return { left, top, width, height };
			});

		const closed = measure();
		await toggle.click();
		await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
		expect(measure()).toEqual(closed);
	});

	it("pins an open block's header while its fields scroll past", async () => {
		const fields = Array.from({ length: 12 }, (_, index) => ({
			slug: `line_${index}`,
			label: `Line ${index}`,
			type: "string" as const,
		}));
		const screen = await renderField(
			<div data-testid="scroller" style={{ width: 480, height: 300, overflow: "auto" }}>
				<Field
					value={[{ _type: "long", _version: 1, _key: "long" }]}
					blockTypes={[blockType("long", "Long", undefined, fields)]}
					renderField={({ name, field }) => <Input key={name} label={field.label} />}
				/>
			</div>,
		);

		const toggle = screen.getByRole("button", { name: "Long", exact: true });
		await toggle.click();
		const scroller = screen.getByTestId("scroller").element();
		scroller.scrollTop = 400;
		await expect
			.poll(
				() => toggle.element().getBoundingClientRect().top - scroller.getBoundingClientRect().top,
			)
			.toBeLessThan(12);
		expect(
			document.elementFromPoint(
				toggle.element().getBoundingClientRect().left + 4,
				toggle.element().getBoundingClientRect().top + 4,
			),
		).toSatisfy((element: Element | null) => toggle.element().contains(element));
	});

	it.each(["ltr", "rtl"] as const)(
		"puts the hover gutter outside the sheet at the row's start (%s)",
		async (dir) => {
			document.documentElement.dir = dir;
			const screen = await renderField(
				<div dir={dir} style={{ width: 480, marginInline: 80 }}>
					<Field
						value={[{ _type: "statement", _version: 1, _key: "statement", title: "Hello" }]}
						blockTypes={[blockType("statement", "Statement")]}
					/>
				</div>,
			);

			showGutters();
			const rowBox = document.querySelector("[data-block-key]")!.getBoundingClientRect();
			const add = screen
				.getByRole("button", { name: "Add block below" })
				.element()
				.getBoundingClientRect();
			const handle = screen
				.getByRole("button", { name: "Block actions - drag to reorder, click for menu" })
				.element()
				.getBoundingClientRect();
			const caret = screen
				.getByRole("button", { name: "Statement", exact: true })
				.element()
				.querySelector("svg")!;
			if (dir === "ltr") {
				expect(handle.right).toBeLessThanOrEqual(rowBox.left);
				expect(add.right).toBeLessThanOrEqual(handle.left);
				expect(getComputedStyle(caret).scale).not.toBe("-1 1");
			} else {
				expect(handle.left).toBeGreaterThanOrEqual(rowBox.right);
				expect(add.left).toBeGreaterThanOrEqual(handle.right);
				expect(getComputedStyle(caret).scale).toBe("-1 1");
			}
		},
	);

	it("leaves no gutter on a phone-width screen", async () => {
		await page.viewport(375, 812);
		const screen = await renderField(
			<Field
				value={[{ _type: "statement", _version: 1, _key: "statement", title: "Hello" }]}
				blockTypes={[blockType("statement", "Statement")]}
			/>,
		);

		await expect.element(screen.getByRole("button", { name: "Statement actions" })).toBeVisible();
		expect(screen.getByRole("button", { name: "Add block below" }).query()).toBeNull();
	});

	it.each(["ltr", "rtl"] as const)(
		"keeps a long list item title from widening the field (%s)",
		async (dir) => {
			const quoteFields = [{ slug: "quote", label: "Quote", type: "text" }];
			const quote =
				"We found more savings in the first month than in five years of energy audits, and the people who run our buildings finally trust the numbers they see every morning.";
			const screen = await renderField(
				<div dir={dir} data-testid="scroller" style={{ width: 640, overflow: "auto" }}>
					<Field
						value={[{ _type: "testimonials", _version: 1, _key: "block-1", quotes: [{ quote }] }]}
						blockTypes={[
							blockType("testimonials", "Testimonials", undefined, [
								{
									slug: "quotes",
									label: "Quotes",
									type: "repeater",
									validation: { subFields: quoteFields },
								},
							]),
						]}
						renderField={({ name, value, onChange, chrome }) => (
							<textarea
								id={`field-${name}`}
								aria-labelledby={chrome.labelledBy}
								value={typeof value === "string" ? value : ""}
								onChange={(event) => onChange(event.target.value)}
							/>
						)}
					/>
				</div>,
			);

			await screen.getByRole("button", { name: "Testimonials", exact: true }).click();
			const scroller = screen.getByTestId("scroller").element();
			const bounds = scroller.getBoundingClientRect();
			expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
			for (const control of [
				screen.getByRole("button", { name: "Add block", exact: true }),
				screen.getByRole("button", { name: "Testimonials actions" }),
				screen.getByRole("button", { name: "Add item" }),
				screen.getByRole("button", { name: `${quote} actions` }),
			]) {
				const box = control.element().getBoundingClientRect();
				expect(box.left).toBeGreaterThanOrEqual(bounds.left);
				expect(box.right).toBeLessThanOrEqual(bounds.right);
			}
		},
	);
});

describe("Block picker position", () => {
	it("opens next to the control that adds the block", async () => {
		const screen = await renderField(
			<div style={{ width: 480, marginInline: 80 }}>
				<Field
					value={[
						{ _type: "statement", _version: 1, _key: "one", title: "One" },
						{ _type: "statement", _version: 1, _key: "two", title: "Two" },
					]}
					blockTypes={[blockType("statement", "Statement")]}
				/>
			</div>,
		);

		showGutters();
		const add = screen.getByRole("button", { name: "Add block below" }).first();
		await add.click();
		const addBox = add.element().getBoundingClientRect();
		const picker = screen.getByRole("dialog", { name: "Add block" });
		await expect
			.poll(() => Math.abs(picker.element().getBoundingClientRect().left - addBox.left))
			.toBeLessThan(2);
		const pickerBox = picker.element().getBoundingClientRect();
		expect(
			Math.min(Math.abs(pickerBox.top - addBox.bottom), Math.abs(addBox.top - pickerBox.bottom)),
		).toBeLessThan(8);
		await userEvent.keyboard("{Escape}");
	});
});
