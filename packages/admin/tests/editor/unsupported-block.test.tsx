import type { Editor } from "@tiptap/react";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { PORTABLE_TEXT_BLOCK_ATTR } from "../../src/components/editor/portableTextIdentity.js";
import { PortableTextEditor } from "../../src/components/PortableTextEditor.js";
import { render } from "../utils/render.js";

import "../../dist/styles.css";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: () => null,
}));

vi.mock("../../src/components/SectionPickerModal", () => ({
	SectionPickerModal: () => null,
}));

vi.mock("../../src/components/editor/DragHandleWrapper", () => ({
	DragHandleWrapper: () => null,
}));

const buttonsBlock = {
	_type: "buttons",
	_key: "buttons-1",
	layout: "horizontal",
	buttons: [
		{
			_type: "button",
			_key: "button-1",
			text: "Official results",
			url: "https://example.com/results",
			style: "default",
		},
	],
};

function pasteBlockThroughHtml(editor: Editor) {
	editor.commands.setNodeSelection(0);
	const { dom } = editor.view.serializeForClipboard(editor.state.selection.content());
	editor.commands.clearContent();
	editor.commands.focus("start");
	const clipboardData = new DataTransfer();
	clipboardData.setData("text/html", dom.innerHTML);
	editor.view.dom.dispatchEvent(
		new ClipboardEvent("paste", { clipboardData, bubbles: true, cancelable: true }),
	);
}

