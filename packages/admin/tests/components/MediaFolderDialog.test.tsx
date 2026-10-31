import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import { MediaFolderDialog } from "../../src/components/MediaFolderDialog";
import { ApiResponseError } from "../../src/lib/api";
import { pressOutside } from "../utils/mouse.ts";
import { render } from "../utils/render.tsx";

const EMPTY_NAME = "Enter a folder name.";
const TAKEN_NAME = "Another folder already uses this name. Enter a different one.";

async function renderDialog(props: Partial<React.ComponentProps<typeof MediaFolderDialog>> = {}) {
	const defaults: React.ComponentProps<typeof MediaFolderDialog> = {
		open: true,
		onClose: vi.fn(),
		onCreate: vi.fn().mockResolvedValue({ id: "folder-1", name: "Created" }),
		onRename: vi.fn().mockResolvedValue({ id: "folder-1", name: "Renamed" }),
		onDelete: vi.fn().mockResolvedValue(undefined),
		...props,
	};
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	function Harness() {
		const [open, setOpen] = React.useState(true);
		return (
			<MediaFolderDialog
				{...defaults}
				open={open}
				onClose={() => {
					setOpen(false);
					defaults.onClose();
				}}
			/>
		);
	}
	function Wrapper({ children }: { children: React.ReactNode }) {
		return (
			<Toasty>
				<QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
			</Toasty>
		);
	}
	const screen = await render(<Harness />, { wrapper: Wrapper });
	return { screen, props: defaults };
}

