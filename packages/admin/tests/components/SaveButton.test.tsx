import * as React from "react";
import { describe, it, expect } from "vitest";
import { render } from "../utils/render.js";

import { SaveButton } from "../../src/components/SaveButton";

describe("SaveButton", () => {
	it("shows 'Save' when dirty and not saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		await expect.element(screen.getByText("Save")).toBeInTheDocument();
		await expect.element(screen.getByRole("button")).toBeEnabled();
	});

	it("shows 'Saving...' when saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={true} />);
		await expect.element(screen.getByText("Saving...")).toBeInTheDocument();
		await expect.element(screen.getByRole("button")).toBeDisabled();
	});

	it("shows 'Saved' when not dirty and not saving", async () => {
		const screen = await render(<SaveButton isDirty={false} isSaving={false} />);
		await expect.element(screen.getByText("Saved")).toBeInTheDocument();
		await expect.element(screen.getByRole("button")).toBeDisabled();
	});

	it("has aria-busy when saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={true} />);
		await expect.element(screen.getByRole("button")).toHaveAttribute("aria-busy", "true");
	});

	it("does not have aria-busy when not saving", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		await expect.element(screen.getByRole("button")).toHaveAttribute("aria-busy", "false");
	});

	it("has aria-live polite", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} />);
		await expect.element(screen.getByRole("button")).toHaveAttribute("aria-live", "polite");
	});

	it("respects external disabled prop", async () => {
		const screen = await render(<SaveButton isDirty={true} isSaving={false} disabled={true} />);
		await expect.element(screen.getByRole("button")).toBeDisabled();
	});
});
