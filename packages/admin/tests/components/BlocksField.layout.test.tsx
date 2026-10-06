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
