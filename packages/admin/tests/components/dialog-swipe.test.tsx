import * as React from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { cdp, page } from "vitest/browser";

import "../../dist/styles.css";
import { BylineFormDialog } from "../../src/components/BylineFormDialog.js";
import { ConfirmDialog } from "../../src/components/ConfirmDialog.js";
import { EditorDraftPatchPreview } from "../../src/components/EditorDraftPatchPreview.js";
import { RelationDialog } from "../../src/components/RelationDialog.js";
import type { SchemaCollection } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api/users", async () => {
	const actual =
		await vi.importActual<typeof import("../../src/lib/api/users")>("../../src/lib/api/users");
	return { ...actual, fetchUsers: vi.fn().mockResolvedValue({ items: [] }) };
});

vi.mock("../../src/lib/api/byline-fields", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api/byline-fields")>(
		"../../src/lib/api/byline-fields",
	);
	return { ...actual, listBylineFields: vi.fn().mockResolvedValue({ items: [] }) };
});

/** Pulls the sheet down by its title with real touch input, as a finger would. */
async function swipeDown(title: Element) {
	const session = cdp();
	// Touch input lands in the top-level page, which hosts this test's frame.
	const frame = window.frameElement?.getBoundingClientRect() ?? new DOMRect();
	const scale = frame.width ? frame.width / window.innerWidth : 1;
	const box = title.getBoundingClientRect();
	const x = frame.left + (box.left + 20) * scale;
	const y = frame.top + (box.top + 6) * scale;
	await session.send("Emulation.setTouchEmulationEnabled", { enabled: true });
	await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x, y }] });
	for (let step = 1; step <= 20; step++) {
		await session.send("Input.dispatchTouchEvent", {
			type: "touchMove",
			touchPoints: [{ x, y: y + step * 25 * scale }],
		});
		await new Promise((resolve) => setTimeout(resolve, 16));
	}
	await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
	await session.send("Emulation.setTouchEmulationEnabled", { enabled: false });
}

async function openSheet(name: string) {
	const dialog = page.getByRole("dialog", { name });
	await expect.element(dialog).toBeVisible();
	await expect.element(dialog).not.toHaveAttribute("data-starting-style");
	await expect.poll(() => dialog.element().getAnimations().length).toBe(0);
	return dialog;
}

afterEach(async () => {
	await page.viewport(1280, 800);
});

describe("swiping a phone sheet down", () => {
	it("dismisses a confirmation, like Cancel", async () => {
		await page.viewport(390, 700);
		const onClose = vi.fn();
		const screen = await render(
			<ConfirmDialog
				open
				onClose={onClose}
				title="Delete widget?"
				description="This cannot be undone."
				confirmLabel="Delete"
				pendingLabel="Deleting..."
				isPending={false}
				error={null}
				onConfirm={() => {}}
			/>,
		);
		await openSheet("Delete widget?");

		await swipeDown(screen.getByRole("heading", { name: "Delete widget?" }).element());

		await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("leaves a byline form open", async () => {
		await page.viewport(390, 700);
		const onOpenChange = vi.fn();
		const screen = await render(
			<BylineFormDialog
				open
				onOpenChange={onOpenChange}
				bylineId={null}
				onSubmit={vi.fn()}
				onSaved={vi.fn()}
			/>,
		);
		await openSheet("New byline");

		await swipeDown(screen.getByRole("heading", { name: "New byline" }).element());

		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("leaves a plugin's proposed changes open", async () => {
		await page.viewport(390, 700);
		const onClose = vi.fn();
		const screen = await render(
			<EditorDraftPatchPreview
				operations={[{ field: "title", op: "set", value: "Translated" }]}
				fields={{ title: { label: "Title" } }}
				currentValues={{ title: "Original" }}
				onApply={() => {}}
				onClose={onClose}
			/>,
		);
		await openSheet("Review proposed changes");

		await swipeDown(screen.getByRole("heading", { name: "Review proposed changes" }).element());

		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(onClose).not.toHaveBeenCalled();
	});

	it("leaves a form with typed input open", async () => {
		await page.viewport(390, 700);
		const onOpenChange = vi.fn();
		const screen = await render(
			<RelationDialog
				open
				onOpenChange={onOpenChange}
				collections={[{ slug: "posts", label: "Posts" }] as SchemaCollection[]}
				onSubmit={vi.fn()}
			/>,
		);
		await openSheet("New Relation");
		await screen.getByLabelText("Linked side (plural)").fill("Writers");

		await swipeDown(screen.getByRole("heading", { name: "New Relation" }).element());

		await new Promise((resolve) => setTimeout(resolve, 500));
		expect(onOpenChange).not.toHaveBeenCalled();
	});

	it("dismisses an untouched form", async () => {
		await page.viewport(390, 700);
		const onOpenChange = vi.fn();
		const screen = await render(
			<RelationDialog
				open
				onOpenChange={onOpenChange}
				collections={[{ slug: "posts", label: "Posts" }] as SchemaCollection[]}
				onSubmit={vi.fn()}
			/>,
		);
		await openSheet("New Relation");

		await swipeDown(screen.getByRole("heading", { name: "New Relation" }).element());

		await vi.waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
	});
});
