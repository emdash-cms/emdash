import * as React from "react";
import { describe, it, expect } from "vitest";

import { SaveButton } from "../../src/components/SaveButton";
import { render } from "../utils/render.tsx";

describe("SaveButton", () => {
	it("shows 'Save' when dirty and not saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("transitions to Saving while save progress is active", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={true} />);
		const button = screen.getByRole("button", { name: "Saving..." });
		await expect.element(button).toBeDisabled();
		await expect.element(button).toHaveAttribute("aria-busy", "true");
		expect(screen.getByRole("status").element().textContent).toBe("Saving...");
	});

	it("transitions to Saved when clean", async () => {
		const screen = await render(<SaveButton isDirty={false} isSaving={false} />);
		const button = screen.getByRole("button", { name: "Saved" });
		await expect.element(button).toBeDisabled();
		expect(screen.getByRole("status").element().textContent).toBe("Saved");
	});

	it("has aria-busy when saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={true} />);
		await expect.element(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
	});

	it("does not have aria-busy when not saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		await expect.element(screen.getByRole("button")).toHaveAttribute("aria-busy", "false");
	});

	it("can render without a second live region", async () => {
		const screen = await render(<SaveButton isDirty={false} isSaving={false} announce={false} />);
		await expect.element(screen.getByRole("button", { name: "Saved" })).toBeInTheDocument();
		expect(screen.container.querySelector('span[role="status"][aria-live="polite"]')).toBeNull();
	});

	it("keeps one fixed-width button across Save, Saving, and Saved states", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		const getLabelWidth = () =>
			screen.container
				.querySelector<HTMLElement>("[data-save-button-labels]")!
				.getBoundingClientRect().width;
		const dirtyWidth = getLabelWidth();

		await screen.rerender(<SaveButton isDirty={true} isSaving={true} />);
		const savingWidth = getLabelWidth();
		await screen.rerender(<SaveButton isDirty={false} isSaving={false} />);
		const savedWidth = getLabelWidth();

		expect(dirtyWidth).toBeGreaterThan(0);
		expect(savingWidth).toBeCloseTo(dirtyWidth);
		expect(savedWidth).toBeCloseTo(dirtyWidth);
	});

	it("runs the exit, content swap, and enter sequence", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		const states = screen.container.querySelectorAll("[data-save-button-state]");
		expect(states).toHaveLength(3);
		const visibleState = () =>
			screen.container.querySelector<HTMLElement>("[data-save-button-visible-state]")!;
		expect(visibleState()).toHaveAttribute("data-save-button-visible-state", "save");

		await screen.rerender(<SaveButton isDirty={true} isSaving={true} />);
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
		await expect.element(visibleState()).toHaveClass("is-exit");
		expect(visibleState()).toHaveAttribute("data-save-button-visible-state", "save");

		await new Promise((resolve) => window.setTimeout(resolve, 200));
		expect(visibleState()).toHaveAttribute("data-save-button-visible-state", "saving");
		expect(visibleState()).not.toHaveClass("is-exit");
		expect(visibleState()).not.toHaveClass("is-enter-start");
	});

	it("respects external disabled prop", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} disabled={true} />);
		await expect.element(screen.getByRole("button")).toBeDisabled();
	});
});