describe("MediaFolderDialog", () => {
	beforeEach(() => vi.clearAllMocks());

	it("autofocuses Name and creates a trimmed folder on Enter", async () => {
		const onCreate = vi.fn().mockResolvedValue({ id: "folder-1", name: "Created" });
		const onClose = vi.fn();
		const { screen } = await renderDialog({ onCreate, onClose });
		const name = screen.getByLabelText("Name");

		await expect.element(name).toHaveFocus();
		expect(screen.getByText("Create a folder in the Main library.").query()).toBeNull();
		await name.fill("  Created  ");
		await userEvent.keyboard("{Enter}");

		await vi.waitFor(() => {
			expect(onCreate).toHaveBeenCalledWith("Created");
			expect(onClose).toHaveBeenCalledTimes(1);
		});
		await vi.waitFor(() =>
			expect(screen.getByRole("heading", { name: "Add new folder" }).query()).toBeNull(),
		);
	});

	it("points at a missing or overlong name when submitted, and sends nothing", async () => {
		const onCreate = vi.fn().mockResolvedValue({ id: "folder-1", name: "Created" });
		const { screen } = await renderDialog({ onCreate });
		const name = screen.getByLabelText("Name", { exact: true });
		const create = screen.getByRole("button", { name: "Create" });
		expect(screen.getByText(EMPTY_NAME).query()).toBeNull();

		await name.fill("   ");
		await create.click();
		await expect.element(screen.getByText(EMPTY_NAME)).toBeVisible();
		await expect.element(name).toHaveAttribute("aria-invalid", "true");
		await expect.element(name).toHaveFocus();

		await name.fill("A");
		await expect.element(screen.getByText(EMPTY_NAME)).not.toBeInTheDocument();
		await expect.element(name).not.toHaveAttribute("aria-invalid");

		await name.fill("x".repeat(201));
		await create.click();
		await expect.element(screen.getByText("Use 200 characters or fewer.")).toBeVisible();
		await expect.element(name).toHaveFocus();
		expect(onCreate).not.toHaveBeenCalled();
	});

	it("shows a name another folder uses on the name field", async () => {
		const onCreate = vi
			.fn()
			.mockRejectedValue(
				new ApiResponseError(409, "CONFLICT", "A media folder with this name already exists"),
			);
		const { screen } = await renderDialog({ onCreate });
		const name = screen.getByLabelText("Name", { exact: true });

		await name.fill("Duplicate");
		await screen.getByRole("button", { name: "Create" }).click();

		await expect.element(screen.getByText(TAKEN_NAME)).toBeVisible();
		await expect.element(name).toHaveAttribute("aria-invalid", "true");
		await expect.element(name).toHaveFocus();
		await expect.element(name).toHaveValue("Duplicate");
		expect(screen.getByText("A media folder with this name already exists").query()).toBeNull();

		await name.fill(" DUPLICATE ");
		await expect.element(screen.getByText(TAKEN_NAME)).toBeVisible();

		await name.fill("Duplicates");
		await expect.element(screen.getByText(TAKEN_NAME)).not.toBeInTheDocument();
	});

	it("keeps a typed name through a press outside, and still closes on Cancel", async () => {
		const onClose = vi.fn();
		const { screen } = await renderDialog({ onClose });
		const dialog = screen.getByRole("dialog", { name: "Add new folder" });
		await expect.element(dialog).toBeVisible();
		await screen.getByLabelText("Name", { exact: true }).fill("Drafts");

		await pressOutside();
		await expect.element(dialog).toBeVisible();
		await expect.element(screen.getByLabelText("Name", { exact: true })).toHaveValue("Drafts");
		expect(onClose).not.toHaveBeenCalled();

		await dialog.getByRole("button", { name: "Cancel" }).click();
		await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("closes on a press outside when nothing was typed", async () => {
		const onClose = vi.fn();
		const { screen } = await renderDialog({ onClose });
		await expect.element(screen.getByRole("dialog", { name: "Add new folder" })).toBeVisible();

		await pressOutside();
		await vi.waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
	});

	it("ignores duplicate submits while a folder save is pending", async () => {
		let resolveCreate: ((folder: { id: string; name: string }) => void) | undefined;
		const onCreate = vi.fn(
			() =>
				new Promise<{ id: string; name: string }>((resolve) => {
					resolveCreate = resolve;
				}),
		);
		const { screen } = await renderDialog({ onCreate });
		await screen.getByLabelText("Name").fill("Created");
		const create = screen.getByRole("button", { name: "Create" }).element();

		create.click();
		create.click();

		await vi.waitFor(() => expect(onCreate).toHaveBeenCalledTimes(1));
		resolveCreate?.({ id: "folder-1", name: "Created" });
		await vi.waitFor(() =>
			expect(screen.getByRole("heading", { name: "Add new folder" }).query()).toBeNull(),
		);
	});

	it("renames a folder from the edit dialog", async () => {
		const folder = { id: "folder-1", name: "Drafts" };
		const onRename = vi.fn().mockResolvedValue({ ...folder, name: "Published" });
		const { screen } = await renderDialog({ folder, onRename });

		await screen.getByLabelText("Name").fill("Published");
		screen.getByRole("button", { name: "Save" }).element().click();

		await vi.waitFor(() => expect(onRename).toHaveBeenCalledWith(folder, "Published"));
		await vi.waitFor(() =>
			expect(screen.getByRole("heading", { name: "Edit folder" }).query()).toBeNull(),
		);
	});

	it("explains safe deletion and leaves edit open when confirmation is canceled", async () => {
		const folder = { id: "folder-1", name: "Drafts" };
		const onDelete = vi.fn().mockResolvedValue(undefined);
		const { screen } = await renderDialog({ folder, onDelete });
		const deleteButton = screen.getByRole("button", { name: "Delete folder" });

		deleteButton.element().click();
		const confirmation = screen.getByRole("dialog", { name: "Delete “Drafts”?" });
		await expect.element(confirmation).toBeInTheDocument();
		await expect
			.element(
				confirmation.getByText(
					"Media in this folder will return to Main library. No files will be deleted.",
				),
			)
			.toBeInTheDocument();
		screen.getByRole("button", { name: "Cancel" }).last().element().click();

		expect(onDelete).not.toHaveBeenCalled();
		await expect.element(screen.getByRole("heading", { name: "Edit folder" })).toBeInTheDocument();
		await vi.waitFor(() => expect(document.activeElement).toBe(deleteButton.element()));
		screen.getByRole("button", { name: "Cancel" }).element().click();
		await vi.waitFor(() =>
			expect(screen.getByRole("heading", { name: "Edit folder" }).query()).toBeNull(),
		);
	});
});
