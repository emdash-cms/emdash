import { Checkbox } from "@cloudflare/kumo";
import { describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { ConfirmDialog, type ConfirmDialogProps } from "../../src/components/ConfirmDialog.js";
import { render } from "../utils/render.tsx";

function props(overrides: Partial<ConfirmDialogProps> = {}): ConfirmDialogProps {
	return {
		open: true,
		onClose: vi.fn(),
		title: "Delete widget?",
		description: "This cannot be undone.",
		confirmLabel: "Delete",
		pendingLabel: "Deleting...",
		isPending: false,
		error: null,
		onConfirm: vi.fn(),
		...overrides,
	};
}

describe("ConfirmDialog", () => {
	it("refuses Cancel and Escape while its request runs", async () => {
		const onClose = vi.fn();
		const screen = await render(<ConfirmDialog {...props({ onClose, isPending: true })} />);
		const dialog = page.getByRole("dialog", { name: "Delete widget?" });
		await expect.element(dialog).toBeVisible();

		await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();
		await userEvent.keyboard("{Escape}");

		await new Promise((resolve) => setTimeout(resolve, 300));
		expect(onClose).not.toHaveBeenCalled();
		await expect.element(dialog).toBeVisible();
	});

	it("closes on Cancel when no request runs", async () => {
		const onClose = vi.fn();
		const screen = await render(<ConfirmDialog {...props({ onClose })} />);

		await screen.getByRole("button", { name: "Cancel" }).click();

		await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("sends one confirmation for a double press, and allows a retry after a failure", async () => {
		const onConfirm = vi.fn();
		const screen = await render(<ConfirmDialog {...props({ onConfirm })} />);
		const confirm = screen.getByRole("button", { name: "Delete" });
		await expect.element(confirm).toBeEnabled();

		// Both presses land before the pending state renders, as in a fast double click.
		confirm.element().click();
		confirm.element().click();
		expect(onConfirm).toHaveBeenCalledTimes(1);

		await screen.rerender(<ConfirmDialog {...props({ onConfirm, error: new Error("Boom") })} />);
		await expect.element(screen.getByText("Boom")).toBeVisible();
		await confirm.click();
		expect(onConfirm).toHaveBeenCalledTimes(2);
	});

	it("can be pressed again when a press started no request", async () => {
		const onConfirm = vi.fn();
		const screen = await render(<ConfirmDialog {...props({ onConfirm })} />);
		const confirm = screen.getByRole("button", { name: "Delete" });
		await expect.element(confirm).toBeEnabled();

		confirm.element().click();
		await new Promise((resolve) => setTimeout(resolve, 600));
		confirm.element().click();

		expect(onConfirm).toHaveBeenCalledTimes(2);
	});

	it("does not show an error left from an earlier request when it opens", async () => {
		const stale = new Error("Widget not found");
		const screen = await render(<ConfirmDialog {...props({ open: false, error: stale })} />);

		await screen.rerender(<ConfirmDialog {...props({ error: stale })} />);
		await expect.element(page.getByRole("dialog", { name: "Delete widget?" })).toBeVisible();
		expect(screen.getByText("Widget not found").query()).toBeNull();

		await screen.rerender(<ConfirmDialog {...props({ error: new Error("Widget is in use") })} />);
		await expect.element(screen.getByText("Widget is in use")).toBeVisible();
	});

	it.each(["dialog", "alertdialog"] as const)(
		"describes the %s by its message alone",
		async (role) => {
			const extra = <Checkbox label="Also delete its data" />;
			const screen = await render(<ConfirmDialog {...props({ role })}>{extra}</ConfirmDialog>);
			await screen.rerender(
				<ConfirmDialog {...props({ role, error: new Error("Widget is in use") })}>
					{extra}
				</ConfirmDialog>,
			);
			await expect.element(screen.getByText("Widget is in use")).toBeVisible();

			await expect
				.element(page.getByRole(role, { name: "Delete widget?" }))
				.toHaveAccessibleDescription("This cannot be undone.");
		},
	);

	it("brings focus back into the dialog when a failed request had dropped it", async () => {
		const screen = await render(<ConfirmDialog {...props()} />);
		const dialog = page.getByRole("dialog", { name: "Delete widget?" });
		const confirm = screen.getByRole("button", { name: "Delete" });
		await expect.element(confirm).toBeEnabled();
		confirm.element().focus();

		await screen.rerender(<ConfirmDialog {...props({ isPending: true })} />);
		await expect.element(screen.getByRole("button", { name: "Deleting..." })).toBeDisabled();
		// In the app the browser moves focus off the disabled button to the page.
		if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		expect(document.activeElement).toBe(document.body);

		await screen.rerender(<ConfirmDialog {...props({ error: new Error("Boom") })} />);
		await expect.element(screen.getByText("Boom")).toBeVisible();
		await vi.waitFor(() => expect(dialog.element().contains(document.activeElement)).toBe(true));
	});
});
