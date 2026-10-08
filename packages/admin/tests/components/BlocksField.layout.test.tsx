import { describe, expect, it } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { BlocksField } from "../../src/components/BlocksField.js";
import { RepeaterField } from "../../src/components/RepeaterField.js";
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
		"keeps a long repeater item title from widening the field (%s)",
		async (dir) => {
			const quoteFields = [{ slug: "quote", label: "Quote", type: "text" }];
			const quote =
				"We found more savings in the first month than in five years of energy audits, and the people who run our buildings finally trust the numbers they see every morning.";
			const screen = await render(
				<div dir={dir} data-testid="scroller" style={{ width: 640, overflow: "auto" }}>
					<BlocksField
						id="field-layout"
						fieldPath="layout"
						label="Layout"
						value={[{ _type: "testimonials", _version: 1, _key: "block-1", quotes: [{ quote }] }]}
						onChange={() => {}}
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
						allowedTypes={["testimonials"]}
						retiredTypes={[]}
						renderField={({ name, field, value, onChange }) => (
							<RepeaterField
								key={name}
								id={name}
								label={field.label ?? name}
								value={value}
								onChange={onChange}
								subFields={quoteFields}
							/>
						)}
					/>
				</div>,
			);

			const scroller = screen.getByTestId("scroller").element();
			const bounds = scroller.getBoundingClientRect();
			expect(scroller.scrollWidth).toBeLessThanOrEqual(scroller.clientWidth);
			for (const name of [
				"Add block",
				"Duplicate block",
				"Delete block",
				"Add Item",
				"Remove item 1",
			]) {
				const control = screen.getByRole("button", { name }).element().getBoundingClientRect();
				expect(control.left, name).toBeGreaterThanOrEqual(bounds.left);
				expect(control.right, name).toBeLessThanOrEqual(bounds.right);
			}
		},
	);
});