describe("unsupported blocks", () => {
	it("does not offer URL editing for imported buttons and preserves them when editing surrounding text", async () => {
		const onChange = vi.fn();
		let editor: Editor | undefined;
		const screen = await render(
			<PortableTextEditor
				onEditorReady={(instance) => {
					editor = instance;
				}}
				value={[
					buttonsBlock,
					{
						_type: "block",
						_key: "paragraph-1",
						style: "normal",
						children: [{ _type: "span", _key: "span-1", text: "Before", marks: [] }],
						markDefs: [],
					},
				]}
				onChange={onChange}
			/>,
		);

		await expect.element(screen.getByText("Buttons", { exact: true })).toBeVisible();
		expect(screen.getByRole("button", { name: "Edit URL", exact: true }).query()).toBeNull();
		await expect
			.element(
				screen.getByText("No editor is available for this block type. Its content is preserved."),
			)
			.toBeVisible();

		await vi.waitFor(() => expect(editor).toBeDefined());
		editor!.chain().focus("end").insertContent("After").run();
		await vi.waitFor(() => {
			const saved = onChange.mock.lastCall?.[0] as Array<Record<string, unknown>> | undefined;
			expect(saved?.find((block) => block._type === "buttons")).toEqual(buttonsBlock);
		});
	});

	it("allows deleting unsupported blocks without offering URL actions", async () => {
		const onChange = vi.fn();
		const screen = await render(<PortableTextEditor value={[buttonsBlock]} onChange={onChange} />);

		await expect.element(screen.getByText("Buttons", { exact: true })).toBeVisible();
		for (const name of ["Edit URL", "Copy URL", "Open in new tab"]) {
			expect(screen.getByRole("button", { name, exact: true }).query()).toBeNull();
		}
		screen.getByRole("button", { name: "Delete embed", exact: true }).element().click();
		await vi.waitFor(() => {
			expect(onChange).toHaveBeenCalled();
			const saved = onChange.mock.lastCall?.[0] as Array<Record<string, unknown>>;
			expect(saved.some((block) => block._type === "buttons")).toBe(false);
		});
	});

	it.each([
		{ _type: "embed", url: "https://example.com/embed" },
		{ _type: "file", url: "https://example.com/download.pdf" },
		{ _type: "embed", url: "" },
		{ _type: "test.embed", id: "https://example.com/embed" },
		{ ...buttonsBlock, id: "https://example.com/previously-saved-stray-id" },
	])("still edits an unregistered $_type block's existing identity", async (identity) => {
		const onChange = vi.fn();
		const block = { ...identity, _key: "url-block-1" };
		const screen = await render(<PortableTextEditor value={[block]} onChange={onChange} />);
		await expect
			.element(screen.getByRole("button", { name: "Edit URL", exact: true }))
			.toBeVisible();
		screen.getByRole("button", { name: "Edit URL", exact: true }).element().click();
		const input = screen.getByPlaceholder("Enter URL...");
		await input.fill("https://example.com/after");
		screen.getByRole("button", { name: "Save", exact: true }).element().click();
		await vi.waitFor(() => {
			const saved = onChange.mock.lastCall?.[0] as Array<Record<string, unknown>> | undefined;
			expect(saved?.find((item) => item._key === block._key)).toEqual({
				...block,
				...(Object.hasOwn(block, "url")
					? { url: "https://example.com/after" }
					: { id: "https://example.com/after" }),
			});
		});
	});

	it.each([
		{ _type: "embed", _key: "embed-1", url: "https://example.com/embed" },
		{ _type: "file", _key: "file-1", url: "https://example.com/download.pdf" },
	])(
		"keeps URL actions on an unregistered $_type after an HTML clipboard round-trip",
		async (block) => {
			let editor: Editor | undefined;
			const screen = await render(
				<PortableTextEditor
					value={[block]}
					onEditorReady={(instance) => {
						editor = instance;
					}}
				/>,
			);
			await vi.waitFor(() => expect(editor).toBeDefined());
			pasteBlockThroughHtml(editor!);
			await vi.waitFor(() => {
				const pasted = editor!.state.doc.firstChild!;
				expect(pasted.attrs[PORTABLE_TEXT_BLOCK_ATTR]).toBeNull();
				expect(pasted.attrs.id).toBe(block.url);
			});
			for (const name of ["Edit URL", "Copy URL", "Open in new tab"]) {
				await expect.element(screen.getByRole("button", { name, exact: true })).toBeVisible();
			}
			screen.getByRole("button", { name: "Edit URL", exact: true }).element().click();
			await screen.getByPlaceholder("Enter URL...").fill("https://example.com/after-paste");
			screen.getByRole("button", { name: "Save", exact: true }).element().click();
			screen.getByRole("button", { name: "Edit URL", exact: true }).element().click();
			await expect
				.element(screen.getByPlaceholder("Enter URL..."))
				.toHaveValue("https://example.com/after-paste");
		},
	);

	it("does not offer URL editing for buttons after an HTML clipboard round-trip", async () => {
		let editor: Editor | undefined;
		const screen = await render(
			<PortableTextEditor
				value={[buttonsBlock]}
				onEditorReady={(instance) => {
					editor = instance;
				}}
			/>,
		);
		await vi.waitFor(() => expect(editor).toBeDefined());
		pasteBlockThroughHtml(editor!);
		await vi.waitFor(() => {
			expect(editor!.state.doc.firstChild!.attrs[PORTABLE_TEXT_BLOCK_ATTR]).toBeNull();
			expect(editor!.state.doc.firstChild!.attrs.data.buttons).toEqual(buttonsBlock.buttons);
		});
		await expect.element(screen.getByText("Buttons", { exact: true })).toBeVisible();
		for (const name of ["Edit URL", "Copy URL", "Open in new tab"]) {
			expect(screen.getByRole("button", { name, exact: true }).query()).toBeNull();
		}
	});

	it("updates the available editor when a block definition arrives after mount", async () => {
		const value = [buttonsBlock];
		function LateDefinition() {
			const [registered, setRegistered] = React.useState(false);
			return (
				<>
					<button type="button" onClick={() => setRegistered(true)}>
						Register block
					</button>
					<PortableTextEditor
						value={value}
						pluginBlocks={
							registered
								? [
										{
											type: "buttons",
											pluginId: "test",
											label: "Custom Buttons",
											fields: [{ type: "text_input", action_id: "heading", label: "Heading" }],
										},
									]
								: []
						}
					/>
				</>
			);
		}
		const screen = await render(<LateDefinition />);
		await expect
			.element(
				screen.getByText("No editor is available for this block type. Its content is preserved."),
			)
			.toBeVisible();
		screen.getByRole("button", { name: "Register block", exact: true }).element().click();
		await expect.element(screen.getByText("Custom Buttons", { exact: true })).toBeVisible();
		screen.getByRole("button", { name: "Edit", exact: true }).element().click();
		await expect.element(screen.getByRole("dialog")).toBeVisible();
		await expect.element(screen.getByLabelText("Heading", { exact: true })).toBeVisible();
	});

	it("still edits the URL of a registered fieldless embed", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<PortableTextEditor
				value={[{ _type: "test.embed", _key: "embed-1", id: "https://example.com/before" }]}
				onChange={onChange}
				pluginBlocks={[{ type: "test.embed", pluginId: "test", label: "Test embed" }]}
			/>,
		);

		screen.getByRole("button", { name: "Edit URL", exact: true }).element().click();
		const input = screen.getByPlaceholder("Enter URL...");
		await expect.element(input).toHaveValue("https://example.com/before");
		await input.fill("https://example.com/after");
		screen.getByRole("button", { name: "Save", exact: true }).element().click();
		await vi.waitFor(() => {
			expect(onChange.mock.lastCall?.[0]).toEqual(
				expect.arrayContaining([
					expect.objectContaining({ _type: "test.embed", id: "https://example.com/after" }),
				]),
			);
		});
	});
});
