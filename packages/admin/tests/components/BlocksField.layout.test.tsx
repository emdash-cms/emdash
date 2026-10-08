import { Input } from "@cloudflare/kumo";
import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField } from "../../src/components/BlocksField.js";
import type { BlockType } from "../../src/lib/api/schema.js";
import { render } from "../utils/render.js";

function blockType(slug: string, label: string, description?: string): BlockType {
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
				fields: [{ slug: "title", label: "Title", type: "string" }],
				fingerprint: `${slug}-v1`,
				active: true,
				createdAt: "2026-01-01T00:00:00.000Z",
				updatedAt: "2026-01-01T00:00:00.000Z",
			},
		],
	};
}

describe("Block picker layout", () => {
	it("wraps a long block type description inside its own column", async () => {
		const description =
			"A full-width section with a heading, a paragraph of supporting copy and two call-to-action buttons";
		const screen = await render(
			<div style={{ width: 640 }}>
				<BlocksField
					id="field-layout"
					fieldPath="layout"
					label="Layout"
					value={[]}
					onChange={() => {}}
					blockTypes={[blockType("hero", "Hero", description), blockType("quote", "Quote")]}
					allowedTypes={["hero", "quote"]}
					retiredTypes={[]}
					renderField={() => null}
				/>
			</div>,
		);

		await userEvent.click(screen.getByRole("button", { name: "Add block" }));
		const hero = screen.getByRole("button", { name: /^Hero/ }).element();
		const quote = screen.getByRole("button", { name: "Quote" }).element();
		const heroBox = hero.getBoundingClientRect();

		expect(heroBox.right).toBeLessThanOrEqual(quote.getBoundingClientRect().left);
		expect(hero.scrollWidth).toBeLessThanOrEqual(Math.ceil(heroBox.width));
	});
});

describe("Block card layout", () => {
	it.each(["ltr", "rtl"] as const)(
		"fits a phone-width column and truncates a long summary at its end (%s)",
		async (dir) => {
			const statement =
				"An independent design studio making identities, books and websites for culture and commerce.";
			const screen = await render(
				<div data-testid="column" dir={dir} style={{ width: 360 }}>
					<BlocksField
						id="field-layout"
						fieldPath="layout"
						label="Layout"
						value={[{ _type: "statement", _version: 1, _key: "statement", title: statement }]}
						onChange={() => {}}
						blockTypes={[blockType("statement", "Statement")]}
						allowedTypes={["statement"]}
						retiredTypes={[]}
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

			const column = screen.getByTestId("column").element();
			const columnBox = column.getBoundingClientRect();
			expect(column.querySelectorAll("[data-block-key]")).toHaveLength(1);
			expect(column.querySelectorAll("input")).toHaveLength(1);
			for (const element of column.querySelectorAll("[data-block-key], button, input")) {
				const box = element.getBoundingClientRect();
				expect(box.left).toBeGreaterThanOrEqual(Math.floor(columnBox.left));
				expect(box.right).toBeLessThanOrEqual(Math.ceil(columnBox.right));
			}

			const summary = screen.getByText(statement).element();
			const summaryBox = summary.getBoundingClientRect();
			const firstCharacter = document.createRange();
			firstCharacter.setStart(summary.firstChild!, 0);
			firstCharacter.setEnd(summary.firstChild!, 1);
			const firstCharacterBox = firstCharacter.getBoundingClientRect();
			expect(summary.scrollWidth).toBeGreaterThan(summary.clientWidth);
			expect(firstCharacterBox.left).toBeGreaterThanOrEqual(Math.floor(summaryBox.left));
			expect(firstCharacterBox.right).toBeLessThanOrEqual(Math.ceil(summaryBox.right));
		},
	);

	it("aligns a short left-to-right summary under its label in a right-to-left admin", async () => {
		const screen = await render(
			<div dir="rtl" style={{ width: 360 }}>
				<BlocksField
					id="field-layout"
					fieldPath="layout"
					label="Layout"
					value={[{ _type: "statement", _version: 1, _key: "statement", title: "Hello" }]}
					onChange={() => {}}
					blockTypes={[blockType("statement", "Statement")]}
					allowedTypes={["statement"]}
					retiredTypes={[]}
					renderField={() => null}
				/>
			</div>,
		);

		const label = screen.getByText("Statement").element().getBoundingClientRect();
		const summaryText = document.createRange();
		summaryText.selectNodeContents(screen.getByText("Hello").element());
		expect(summaryText.getBoundingClientRect().right).toBeCloseTo(label.right, 0);
	});

	it("wraps a long one-word block type label before the block actions", async () => {
		const label = "Kundenreferenzenkarussellvorlage";
		const screen = await render(
			<div style={{ width: 360 }}>
				<BlocksField
					id="field-layout"
					fieldPath="layout"
					label="Layout"
					value={[{ _type: "testimonials", _version: 1, _key: "testimonials" }]}
					onChange={() => {}}
					blockTypes={[blockType("testimonials", label)]}
					allowedTypes={["testimonials"]}
					retiredTypes={[]}
					renderField={() => null}
				/>
			</div>,
		);

		const labelBox = screen.getByText(label).element().getBoundingClientRect();
		const duplicate = screen.getByRole("button", { name: "Duplicate block" }).element();
		expect(labelBox.right).toBeLessThanOrEqual(duplicate.getBoundingClientRect().left);
	});
});
