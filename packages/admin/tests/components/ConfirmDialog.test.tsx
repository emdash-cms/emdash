import { Checkbox } from "@cloudflare/kumo";
import * as React from "react";
import { describe, expect, it, vi } from "vitest";
import { cdp, page, userEvent } from "vitest/browser";

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

const undoableProps = {
	undoable: true,
	title: "Move to Trash?",
	description: "You can restore it later.",
	confirmLabel: "Move to Trash",
	pendingLabel: "Moving to trash...",
} satisfies Partial<ConfirmDialogProps>;

function afterBaseUiFocus() {
	return new Promise<void>((resolve) =>
		requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
	);
}

async function heldEnterRepeats(count: number) {
	const session = cdp();
	const enter = {
		key: "Enter",
		code: "Enter",
		windowsVirtualKeyCode: 13,
		nativeVirtualKeyCode: 13,
	};
	for (let i = 0; i < count; i++) {
		await session.send("Input.dispatchKeyEvent", {
			type: "keyDown",
			...enter,
			text: "\r",
			unmodifiedText: "\r",
			autoRepeat: true,
		});
	}
	await session.send("Input.dispatchKeyEvent", { type: "keyUp", ...enter });
}

function OpenButtonHarness(overrides: Partial<ConfirmDialogProps>) {
	const [open, setOpen] = React.useState(false);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Open
			</button>
			<ConfirmDialog
				{...props(overrides)}
				open={open}
				onClose={() => {
					overrides.onClose?.();
					setOpen(false);
				}}
				onConfirm={() => {
					overrides.onConfirm?.();
					setOpen(false);
				}}
			/>
		</>
	);
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

	it("opens on Confirm for an undoable action, so Enter confirms", async () => {
		const onConfirm = vi.fn();
		const screen = await render(<ConfirmDialog {...props({ ...undoableProps, onConfirm })} />);

		await expect.element(screen.getByRole("button", { name: "Move to Trash" })).toHaveFocus();
		await userEvent.keyboard("{Enter}");

		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it.each(["ltr", "rtl"] as const)(
		"opens on Cancel for a permanent action, so Enter only closes it (%s)",
		async (dir) => {
			document.documentElement.dir = dir;
			try {
				const onClose = vi.fn();
				const onConfirm = vi.fn();
				const screen = await render(<ConfirmDialog {...props({ onClose, onConfirm })} />);

				await expect.element(screen.getByRole("button", { name: "Cancel" })).toHaveFocus();
				await userEvent.keyboard("{Enter}");

				await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
				expect(onConfirm).not.toHaveBeenCalled();
			} finally {
				document.documentElement.dir = "ltr";
			}
		},
	);

	it("confirms with a second Enter after opening from the keyboard", async () => {
		const onConfirm = vi.fn();
		const screen = await render(<OpenButtonHarness {...undoableProps} onConfirm={onConfirm} />);
		screen.getByRole("button", { name: "Open" }).element().focus();

		await userEvent.keyboard("{Enter}");
		await expect.element(screen.getByRole("button", { name: "Move to Trash" })).toHaveFocus();
		await userEvent.keyboard("{Enter}");

		expect(onConfirm).toHaveBeenCalledTimes(1);
	});

	it.each([
		["an undoable action closed with Escape", undoableProps, "Move to Trash", "{Escape}"],
		["a permanent action closed with Enter on Cancel", {}, "Cancel", "{Enter}"],
	] as const)(
		"returns focus to the button that opened it, for %s",
		async (_name, kind, focused, key) => {
			const screen = await render(<OpenButtonHarness {...kind} />);
			const open = screen.getByRole("button", { name: "Open" });

			await open.click();
			await expect.element(screen.getByRole("button", { name: focused })).toHaveFocus();
			await userEvent.keyboard(key);

			await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
			await expect.element(open).toHaveFocus();
		},
	);

	it.each([
		["an undoable action", undoableProps, "Move to Trash", "onConfirm"],
		["a permanent action", {}, "Cancel", "onClose"],
	] as const)(
		"ignores Enter held from the button that opened it, then acts on the next press, for %s",
		async (_name, kind, focused, acts) => {
			const callbacks = { onConfirm: vi.fn(), onClose: vi.fn() };
			const screen = await render(<OpenButtonHarness {...kind} {...callbacks} />);
			screen.getByRole("button", { name: "Open" }).element().focus();

			await userEvent.keyboard("{Enter}");
			await expect.element(screen.getByRole("button", { name: focused })).toHaveFocus();
			await heldEnterRepeats(3);
			await afterBaseUiFocus();

			await expect.element(page.getByRole("dialog")).toBeVisible();
			expect(callbacks.onConfirm).not.toHaveBeenCalled();
			expect(callbacks.onClose).not.toHaveBeenCalled();

			await userEvent.keyboard("{Enter}");
			await vi.waitFor(() => expect(callbacks[acts]).toHaveBeenCalledTimes(1));
			const other = acts === "onConfirm" ? callbacks.onClose : callbacks.onConfirm;
			expect(other).not.toHaveBeenCalled();
		},
	);

	it("focuses Confirm again when it reopens before its close animation ends", async () => {
		const dialog = (open: boolean) => (
			<>
				<button type="button">Outside</button>
				<ConfirmDialog {...props({ ...undoableProps, open })} />
			</>
		);
		const screen = await render(dialog(true));
		const confirm = screen.getByRole("button", { name: "Move to Trash" });
		await expect.element(confirm).toHaveFocus();
		const popup = page.getByRole("dialog").element();

		await screen.rerender(dialog(false));
		expect(popup.isConnected).toBe(true);
		screen.getByRole("button", { name: "Outside" }).element().focus();
		await screen.rerender(dialog(true));

		await expect.element(confirm).toHaveFocus();
		expect(page.getByRole("dialog").element()).toBe(popup);
	});

	it("leaves focus on the dialog while its confirm button waits on required input", async () => {
		const onClose = vi.fn();
		const onConfirm = vi.fn();
		await render(
			<ConfirmDialog {...props({ ...undoableProps, confirmDisabled: true, onClose, onConfirm })}>
				<Checkbox label="I understand" />
			</ConfirmDialog>,
		);
		const dialog = page.getByRole("dialog", { name: "Move to Trash?" });

		await expect.element(dialog).toHaveFocus();
		await afterBaseUiFocus();
		expect(document.activeElement).toBe(dialog.element());
		await userEvent.keyboard("{Enter}");
		await afterBaseUiFocus();

		expect(onConfirm).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("keeps focus that already moved inside the dialog", async () => {
		const screen = await render(
			<ConfirmDialog {...props(undoableProps)}>
				<input aria-label="Reason" autoFocus />
			</ConfirmDialog>,
		);
		const reason = screen.getByRole("textbox", { name: "Reason" });

		await expect.element(reason).toHaveFocus();
		await afterBaseUiFocus();
		await expect.element(reason).toHaveFocus();
	});
});
