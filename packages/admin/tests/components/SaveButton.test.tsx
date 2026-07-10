import * as React from "react";
import { describe, it, expect } from "vitest";

import { SaveButton, SaveStatus } from "../../src/components/SaveButton";
import { render } from "../utils/render.tsx";

describe("SaveButton", () => {
	it("shows 'Save' when dirty and not saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("keeps the Save label while showing manual-save progress", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={true} />);
		const button = screen.getByRole("button", { name: "Save" });
		await expect.element(button).toBeDisabled();
		await expect.element(button).toHaveAttribute("aria-busy", "true");
	});

	it("keeps the clean action labeled Save", async () => {
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

	it("shows a passive saving status", async () => {
		const screen = await render(<SaveStatus isDirty={true} isSaving={true} />);
		const status = screen.getByRole("status");
		expect(status.element().textContent).toBe("Saving...");
		await expect.element(status).toHaveAttribute("aria-live", "polite");
	});

	it("shows a persistent passive Saved status while clean", async () => {
		const screen = await render(<SaveStatus isDirty={false} isSaving={false} />);
		expect(screen.getByRole("status").element().textContent).toBe("Saved");
	});

	it("clears the passive status while dirty", async () => {
		const screen = await render(<SaveStatus isDirty={true} isSaving={false} />);
		expect(screen.getByRole("status").element().textContent).toBe("");
	});

	it("can render visible status without a second live region", async () => {
		const screen = await render(<SaveStatus isDirty={false} isSaving={false} announce={false} />);
		expect(screen.container.querySelector("[data-save-status-value]")?.textContent).toBe("Saved");
		expect(screen.container.querySelector('[role="status"]')).toBeNull();
	});

	it("reserves a stable width across dirty, saving, and saved states", async () => {
		const screen = await render(<SaveStatus isDirty={true} isSaving={false} />);
		const slot = screen.container.querySelector<HTMLElement>("[data-save-status-slot]");
		expect(slot).not.toBeNull();
		const dirtyWidth = slot!.getBoundingClientRect().width;

		await screen.rerender(<SaveStatus isDirty={true} isSaving={true} />);
		const savingWidth = slot!.getBoundingClientRect().width;
		await screen.rerender(<SaveStatus isDirty={false} isSaving={false} />);
		const savedWidth = slot!.getBoundingClientRect().width;

		expect(dirtyWidth).toBeGreaterThan(0);
		expect(savingWidth).toBeCloseTo(dirtyWidth);
		expect(savedWidth).toBeCloseTo(dirtyWidth);
	});

	it("respects external disabled prop", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} disabled={true} />);
		await expect.element(screen.getByRole("button")).toBeDisabled();
	});
});
