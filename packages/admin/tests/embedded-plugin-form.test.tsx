import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page, userEvent } from "vitest/browser";

import "../dist/styles.css";
import { TextInputElementComponent } from "../../blocks/src/elements/text-input.js";
import { renderElement } from "../../blocks/src/render-element.js";
import { BlockRenderer } from "../../blocks/src/renderer.js";
import type { Block, FormField } from "../../blocks/src/types.js";

const blocks: Block[] = [
	{
		type: "form",
		block_id: "pricing",
		fields: [
			{ type: "text_input", action_id: "price", label: "Price", initial_value: "$0.05" },
			{ type: "text_input", action_id: "notes", label: "Notes", multiline: true },
		],
		submit: { label: "Save price", action_id: "save_price" },
	},
	{
		type: "form",
		block_id: "limit",
		fields: [{ type: "number_input", action_id: "limit", label: "Limit", min: 1, max: 10 }],
		submit: { label: "Save limit", action_id: "save_limit" },
	},
];

let submitListener: (event: Event) => void;
afterEach(() => document.removeEventListener("submit", submitListener, true));

async function editor() {
	const onAction = vi.fn();
	const outerSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
	const onNativeSubmit = vi.fn((event: Event) => event.preventDefault());
	submitListener = onNativeSubmit;
	document.addEventListener("submit", submitListener, true);
	const screen = await render(
		<form onSubmit={outerSubmit}>
			<label>
				Editor title
				<input required />
			</label>
			<BlockRenderer blocks={blocks} onAction={onAction} />
			<button type="submit">Save article</button>
		</form>,
	);
	return { screen, onAction, outerSubmit, nativeSubmit: onNativeSubmit };
}

