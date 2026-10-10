import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { FieldEditor } from "../../src/components/FieldEditor.js";
import type { SchemaField } from "../../src/lib/api";
import { focusRingClearance } from "../utils/focus-ring.js";
import { adminRoot, formControlSpill } from "../utils/form-layout.js";
import { render } from "../utils/render.js";

const existingField: SchemaField = {
	id: "field_01",
	collectionId: "col_01",
	slug: "title",
	label: "Title",
	type: "string",
	columnType: "TEXT",
	required: false,
	unique: false,
	searchable: false,
	indexed: false,
	sortOrder: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
};

async function openRepeaterWithUnsluggableSubField() {
	const screen = await render(<FieldEditor open onOpenChange={() => {}} onSave={() => {}} />, {
		container: adminRoot(),
	});
	screen
		.getByRole("button", { name: /^Repeater/ })
		.element()
		.click();
	await screen.getByLabelText("Label", { exact: true }).fill("Sections");
	screen.getByRole("button", { name: "Add Sub-Field" }).element().click();
	await screen.getByLabelText("Label", { exact: true }).nth(1).fill("!!!");
	await expect
		.element(screen.getByText("A slug cannot be generated from this label. Type one manually."))
		.toBeVisible();
	return screen;
}

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("FieldEditor layout", () => {
	it("fits the controls of the repeater dialog inside it without overlap on a phone", async () => {
		await page.viewport(390, 844);
		const screen = await openRepeaterWithUnsluggableSubField();

		const { controls, overlap, outside } = formControlSpill(screen.getByRole("dialog").element());
		expect(controls).toBeGreaterThanOrEqual(5);
		expect(overlap).toBe(0);
		expect(outside).toBeLessThanOrEqual(0.5);
	});

	it.each(["Short Text", "Number", "Blocks"])(
		"fits the controls of the %s field dialog inside it without overlap on a phone",
		async (type) => {
			await page.viewport(390, 844);
			const screen = await render(<FieldEditor open onOpenChange={() => {}} onSave={() => {}} />, {
				container: adminRoot(),
			});
			screen
				.getByRole("button", { name: new RegExp(`^${type}`) })
				.element()
				.click();
			await expect.element(screen.getByLabelText(/^Max/)).toBeVisible();

			const { controls, overlap, outside } = formControlSpill(screen.getByRole("dialog").element());
			expect(controls).toBeGreaterThanOrEqual(4);
			expect(overlap).toBe(0);
			expect(outside).toBeLessThanOrEqual(0.5);
		},
	);

	it("leaves room for the focus ring of inputs at the edges of the scrolling content", async () => {
		const screen = await openRepeaterWithUnsluggableSubField();
		for (const name of ["Label", "Slug"]) {
			const input = screen.getByLabelText(name, { exact: true }).first().element();
			(input as HTMLInputElement).focus();

			const { drawn, reach, room } = focusRingClearance(input);
			expect(drawn).toBe(true);
			expect(room).toBeGreaterThanOrEqual(reach);
		}
	});

	it("keeps sub-field controls in line and inside their columns when the slug shows an error", async () => {
		const screen = await openRepeaterWithUnsluggableSubField();
		const label = screen.getByLabelText("Label", { exact: true }).nth(1).element();
		const slug = screen.getByLabelText("Slug", { exact: true }).nth(1).element();
		const type = screen.getByRole("combobox", { name: "Type" }).element();
		const [labelBox, slugBox, typeBox] = [label, slug, type].map((el) =>
			el.getBoundingClientRect(),
		);

		expect(labelBox.top).toBeCloseTo(slugBox.top, 0);
		expect(typeBox.top).toBeCloseTo(slugBox.top, 0);
		expect(labelBox.right).toBeLessThanOrEqual(slugBox.left);
		expect(slugBox.right).toBeLessThanOrEqual(typeBox.left);
	});

	it.each([
		[
			"an error",
			undefined,
			"A slug cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.",
		],
		["its hint", existingField, "Field slugs cannot be changed after creation"],
	] as const)(
		"keeps the Label input in line with the Slug input when the slug shows %s",
		async (_, field, note) => {
			const screen = await render(
				<FieldEditor open onOpenChange={() => {}} field={field} onSave={() => {}} />,
				{ container: adminRoot() },
			);
			if (!field) {
				screen
					.getByRole("button", { name: /^Short Text/ })
					.element()
					.click();
				await screen.getByLabelText("Label", { exact: true }).fill("!!!");
			}
			await expect.element(screen.getByText(note)).toBeVisible();
			const label = screen.getByLabelText("Label", { exact: true }).element();
			const slug = screen.getByLabelText("Slug", { exact: true }).element();

			expect(label.getBoundingClientRect().top).toBeCloseTo(slug.getBoundingClientRect().top, 0);
		},
	);
});
