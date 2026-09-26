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

	it("renders a searchable combobox for select sub-fields", async () => {
		const screen = await render(
			<RepeaterField
				label="Services"
				id="services"
				value={[{ service: "CT" }]}
				onChange={vi.fn()}
				subFields={[
					{ slug: "service", type: "select", label: "Service", options: ["MRI", "CT", "PET"] },
				]}
			/>,
		);

		// Select sub-field → searchable typeahead input (role "combobox"),
		// not a plain native select, and it reflects the stored value.
		const input = screen.getByRole("combobox");
		await expect.element(input).toBeVisible();
		await expect.element(input).toHaveValue("CT");
	});
});

describe("RepeaterField bulk collapse", () => {
describe("RepeaterField bulk collapse", () => {
	const captionSubFields = [{ slug: "caption", type: "string", label: "Caption" }];

	const subFieldInputs = (screen: { container: HTMLElement }) => [
		...screen.container.querySelectorAll('input[id^="gallery."]'),
	];

	it("collapses every row at once and offers to expand them again", async () => {
		const screen = await render(
			<RepeaterField
				label="Gallery"
				id="gallery"
				value={[{ caption: "One" }, { caption: "Two" }, { caption: "Three" }]}
				onChange={vi.fn()}
				subFields={captionSubFields}
			/>,
		);

		// Rows start expanded, so the editor sees the inputs they can edit.
		expect(subFieldInputs(screen)).toHaveLength(3);

		await screen.getByRole("button", { name: "Collapse all" }).click();

		expect(subFieldInputs(screen)).toHaveLength(0);
		// Summaries stay on screen, so the rows can still be told apart.
		await expect.element(screen.getByText("One")).toBeVisible();
		await expect.element(screen.getByText("Three")).toBeVisible();

		await screen.getByRole("button", { name: "Expand all" }).click();

		expect(subFieldInputs(screen)).toHaveLength(3);
	});

	it("keeps offering Collapse all while any row is still open", async () => {
		const screen = await render(
			<RepeaterField
				label="Gallery"
				id="gallery"
				value={[{ caption: "One" }, { caption: "Two" }]}
				onChange={vi.fn()}
				subFields={captionSubFields}
			/>,
		);

		// Collapse one row through its own header; the rest stay open, so the
		// useful bulk action is still to collapse.
		await screen.getByText("One").click();

		expect(subFieldInputs(screen)).toHaveLength(1);
		await expect.element(screen.getByRole("button", { name: "Collapse all" })).toBeVisible();
	});

	it("opens a newly added row even when every row was collapsed", async () => {
		const screen = await render(
			<RepeaterField
				label="Gallery"
				id="gallery"
				value={[{ caption: "One" }]}
				onChange={vi.fn()}
				subFields={captionSubFields}
			/>,
		);

		await screen.getByRole("button", { name: "Collapse all" }).click();
		expect(subFieldInputs(screen)).toHaveLength(0);

		await screen.getByRole("button", { name: "Add Item" }).click();

		// The new row needs its inputs immediately, so it arrives expanded and
		// the bulk control flips back to collapsing.
		expect(subFieldInputs(screen)).toHaveLength(1);
		await expect.element(screen.getByRole("button", { name: "Collapse all" })).toBeVisible();
	});

	it("offers no bulk control while the repeater is empty", async () => {
		const screen = await render(
			<RepeaterField
				label="Gallery"
				id="gallery"
				value={[]}
				onChange={vi.fn()}
				subFields={captionSubFields}
			/>,
		);

		await expect.element(screen.getByRole("button", { name: "Add First Item" })).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Collapse all" }))
			.not.toBeInTheDocument();
	});
});
