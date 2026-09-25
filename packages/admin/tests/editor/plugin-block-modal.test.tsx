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
	{
		type: "test.cards",
		pluginId: "test-blocks",
		label: "Test Cards",
		fields: [
			{
				type: "text_input",
				action_id: "heading",
				label: "Heading",
			},
			{
				type: "repeater",
				action_id: "cards",
				label: "Cards",
				item_label: "card",
				fields: [{ type: "text_input", action_id: "title", label: "Title" }],
			},
		],
	},
];

async function openCardsBlockWithStoredString(
	onChange: NonNullable<PortableTextEditorProps["onChange"]>,
) {
	const screen = await render(
		<PortableTextEditor
			value={[
				{
					_type: "test.cards",
					_key: "cards-1",
					heading: "Before",
					cards: "First card\nSecond card",
				},
			]}
			onChange={onChange}
			pluginBlocks={pluginBlocks}
		/>,
	);
	await screen.getByRole("button", { name: "Edit" }).click();
	await expect.element(screen.getByRole("dialog")).toBeVisible();
	return screen;
}

function lastSavedCardsBlock(onChange: ReturnType<typeof vi.fn>) {
	const blocks = onChange.mock.lastCall?.[0] as Array<Record<string, unknown>> | undefined;
	return blocks?.find((block) => block._type === "test.cards");
}

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

	it("keeps a repeater's stored non-list value through an unrelated edit and save", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const screen = await openCardsBlockWithStoredString(onChange);

		await expect
			.element(screen.getByLabelText("Cards", { exact: true }))
			.toHaveValue("First card\nSecond card");
		await expect.element(screen.getByRole("alert")).toBeVisible();
		expect(screen.getByRole("button", { name: "Add card" }).query()).toBeNull();

		const heading = screen.getByRole("textbox").first();
		await expect.element(heading).toHaveValue("Before");
		await heading.fill("After");
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		await vi.waitFor(() => {
			expect(lastSavedCardsBlock(onChange)).toMatchObject({
				heading: "After",
				cards: "First card\nSecond card",
			});
		});
	});

	it("replaces a repeater's stored non-list value only through the replace action", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const screen = await openCardsBlockWithStoredString(onChange);

		screen.getByRole("button", { name: "Replace with empty list" }).element().click();

		await expect.element(screen.getByText("No items yet")).toBeVisible();
		expect(screen.getByRole("alert").query()).toBeNull();
		screen.getByRole("button", { name: "Save", exact: true }).element().click();

		await vi.waitFor(() => {
			expect(lastSavedCardsBlock(onChange)).toMatchObject({ heading: "Before", cards: [] });
		});
	});
});
