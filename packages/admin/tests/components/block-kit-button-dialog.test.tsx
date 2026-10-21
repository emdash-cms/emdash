import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import "../../dist/styles.css";
import { ButtonElementComponent } from "../../../blocks/src/elements/button.js";
import type { ButtonElement } from "../../../blocks/src/types.js";

const element = {
	type: "button",
	label: "Delete",
	action_id: "delete",
	value: "item-1",
	style: "danger",
	confirm: {
		style: "danger",
		title: "Delete this item?",
		text: "This permanently removes it.",
		confirm: "Delete",
		deny: "Cancel",
	},
} satisfies ButtonElement;

describe("Block Kit button confirmation dialog", () => {
	afterEach(() => {
		document.documentElement.removeAttribute("dir");
	});

	it.each(["ltr", "rtl"])("insets content and waits for confirmation in %s", async (direction) => {
		document.documentElement.dir = direction;
		const onAction = vi.fn();
		const screen = await render(<ButtonElementComponent element={element} onAction={onAction} />);
		await screen.getByRole("button", { name: "Delete", exact: true }).click();

		const dialog = screen.getByRole("dialog");
		await expect.element(dialog).toBeVisible();
		expect(onAction).not.toHaveBeenCalled();

		await expect.poll(() => dialog.element().getAnimations().length).toBe(0);
		const bounds = dialog.element().getBoundingClientRect();
		for (const content of [
			screen.getByRole("heading", { name: element.confirm.title }).element(),
			screen.getByText(element.confirm.text).element(),
			dialog.getByRole("button", { name: "Delete", exact: true }).element(),
			dialog.getByRole("button", { name: "Cancel" }).element(),
		]) {
			const contentBounds = content.getBoundingClientRect();
			expect(contentBounds.left - bounds.left).toBeGreaterThanOrEqual(24);
			expect(bounds.right - contentBounds.right).toBeGreaterThanOrEqual(24);
			expect(contentBounds.top - bounds.top).toBeGreaterThanOrEqual(24);
			expect(bounds.bottom - contentBounds.bottom).toBeGreaterThanOrEqual(24);
		}

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		expect(onAction).not.toHaveBeenCalled();

		await screen.getByRole("button", { name: "Delete", exact: true }).click();
		await dialog.getByRole("button", { name: "Delete", exact: true }).click();
		await expect.element(dialog).not.toBeInTheDocument();
		expect(onAction).toHaveBeenCalledExactlyOnceWith({
			type: "block_action",
			action_id: "delete",
			value: "item-1",
		});
	});
});
