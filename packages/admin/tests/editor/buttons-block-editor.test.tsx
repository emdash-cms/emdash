import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { PortableTextEditor } from "../../src/components/PortableTextEditor.js";
import { render } from "../utils/render.js";

import "../../dist/styles.css";

vi.mock("../../src/components/MediaPickerModal", () => ({ MediaPickerModal: () => null }));
vi.mock("../../src/components/SectionPickerModal", () => ({ SectionPickerModal: () => null }));
vi.mock("../../src/components/editor/DragHandleWrapper", () => ({ DragHandleWrapper: () => null }));

type Block = Record<string, unknown>;

const importedButtons = {
	_type: "buttons",
	_key: "buttons-1",
	layout: "horizontal",
	buttons: [
		{
			_type: "button",
			_key: "button-1",
			text: "Official results",
			url: "https://example.com/results",
			style: "outline",
		},
	],
};

function savedButtons(onChange: ReturnType<typeof vi.fn>): Block | undefined {
	const blocks = onChange.mock.lastCall?.[0] as Block[] | undefined;
	return blocks?.find((block) => block._type === "buttons");
}

describe("Buttons block editor", () => {
	it("edits an imported button's text and URL without writing a stray id", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<PortableTextEditor value={[importedButtons]} onChange={onChange} />,
		);

		await screen.getByRole("button", { name: "Edit", exact: true }).click();
		await expect.element(screen.getByRole("dialog")).toBeVisible();
		await screen.getByRole("button", { name: "Official results" }).click();
		await screen.getByLabelText("Text", { exact: true }).fill("Final results");
		await screen.getByLabelText("URL", { exact: true }).fill("https://example.com/final");
		await screen.getByRole("button", { name: "Save", exact: true }).click();

		await vi.waitFor(() => {
			expect(savedButtons(onChange)).toEqual({
				...importedButtons,
				buttons: [
					{
						...importedButtons.buttons[0],
						text: "Final results",
						url: "https://example.com/final",
					},
				],
			});
		});
	});

	it("keeps each button's key when an earlier button is removed", async () => {
		const onChange = vi.fn();
		const archive = {
			_type: "button",
			_key: "button-2",
			text: "Archive",
			url: "https://example.com/archive",
		};
		const group = { ...importedButtons, buttons: [...importedButtons.buttons, archive] };
		const screen = await render(<PortableTextEditor value={[group]} onChange={onChange} />);

		await screen.getByRole("button", { name: "Edit", exact: true }).click();
		await screen.getByRole("button", { name: "Remove item 1" }).click();
		await screen.getByRole("button", { name: "Save", exact: true }).click();

		await vi.waitFor(() => {
			expect(savedButtons(onChange)).toEqual({ ...importedButtons, buttons: [archive] });
		});
	});

	it("clears a URL an older editor stored on the group when it is saved", async () => {
		const onChange = vi.fn();
		const strayGroup = { ...importedButtons, id: "https://example.com/stray" };
		const screen = await render(<PortableTextEditor value={[strayGroup]} onChange={onChange} />);

		await screen.getByRole("button", { name: "Edit", exact: true }).click();
		await screen.getByRole("button", { name: "Save", exact: true }).click();

		await vi.waitFor(() => {
			expect(savedButtons(onChange)?.id).toBe("");
		});
	});

	it("keeps a buttons value that isn't a list when the group is saved", async () => {
		const onChange = vi.fn();
		const legacy = { _type: "buttons", _key: "buttons-1", layout: "vertical", buttons: "Sign up" };
		const screen = await render(<PortableTextEditor value={[legacy]} onChange={onChange} />);

		await screen.getByRole("button", { name: "Edit", exact: true }).click();
		await screen.getByLabelText("Layout").click();
		await screen.getByRole("option", { name: "Horizontal" }).click();
		await screen.getByRole("button", { name: "Save", exact: true }).click();

		await vi.waitFor(() => {
			expect(savedButtons(onChange)).toMatchObject({ layout: "horizontal", buttons: "Sign up" });
		});
	});

	it("inserts a new buttons block from the slash menu", async () => {
		const onChange = vi.fn();
		const screen = await render(<PortableTextEditor onChange={onChange} />);
		document.querySelector<HTMLElement>(".ProseMirror")!.focus();
		await userEvent.keyboard("/buttons");
		await vi.waitFor(() =>
			expect(document.querySelector("[data-slash-command-menu]")).toBeTruthy(),
		);
		await userEvent.keyboard("{Enter}");

		await expect.element(screen.getByRole("dialog")).toBeVisible();
		await screen.getByRole("button", { name: "Add button" }).first().click();
		await screen.getByLabelText("Text", { exact: true }).fill("Sign up");
		await screen.getByLabelText("URL", { exact: true }).fill("https://example.com/signup");
		await screen.getByRole("button", { name: "Insert", exact: true }).click();

		await vi.waitFor(() => {
			expect(savedButtons(onChange)).toEqual({
				_type: "buttons",
				_key: expect.any(String),
				layout: "horizontal",
				buttons: [
					{
						_type: "button",
						_key: expect.any(String),
						text: "Sign up",
						url: "https://example.com/signup",
					},
				],
			});
		});
	});

	it("defers to a plugin that registers its own buttons block", async () => {
		const screen = await render(
			<PortableTextEditor
				value={[importedButtons]}
				pluginBlocks={[
					{
						type: "buttons",
						pluginId: "test",
						label: "Plugin Buttons",
						fields: [{ type: "text_input", action_id: "heading", label: "Heading" }],
					},
				]}
			/>,
		);

		await expect.element(screen.getByText("Plugin Buttons", { exact: true })).toBeVisible();
		await screen.getByRole("button", { name: "Edit", exact: true }).click();
		await expect.element(screen.getByLabelText("Heading", { exact: true })).toBeVisible();
	});
});
