import * as React from "react";
import { describe, it, expect, vi } from "vitest";

import { SaveButton } from "../../src/components/SaveButton";
import { render } from "../utils/render.tsx";

describe("SaveButton", () => {
	it("shows 'Save' when dirty and not saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("shows 'Saving...' when saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={true} />);
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
	});

	it("can show saving feedback without blocking manual save", async () => {
		const screen = await render(
			<SaveButton isDirty={true} isSaving={true} disableWhileSaving={false} />,
		);
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeEnabled();
	});

	it("shows disabled 'Save' when clean and not saving", async () => {
		const screen = await render(<SaveButton isDirty={false} isSaving={false} />);
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("has aria-busy when saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={true} />);
		await expect.element(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
	});

	it("does not have aria-busy when not saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		await expect.element(screen.getByRole("button")).toHaveAttribute("aria-busy", "false");
	});

	it("has an aria-live status region", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		const status = screen.container.querySelector('span[role="status"][aria-live="polite"]');
		expect(status).not.toBeNull();
	});

	it("can suppress the aria-live status region", async () => {
		const screen = await render(
			<SaveButton isDirty={true} isSaving={false} announceStatus={false} />,
		);
		expect(screen.container.querySelector('span[role="status"][aria-live="polite"]')).toBeNull();
	});

	it("announces the transient saved pulse after saving completes", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		const getStatus = () =>
			screen.container.querySelector('span[role="status"][aria-live="polite"]')?.textContent ?? "";
		const status = screen.container.querySelector('span[role="status"][aria-live="polite"]');
		expect(status).not.toBeNull();

		await screen.rerender(<SaveButton isDirty={true} isSaving={true} />);
		await vi.waitFor(() => expect(getStatus()).toBe("Saving..."), { timeout: 500 });

		await screen.rerender(<SaveButton isDirty={false} isSaving={false} />);
		await vi.waitFor(() => expect(getStatus()).toBe("Saved"), { timeout: 600 });
		const savedSlot = [...screen.container.querySelectorAll('span[aria-hidden="true"]')].find(
			(element) => element.textContent?.trim() === "Saved",
		) as HTMLElement | undefined;
		expect(savedSlot?.style.color).toBe("var(--text-color-kumo-success)");
		expect(savedSlot?.querySelector("svg")).not.toBeNull();
		await vi.waitFor(() => expect(getStatus()).toBe(""), { timeout: 1200 });
	});

	it("does not announce a save when edits are reverted", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		const getStatus = () =>
			screen.container.querySelector('span[role="status"][aria-live="polite"]')?.textContent ?? "";

		await screen.rerender(<SaveButton isDirty={false} isSaving={false} />);

		expect(getStatus()).toBe("");
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("announces a successful save when clean state arrives later", async () => {
		const screen = await render(
			<SaveButton isDirty={true} isSaving={false} saveCompletionToken={0} />,
		);
		const getStatus = () =>
			screen.container.querySelector('span[role="status"][aria-live="polite"]')?.textContent ?? "";

		await screen.rerender(<SaveButton isDirty={true} isSaving={true} saveCompletionToken={0} />);
		await vi.waitFor(() => expect(getStatus()).toBe("Saving..."), { timeout: 500 });

		await screen.rerender(<SaveButton isDirty={true} isSaving={false} saveCompletionToken={1} />);
		expect(getStatus()).toBe("");

		await screen.rerender(<SaveButton isDirty={false} isSaving={false} saveCompletionToken={1} />);
		await vi.waitFor(() => expect(getStatus()).toBe("Saved"), { timeout: 600 });
	});

	it("drops a pending completion when the edited entry changes", async () => {
		const screen = await render(
			<SaveButton isDirty={true} isSaving={true} saveCompletionToken={0} saveScope="post-1" />,
		);
		const getStatus = () =>
			screen.container.querySelector('span[role="status"][aria-live="polite"]')?.textContent ?? "";

		await screen.rerender(
			<SaveButton isDirty={true} isSaving={false} saveCompletionToken={1} saveScope="post-1" />,
		);
		await screen.rerender(
			<SaveButton isDirty={false} isSaving={false} saveCompletionToken={0} saveScope="post-2" />,
		);

		expect(getStatus()).toBe("");
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("respects external disabled prop", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} disabled={true} />);
		await expect.element(screen.getByRole("button")).toBeDisabled();
	});
});
