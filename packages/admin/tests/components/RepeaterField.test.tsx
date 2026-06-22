import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { RepeaterField } from "../../src/components/RepeaterField";
import { render } from "../utils/render.tsx";

describe("RepeaterField", () => {
	describe("datetime sub-field", () => {
		it("displays a stored ISO datetime in the datetime-local input", async () => {
			// Mirrors the top-level datetime widget contract: full ISO 8601
			// values must round-trip through `<input type="datetime-local">`,
			// which only accepts `YYYY-MM-DDTHH:mm`.
			const screen = await render(
				<RepeaterField
					label="Recalls"
					id="recalls"
					value={[{ recall_date: "2026-02-26T09:30:00.000Z" }]}
					onChange={vi.fn()}
					subFields={[{ slug: "recall_date", type: "datetime", label: "Recall date" }]}
				/>,
			);
			const input = screen.getByLabelText("Recall date");
			await expect.element(input).toHaveValue("2026-02-26T09:30");
		});

		it("emits a full ISO 8601 value with Z and milliseconds on change", async () => {
			const onChange = vi.fn();
			const screen = await render(
				<RepeaterField
					label="Recalls"
					id="recalls"
					value={[{ recall_date: "" }]}
					onChange={onChange}
					subFields={[{ slug: "recall_date", type: "datetime", label: "Recall date" }]}
				/>,
			);
			const input = screen.getByLabelText("Recall date");
			await input.fill("2026-02-26T09:30");

			expect(onChange).toHaveBeenLastCalledWith([
				expect.objectContaining({ recall_date: "2026-02-26T09:30:00.000Z" }),
			]);
		});
	});
});

/**
 * Image sub-field support (issue #1424): rows render the media picker
 * (ImageFieldRenderer) instead of falling through to a plain text input.
 */
describe("RepeaterField sub-field types", () => {
	it("renders the media picker for image sub-fields", async () => {
		const screen = await render(
			<RepeaterField
				label="Gallery"
				id="gallery"
				value={[{ image: null, caption: "" }]}
				onChange={vi.fn()}
				subFields={[
					{ slug: "image", type: "image", label: "Image" },
					{ slug: "caption", type: "string", label: "Caption" },
				]}
			/>,
		);

		// Image sub-field → picker button, not a text input.
		await expect.element(screen.getByRole("button", { name: /Select image/ })).toBeVisible();
		// Scalar sub-fields keep their plain inputs.
		await expect.element(screen.getByRole("textbox", { name: "Caption" })).toBeVisible();
	});

	it("shows the existing image preview for media values", async () => {
		const screen = await render(
			<RepeaterField
				label="Gallery"
				id="gallery"
				value={[
					{
						image: {
							id: "m1",
							provider: "local",
							alt: "",
							meta: { storageKey: "01ABC.png" },
						},
					},
				]}
				onChange={vi.fn()}
				subFields={[{ slug: "image", type: "image", label: "Image" }]}
			/>,
		);

		// MediaValue with a storageKey renders the local-media preview image.
		await expect
			.element(screen.container.querySelector('img[src="/_emdash/api/media/file/01ABC.png"]'))
			.toBeInTheDocument();
	});

	it("initializes image sub-fields as null when adding an item", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<RepeaterField
				label="Gallery"
				id="gallery"
				value={[]}
				onChange={onChange}
				subFields={[
					{ slug: "image", type: "image", label: "Image" },
					{ slug: "caption", type: "string", label: "Caption" },
				]}
			/>,
		);

		await screen.getByRole("button", { name: /Add First Item/ }).click();

		expect(onChange).toHaveBeenCalledWith([{ image: null, caption: "" }]);
	});
});
