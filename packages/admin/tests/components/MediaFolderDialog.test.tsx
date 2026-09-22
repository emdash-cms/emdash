import { Toasty } from "@cloudflare/kumo";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import { MediaFolderDialog } from "../../src/components/MediaFolderDialog";
import { ApiResponseError } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

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

	it("keeps validation and conflict errors inline", async () => {
		const onCreate = vi
			.fn()
			.mockRejectedValue(
				new ApiResponseError(409, "CONFLICT", "Database unique constraint failed"),
			);
		const { screen } = await renderDialog({ onCreate });

		screen.getByRole("button", { name: "Create" }).element().click();
		await expect
			.element(screen.getByText("Folder name must be between 1 and 200 characters"))
			.toBeInTheDocument();

		await screen.getByLabelText("Name").fill("Duplicate");
		screen.getByRole("button", { name: "Create" }).element().click();
		await expect
			.element(screen.getByText("A media folder with this name already exists"))
			.toBeInTheDocument();
		screen.getByRole("button", { name: "Cancel" }).element().click();
		await vi.waitFor(() =>
			expect(screen.getByRole("heading", { name: "Add new folder" }).query()).toBeNull(),
		);
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
		await expect.element(screen.getByText("Delete “Drafts”?")).toBeInTheDocument();
		await expect
			.element(
				screen.getByText(
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