describe("embedded plugin forms in Chromium", () => {
	it("submits typed values by button and Enter without submitting or validating the editor", async () => {
		const { screen, onAction, outerSubmit, nativeSubmit } = await editor();
		await screen.getByRole("textbox", { name: "Price", exact: true }).fill("$0.10");
		await screen.getByRole("button", { name: "Save price", exact: true }).click();
		expect(onAction).toHaveBeenCalledExactlyOnceWith({
			type: "form_submit",
			block_id: "pricing",
			action_id: "save_price",
			values: { price: "$0.10" },
		});
		onAction.mockClear();
		await screen.getByRole("textbox", { name: "Price", exact: true }).fill("$0.25");
		await userEvent.keyboard("{Enter}");
		expect(onAction).toHaveBeenCalledExactlyOnceWith({
			type: "form_submit",
			block_id: "pricing",
			action_id: "save_price",
			values: { price: "$0.25" },
		});
		expect(outerSubmit).not.toHaveBeenCalled();
		expect(nativeSubmit).not.toHaveBeenCalled();
		expect(screen.getByRole("textbox", { name: "Editor title" }).element()).toBeInvalid();
	});

	it("validates only the selected plugin form and keeps sibling values independent", async () => {
		const { screen, onAction } = await editor();
		await screen.getByRole("spinbutton", { name: "Limit" }).fill("11");
		await screen.getByRole("button", { name: "Save limit" }).click();
		expect(onAction).not.toHaveBeenCalled();
		await userEvent.keyboard("{Enter}");
		expect(onAction).not.toHaveBeenCalled();
		await screen.getByRole("textbox", { name: "Price", exact: true }).fill("$0.50");
		await screen.getByRole("button", { name: "Save price", exact: true }).click();
		expect(onAction).toHaveBeenCalledExactlyOnceWith({
			type: "form_submit",
			block_id: "pricing",
			action_id: "save_price",
			values: { price: "$0.50" },
		});
		onAction.mockClear();
		await screen.getByRole("spinbutton", { name: "Limit" }).fill("5");
		await userEvent.keyboard("{Enter}");
		expect(onAction).toHaveBeenCalledExactlyOnceWith({
			type: "form_submit",
			block_id: "limit",
			action_id: "save_limit",
			values: { limit: 5 },
		});
	});

	it("keeps textarea newlines separate from submission", async () => {
		const { screen, onAction, nativeSubmit } = await editor();
		const notes = screen.getByRole("textbox", { name: "Notes" });
		await notes.fill("First line");
		await userEvent.keyboard("{Enter}Second line");
		await expect.element(notes).toHaveValue("First line\nSecond line");
		expect(onAction).not.toHaveBeenCalled();
		expect(nativeSubmit).not.toHaveBeenCalled();
	});

	it.each([
		{ isComposing: true, keyCode: 13 },
		{ isComposing: false, keyCode: 229 },
	])(
		"ignores IME confirmation with isComposing=$isComposing and keyCode=$keyCode, then submits on Enter",
		async ({ isComposing, keyCode }) => {
			const { screen, onAction, outerSubmit, nativeSubmit } = await editor();
			const price = screen.getByRole("textbox", { name: "Price", exact: true });
			await price.fill("日本語");
			const confirmation = new KeyboardEvent("keydown", {
				key: "Enter",
				isComposing,
				keyCode,
				bubbles: true,
				cancelable: true,
			});
			price.element().dispatchEvent(confirmation);
			expect(onAction).not.toHaveBeenCalled();
			expect(confirmation.defaultPrevented).toBe(false);
			expect(outerSubmit).not.toHaveBeenCalled();
			expect(nativeSubmit).not.toHaveBeenCalled();

			await userEvent.keyboard("{Enter}");
			expect(onAction).toHaveBeenCalledExactlyOnceWith({
				type: "form_submit",
				block_id: "pricing",
				action_id: "save_price",
				values: { price: "日本語" },
			});
			expect(outerSubmit).not.toHaveBeenCalled();
			expect(nativeSubmit).not.toHaveBeenCalled();
		},
	);

	it("renders valid form structure inside the editor", async () => {
		await editor();
		expect(document.querySelector("form form")).toBeNull();
	});

	it("does not let invalid plugin values block saving the article", async () => {
		const { screen, outerSubmit } = await editor();
		await screen.getByRole("textbox", { name: "Editor title" }).fill("Article title");
		await screen.getByRole("spinbutton", { name: "Limit" }).fill("11");
		await screen.getByRole("button", { name: "Save article" }).click();
		expect(outerSubmit).toHaveBeenCalledOnce();
	});

	it("keeps native date, secret and combobox inputs out of the editor form", async () => {
		const onAction = vi.fn();
		const screen = await render(
			<form>
				<TextInputElementComponent
					element={{ type: "text_input", action_id: "outside", label: "Editor field" }}
					onAction={onAction}
				/>
				<BlockRenderer
					blocks={[
						{
							type: "form",
							fields: [
								{ type: "date_input", action_id: "date", label: "Date" },
								{ type: "secret_input", action_id: "token", label: "Token", has_value: false },
								{
									type: "combobox",
									action_id: "choice",
									label: "Choice",
									options: [{ label: "First", value: "first" }],
								},
							],
							submit: { label: "Save settings", action_id: "save_settings" },
						},
					]}
					onAction={onAction}
				/>
			</form>,
		);
		const date = document.querySelector<HTMLInputElement>('input[type="date"]')!;
		const secret = screen.getByLabelText("Token").element() as HTMLInputElement;
		const choice = screen.getByRole("combobox").element() as HTMLInputElement;
		expect(date.form).toBeNull();
		expect(secret.form).toBeNull();
		expect(choice.form).toBeNull();
		expect(
			(screen.getByLabelText("Editor field").element() as HTMLInputElement).form,
		).not.toBeNull();
		await userEvent.fill(date, "2026-10-15");
		await screen.getByLabelText("Token").fill("local-fixture-token");
		await screen.getByRole("button", { name: "Save settings" }).click();
		expect(onAction).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				type: "form_submit",
				values: { date: "2026-10-15", token: "local-fixture-token" },
			}),
		);
		onAction.mockClear();
		date.focus();
		await userEvent.keyboard("{Enter}");
		expect(onAction).toHaveBeenCalledExactlyOnceWith(
			expect.objectContaining({
				type: "form_submit",
				values: { date: "2026-10-15", token: "local-fixture-token" },
			}),
		);
	});

	it("isolates select input ownership and preserves choice control values", async () => {
		const fields: FormField[] = [
			{
				type: "select",
				action_id: "choice",
				label: "Choice",
				initial_value: "first",
				options: [
					{ label: "First", value: "first" },
					{ label: "Second", value: "second" },
				],
			},
			{
				type: "checkbox",
				action_id: "checks",
				label: "Checks",
				options: [{ label: "Include", value: "included" }],
			},
			{
				type: "radio",
				action_id: "radio",
				label: "Radio choice",
				initial_value: "first",
				options: [
					{ label: "Radio first", value: "first" },
					{ label: "Radio second", value: "second" },
				],
			},
			{ type: "toggle", action_id: "enabled", label: "Enabled", initial_value: false },
		];
		const onAction = vi.fn();
		const standaloneAction = vi.fn();
		const outerSubmit = vi.fn((event: React.FormEvent) => event.preventDefault());
		const nativeSubmit = vi.fn((event: Event) => event.preventDefault());
		submitListener = nativeSubmit;
		document.addEventListener("submit", submitListener, true);
		const screen = await render(
			<form id="editor" onSubmit={outerSubmit}>
				<input name="article" defaultValue="Article title" />
				<div data-testid="standalone-choices">
					{fields.map((field) => (
						<div key={field.action_id}>{renderElement(field, standaloneAction)}</div>
					))}
				</div>
				<BlockRenderer
					blocks={[
						{
							type: "form",
							block_id: "choices",
							fields,
							submit: { label: "Save controls", action_id: "save_choices" },
						},
					]}
					onAction={onAction}
				/>
				<button type="submit">Save article</button>
			</form>,
		);
		const group = screen.getByRole("group", { name: "Save controls", exact: true });
		const standalone = screen.getByTestId("standalone-choices").element();
		const owner = document.getElementById("editor") as HTMLFormElement;
		const nativeStandalone = standalone.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
			"input, select",
		);
		expect(nativeStandalone.length).toBeGreaterThanOrEqual(4);
		for (const control of nativeStandalone) expect(control.form).toBe(owner);
		expect((standalone.querySelector('[role="switch"]') as HTMLButtonElement).form).toBe(owner);
		const nativeSelect = group
			.getByRole("combobox")
			.element()
			.parentElement!.querySelector<HTMLInputElement>("input");
		const toggle = group.getByRole("switch", { name: "Enabled" });
		expect(nativeSelect).not.toBeNull();
		expect(nativeSelect!.form).toBeNull();
		await group.getByRole("combobox").click();
		await page.getByRole("option", { name: "Second", exact: true }).click();
		await group.getByRole("checkbox", { name: "Include" }).click();
		await group.getByRole("radio", { name: "Radio second" }).click();
		await toggle.click();
		expect(onAction).not.toHaveBeenCalled();
		await group.getByRole("button", { name: "Save controls" }).click();
		expect(onAction).toHaveBeenCalledExactlyOnceWith({
			type: "form_submit",
			block_id: "choices",
			action_id: "save_choices",
			values: { choice: "second", checks: ["included"], radio: "second", enabled: true },
		});
		expect(standaloneAction).not.toHaveBeenCalled();
		expect(outerSubmit).not.toHaveBeenCalled();
		expect(nativeSubmit).not.toHaveBeenCalled();
		expect([...new FormData(owner)]).toEqual([["article", "Article title"]]);
		expect(owner.checkValidity()).toBe(true);
		await screen.getByRole("button", { name: "Save article" }).click();
		expect(outerSubmit).toHaveBeenCalledOnce();
	});
});
