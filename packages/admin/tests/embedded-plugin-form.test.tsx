import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { userEvent } from "vitest/browser";

import { TextInputElementComponent } from "../../blocks/src/elements/text-input.js";
import { BlockRenderer } from "../../blocks/src/renderer.js";
import type { Block } from "../../blocks/src/types.js";

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

	it("keeps textarea newlines and IME confirmation separate from submission", async () => {
		const { screen, onAction, nativeSubmit } = await editor();
		const notes = screen.getByRole("textbox", { name: "Notes" });
		await notes.fill("First line");
		await userEvent.keyboard("{Enter}Second line");
		await expect.element(notes).toHaveValue("First line\nSecond line");
		const price = screen.getByRole("textbox", { name: "Price", exact: true }).element();
		const confirmation = new KeyboardEvent("keydown", {
			key: "Enter",
			isComposing: true,
			bubbles: true,
			cancelable: true,
		});
		expect(price.dispatchEvent(confirmation)).toBe(true);
		expect(onAction).not.toHaveBeenCalled();
		expect(nativeSubmit).not.toHaveBeenCalled();
	});

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
});
