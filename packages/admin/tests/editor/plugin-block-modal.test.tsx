import type { Editor } from "@tiptap/react";
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

/** Opens the editing modal of the only block in `value`, stored with `_key` unless it is null. */
async function openHeroBlock(
	onChange: NonNullable<PortableTextEditorProps["onChange"]>,
	key: string | null = "hero-1",
) {
	let editor: Editor | null = null;
	const hero = { _type: "test.hero", heading: "Before", ...(key === null ? {} : { _key: key }) };
	const screen = await render(
		<PortableTextEditor
			value={[hero] as PortableTextEditorProps["value"]}
			onChange={onChange}
			onEditorReady={(instance) => {
				editor = instance;
			}}
			pluginBlocks={pluginBlocks}
		/>,
	);
	await screen.getByRole("button", { name: "Edit" }).click();
	await expect.element(screen.getByRole("dialog")).toBeVisible();
	return { screen, editor: editor! };
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

	it("saves to the block it opened after a block is inserted above it", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const { screen, editor } = await openHeroBlock(onChange);

		editor.commands.insertContentAt(0, {
			type: "pluginBlock",
			attrs: { blockType: "test.hero", id: "", data: { heading: "Above" } },
		});
		const dialog = screen.getByRole("dialog");
		await dialog.getByRole("textbox").fill("After");
		dialog.getByRole("button", { name: "Save", exact: true }).element().click();

		await vi.waitFor(() => {
			expect(onChange.mock.lastCall?.[0]).toEqual([
				expect.objectContaining({ _type: "test.hero", heading: "Above" }),
				expect.objectContaining({ _type: "test.hero", _key: "hero-1", heading: "After" }),
			]);
		});
		await expect.element(dialog).not.toBeInTheDocument();
	});

	it("stays open with the input when its block was deleted", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const { screen, editor } = await openHeroBlock(onChange);

		editor.commands.deleteRange({ from: 0, to: editor.state.doc.firstChild!.nodeSize });
		const dialog = screen.getByRole("dialog");
		await dialog.getByRole("textbox").fill("After");
		dialog.getByRole("button", { name: "Save", exact: true }).element().click();

		await expect
			.element(dialog.getByRole("alert"))
			.toHaveTextContent("This block was deleted, so your changes can't be saved.");
		await expect.element(dialog.getByRole("textbox")).toHaveValue("After");
		expect(JSON.stringify(onChange.mock.calls)).not.toContain("After");
	});

	it("writes nothing when it opens and closes on a block stored without a key", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const { screen, editor } = await openHeroBlock(onChange, null);
		const opened = editor.getJSON();

		const dialog = screen.getByRole("dialog");
		dialog.getByRole("button", { name: "Cancel" }).element().click();

		await expect.element(dialog).not.toBeInTheDocument();
		expect(editor.getJSON()).toEqual(opened);
		expect(opened.content?.[0]?.attrs?.emdashPortableTextKey).toBeNull();
		expect(onChange).not.toHaveBeenCalled();
	});

	it("saves to a block stored without a key after a block is inserted above it, and keys it", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		const { screen, editor } = await openHeroBlock(onChange, null);

		editor.commands.insertContentAt(0, {
			type: "pluginBlock",
			attrs: { blockType: "test.hero", id: "", data: { heading: "Above" } },
		});
		const dialog = screen.getByRole("dialog");
		await dialog.getByRole("textbox").fill("After");
		dialog.getByRole("button", { name: "Save", exact: true }).element().click();

		await expect.element(dialog).not.toBeInTheDocument();
		const edited = editor.state.doc.child(1);
		expect(edited.attrs.data).toEqual({ heading: "After" });
		expect(edited.attrs.emdashPortableTextKey).toEqual(expect.any(String));
		expect(onChange.mock.lastCall?.[0]).toEqual([
			expect.objectContaining({ _type: "test.hero", heading: "Above" }),
			expect.objectContaining({
				_type: "test.hero",
				_key: edited.attrs.emdashPortableTextKey,
				heading: "After",
			}),
		]);
	});

	it("saves to the block it opened when another block has the same key", async () => {
		const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
		let editor: Editor | null = null;
		const screen = await render(
			<PortableTextEditor
				value={[
					{ _type: "test.hero", _key: "dup", heading: "First" },
					{ _type: "test.hero", _key: "dup", heading: "Second" },
				]}
				onChange={onChange}
				onEditorReady={(instance) => {
					editor = instance;
				}}
				pluginBlocks={pluginBlocks}
			/>,
		);
		await screen.getByRole("button", { name: "Edit" }).nth(1).click();
		const dialog = screen.getByRole("dialog");
		await expect.element(dialog).toBeVisible();
		await dialog.getByRole("textbox").fill("After");
		dialog.getByRole("button", { name: "Save", exact: true }).element().click();

		await expect.element(dialog).not.toBeInTheDocument();
		expect(editor!.state.doc.child(0).attrs.data).toEqual({ heading: "First" });
		expect(editor!.state.doc.child(1).attrs.data).toEqual({ heading: "After" });
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
