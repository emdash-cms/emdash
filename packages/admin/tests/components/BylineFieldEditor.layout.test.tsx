import { afterEach, describe, expect, it } from "vitest";
import { page } from "vitest/browser";

import "../../dist/styles.css";
import { BylineFieldEditor } from "../../src/components/BylineFieldEditor.js";
import type { BylineFieldDefinition } from "../../src/lib/api/byline-fields.js";
import { adminRoot, formControlSpill } from "../utils/form-layout.js";
import { render } from "../utils/render.js";

const existingField: BylineFieldDefinition = {
	id: "field_01",
	slug: "job_title",
	label: "Job title",
	type: "string",
	required: false,
	translatable: true,
	validation: null,
	sortOrder: 0,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
};

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("BylineFieldEditor layout", () => {
	it("fits the dialog's controls inside it without overlap on a phone", async () => {
		await page.viewport(390, 844);
		const screen = await render(
			<BylineFieldEditor open onOpenChange={() => {}} field={existingField} onSave={() => {}} />,
			{ container: adminRoot() },
		);
		await expect.element(screen.getByLabelText("Slug", { exact: true })).toBeVisible();

		const { controls, overlap, outside } = formControlSpill(screen.getByRole("dialog").element());
		expect(controls).toBeGreaterThanOrEqual(2);
		expect(overlap).toBe(0);
		expect(outside).toBeLessThanOrEqual(0.5);
	});

	it.each([
		[
			"an error",
			undefined,
			"A slug cannot be generated from this label. Type one manually using lowercase letters, numbers, and underscores.",
		],
		["its hint", existingField, "Slugs cannot be changed after the field is created."],
	] as const)(
		"keeps the Label input in line with the Slug input when the slug shows %s",
		async (_, field, note) => {
			const screen = await render(
				<BylineFieldEditor open onOpenChange={() => {}} field={field} onSave={() => {}} />,
				{ container: adminRoot() },
			);
			if (!field) await screen.getByLabelText("Label", { exact: true }).fill("!!!");
			await expect.element(screen.getByText(note)).toBeVisible();
			const label = screen.getByLabelText("Label", { exact: true }).element();
			const slug = screen.getByLabelText("Slug", { exact: true }).element();

			expect(label.getBoundingClientRect().top).toBeCloseTo(slug.getBoundingClientRect().top, 0);
		},
	);
});
