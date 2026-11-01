import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import {
	PortableTextEditor,
	type PortableTextEditorProps,
} from "../../src/components/PortableTextEditor";
import { pressOutside } from "../utils/mouse.ts";
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

const URL_ERROR = "Enter a full URL, such as https://example.com.";

const pluginBlocks: NonNullable<PortableTextEditorProps["pluginBlocks"]> = [
	{
		type: "test.embed",
		pluginId: "test-blocks",
		label: "Zebra Video",
		placeholder: "Paste a video URL",
	},
	{
		type: "test.hero",
		pluginId: "test-blocks",
		label: "Test Hero",
		fields: [
			{ type: "text_input", action_id: "heading", label: "Heading" },
			{ type: "number_input", action_id: "columns", label: "Columns", min: 1, max: 4 },
		],
	},
];

/**
 * Presses the bottom corner of the page, outside the dialog, with real mouse input.
 * A press over the editor never reaches the dialog as a press outside, so this stays below it.
 */
async function editBlock(block: Record<string, unknown>) {
	const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
	const screen = await render(
		<PortableTextEditor
			value={[{ _key: "block-1", ...block } as never]}
			onChange={onChange}
			pluginBlocks={pluginBlocks}
		/>,
	);
	const edit = screen.getByRole("button", { name: "Edit" });
	await expect.element(edit).toBeVisible();
	await edit.click();
	const dialog = screen.getByRole("dialog");
	await expect.element(dialog).toBeVisible();
	return { screen, dialog, onChange };
}

/** Inserts the URL-only block from the slash menu, which is the only way its dialog opens. */
async function insertEmbed() {
	const onChange = vi.fn<NonNullable<PortableTextEditorProps["onChange"]>>();
	const screen = await render(
		<PortableTextEditor
			value={[
				{
					_type: "block",
					_key: "intro",
					style: "normal",
					markDefs: [],
					children: [{ _type: "span", _key: "intro-span", text: "Intro", marks: [] }],
				},
			]}
			onChange={onChange}
			pluginBlocks={pluginBlocks}
		/>,
	);
	const paragraph = await vi.waitFor(() => {
		const element = document.querySelector(".ProseMirror p");
		expect(element).toBeTruthy();
		return element as HTMLElement;
	});
	await userEvent.click(paragraph);
	await userEvent.keyboard("{End}{Enter}/zebra");
	await vi.waitFor(() =>
		expect(document.querySelector("[data-slash-command-menu]")?.textContent).toContain(
			"Zebra Video",
		),
	);
	await userEvent.keyboard("{Enter}");
	const dialog = screen.getByRole("dialog", { name: "Insert Zebra Video" });
	await expect.element(dialog).toBeVisible();
	return { screen, dialog, onChange };
}

function savedBlock(onChange: ReturnType<typeof vi.fn>, type: string) {
	const blocks = onChange.mock.lastCall?.[0] as Array<Record<string, unknown>> | undefined;
	return blocks?.find((block) => block._type === type);
}

describe("plugin block modal errors", () => {
	it("points at a missing or invalid URL when inserted, and inserts nothing", async () => {
		const { dialog, onChange } = await insertEmbed();
		const url = dialog.getByRole("textbox", { name: "URL", exact: true });
		const insert = dialog.getByRole("button", { name: "Insert", exact: true });

		await expect.element(dialog).toHaveAccessibleDescription("Paste the address of what to embed.");
		await expect.element(insert).toBeEnabled();
		await insert.click();
		await expect.element(url).toHaveAccessibleDescription(URL_ERROR);
		await expect.element(url).toHaveAttribute("aria-invalid", "true");
		await expect.element(url).toHaveFocus();

		await url.fill("example.com/video");
		await userEvent.keyboard("{Enter}");
		await expect.element(url).toHaveAccessibleDescription(URL_ERROR);
		await expect.element(dialog).toBeVisible();
		expect(savedBlock(onChange, "test.embed")).toBeUndefined();

		await url.fill("javascript:alert(1)");
		await userEvent.keyboard("{Enter}");
		await expect.element(url).toHaveAccessibleDescription(URL_ERROR);
		expect(savedBlock(onChange, "test.embed")).toBeUndefined();

		await url.fill("at://did:plc:abc/app.bsky.feed.post/3k");
		await expect.element(url).not.toHaveAttribute("aria-invalid");
		await userEvent.keyboard("{Enter}");
		await vi.waitFor(() =>
			expect(savedBlock(onChange, "test.embed")).toMatchObject({
				id: "at://did:plc:abc/app.bsky.feed.post/3k",
			}),
		);
	});

	it("asks for at least one value before saving an emptied block", async () => {
		const { dialog, onChange } = await editBlock({ _type: "test.hero", heading: "Before" });
		const heading = dialog.getByRole("textbox", { name: "Heading" });
		await heading.fill("");
		await dialog.getByRole("button", { name: "Save", exact: true }).click();

		await expect
			.element(dialog.getByRole("alert").filter({ hasText: "Fill in at least one field." }))
			.toBeVisible();
		await expect.element(heading).toHaveFocus();
		expect(savedBlock(onChange, "test.hero")).toBeUndefined();

		await heading.fill("After");
		expect(dialog.getByText("Fill in at least one field.").query()).toBeNull();
	});

	it("points at a number outside the field's range", async () => {
		const { dialog, onChange } = await editBlock({
			_type: "test.hero",
			heading: "Before",
			columns: 2,
		});
		const columns = dialog.getByRole("spinbutton", { name: "Columns" });
		await columns.fill("9");
		await dialog.getByRole("button", { name: "Save", exact: true }).click();

		await expect.element(dialog.getByText("Enter a number between 1 and 4.")).toBeVisible();
		await expect.element(columns).toHaveAttribute("aria-invalid", "true");
		await expect.element(columns).toHaveAccessibleDescription("Enter a number between 1 and 4.");
		await expect.element(columns).toHaveFocus();
		expect(savedBlock(onChange, "test.hero")).toBeUndefined();

		await columns.fill("3");
		expect(dialog.getByText("Enter a number between 1 and 4.").query()).toBeNull();
		await dialog.getByRole("button", { name: "Save", exact: true }).click();
		await vi.waitFor(() =>
			expect(savedBlock(onChange, "test.hero")).toMatchObject({ heading: "Before", columns: 3 }),
		);
	});

	it("keeps an edit through a press outside, and closes when nothing changed", async () => {
		const { screen, dialog } = await editBlock({ _type: "test.hero", heading: "Before" });

		await pressOutside("bottom");
		await expect.element(dialog).not.toBeInTheDocument();

		await screen.getByRole("button", { name: "Edit" }).click();
		await expect.element(dialog).toBeVisible();
		await dialog.getByRole("textbox", { name: "Heading" }).fill("After");
		await pressOutside("bottom");
		await expect.element(dialog).toBeVisible();
		await expect.element(dialog.getByRole("textbox", { name: "Heading" })).toHaveValue("After");

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
	});
});
