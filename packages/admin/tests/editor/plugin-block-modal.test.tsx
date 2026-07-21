import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { render } from "../utils/render";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

const pluginBlocks: NonNullable<PortableTextEditorProps["pluginBlocks"]> = [
	{
		type: "test.hero",
		pluginId: "test-blocks",
		label: "Test Hero",
		fields: [
			{
				type: "text_input",
				action_id: "heading",
				label: "Heading",
			},
		],
	},
];

describe("plugin block modal", () => {
	it("saves an edited block without submitting the surrounding content form", async () => {
		const onPageSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const screen = await render(
			<form onSubmit={onPageSubmit}>
				<PortableTextEditor
					value={[
						{
							_type: "test.hero",
							_key: "hero-1",
							heading: "Before",
						},
					]}
					onChange={onChange}
					pluginBlocks={pluginBlocks}
				/>
			</form>,
		);

		const editButton = screen.getByRole("button", { name: "Edit" });
		await expect.element(editButton).toBeVisible();
		await editButton.click();

		const heading = screen.getByRole("textbox");
		await expect.element(heading).toHaveValue("Before");
		await heading.fill("After");
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		expect(onPageSubmit).not.toHaveBeenCalled();
		await vi.waitFor(() => {
			const savedBlocks = onChange.mock.lastCall?.[0];
			expect(savedBlocks).toEqual(
				expect.arrayContaining([
					expect.objectContaining({
						_type: "test.hero",
						heading: "After",
					}),
				]),
			);
		});
	});
});
