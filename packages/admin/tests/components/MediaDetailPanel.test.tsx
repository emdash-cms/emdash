import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MediaDetailPanel } from "../../src/components/MediaDetailPanel";
import { ApiResponseError, type LocalMediaItem, type MediaItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		updateMedia: vi.fn().mockResolvedValue({}),
		deleteMedia: vi.fn().mockResolvedValue({}),
		deleteFromProvider: vi.fn().mockResolvedValue({}),
		fetchMediaFolders: vi.fn().mockResolvedValue({ items: [{ id: "folder-2", name: "Press" }] }),
		fetchMediaFolder: vi.fn().mockResolvedValue({ id: "folder-1", name: "Product photos" }),
		fetchMediaItem: vi.fn().mockResolvedValue({}),
	};
});

// Import the mocked functions for assertions
import {
	updateMedia,
	deleteMedia,
	deleteFromProvider,
	fetchMediaFolders,
	fetchMediaFolder,
	fetchMediaItem,
} from "../../src/lib/api";

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeImageItem(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: "media-1",
		filename: "photo.jpg",
		mimeType: "image/jpeg",
		url: "https://example.com/photo.jpg",
		size: 204800,
		width: 1920,
		height: 1080,
		alt: "A nice photo",
		caption: "Photo caption",
		createdAt: "2025-01-15T10:30:00Z",
		...overrides,
	};
}

function makePdfItem(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: "media-2",
		filename: "document.pdf",
		mimeType: "application/pdf",
		url: "https://example.com/document.pdf",
		size: 1048576,
		createdAt: "2025-01-15T10:30:00Z",
		...overrides,
	};
}

function makeLocalItem(overrides: Partial<LocalMediaItem> = {}): LocalMediaItem {
	return {
		...makeImageItem(),
		storageKey: "media-1.jpg",
		authorId: "user-1",
		folderId: "folder-1",
		...overrides,
	};
}

function renderPanel(props: Partial<React.ComponentProps<typeof MediaDetailPanel>> = {}) {
	const defaultProps: React.ComponentProps<typeof MediaDetailPanel> = {
		open: true,
		item: makeImageItem(),
		onClose: vi.fn(),
		onDeleted: vi.fn(),
		...props,
	};
	return render(
		<QueryWrapper>
			<MediaDetailPanel {...defaultProps} />
		</QueryWrapper>,
	);
}

describe("MediaDetailPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("does not render dialog contents when closed", async () => {
		const screen = await renderPanel({ open: false });
		await expect
			.element(screen.getByText("Media Details"), { timeout: 100 })
			.not.toBeInTheDocument();
	});

	it("displays filename and file size", async () => {
		const item = makeImageItem({ size: 204800 });
		const screen = await renderPanel({ item });
		// Filename is in a disabled input
		const filenameInput = screen.getByLabelText("Filename");
		await expect.element(filenameInput).toHaveValue("photo.jpg");
		// 204800 bytes = 200 KB
		await expect.element(screen.getByText("200 KB")).toBeInTheDocument();
	});

	it("displays dimensions for images", async () => {
		const item = makeImageItem({ width: 1920, height: 1080 });
		const screen = await renderPanel({ item });
		await expect.element(screen.getByText("1920 × 1080")).toBeInTheDocument();
	});

	it("renders the responsive two-column viewport-bounded dialog layout", async () => {
		const screen = await renderPanel();
		const dialog = screen.getByRole("dialog", { name: "Media Details" }).element();
		const header = screen.getByTestId("media-detail-dialog-header").element();
		const body = screen.getByTestId("media-detail-dialog-body").element();
		const previewColumn = screen.getByTestId("media-detail-dialog-preview-column").element();
		const detailsColumn = screen.getByTestId("media-detail-dialog-details-column").element();
		const fileFacts = screen.getByTestId("media-detail-dialog-file-facts").element();
		const footer = screen.getByTestId("media-detail-dialog-footer").element();

		expect(body.className).toContain("grid-cols-1");
		expect(body.className).toContain("md:grid-cols-2");
		expect(dialog.style.height).toBe("");
		expect(dialog.style.maxHeight).toBe("min(88dvh, 48rem)");
		expect(dialog.className).toContain("data-starting-style:scale-90");
		expect(dialog.className).toContain("data-starting-style:opacity-0");
		expect(dialog.style.transitionProperty).toBe("scale, opacity");
		expect(header.style.padding).toBe("1.25rem 2rem");
		expect(previewColumn.contains(fileFacts)).toBe(true);
		expect(detailsColumn.contains(fileFacts)).toBe(false);
		expect(previewColumn.className).toContain("md:p-8");
		expect(detailsColumn.className).toContain("md:p-8");
		// Columns only constrain/scroll at md+; on mobile the body scrolls as one
		// column so collapsed columns can't compress and overlap their content.
		expect(body.className).toContain("overflow-y-auto");
		expect(body.className).toContain("md:overflow-hidden");
		expect(previewColumn.className).toContain("md:min-h-0");
		expect(previewColumn.className).toContain("md:overflow-y-auto");
		expect(previewColumn.className).not.toContain(" min-h-0");
		expect(detailsColumn.className).toContain("md:min-h-0");
		expect(detailsColumn.className).toContain("md:overflow-y-auto");
		expect(detailsColumn.className).not.toContain(" min-h-0");
		expect(fileFacts.className).toContain("space-y-3");
		expect(footer.style.padding).toBe("1.25rem 2rem");
	});

	it("shows image preview for image mimeTypes", async () => {
		const item = makeImageItem();
		const screen = await renderPanel({ item });
		const img = screen.getByAltText("A nice photo");
		await expect.element(img).toBeInTheDocument();
		await expect.element(img).toHaveAttribute("src", item.url);
	});

	it("does not show image preview for non-image mimeTypes", async () => {
		const item = makePdfItem();
		const screen = await renderPanel({ item });
		// Should show the mime type text instead of img
		await expect.element(screen.getByText("application/pdf")).toBeInTheDocument();
	});

	it("alt text input is editable", async () => {
		const item = makeImageItem({ alt: "Initial alt" });
		const screen = await renderPanel({ item });
		const altInput = screen.getByLabelText("Alt Text");
		await expect.element(altInput).toBeInTheDocument();
		expect(altInput.element().className).toContain("w-full");
		await expect
			.element(screen.getByRole("button", { name: "Why is this important?" }))
			.toBeInTheDocument();
		await altInput.fill("New alt text");
		await expect.element(altInput).toHaveValue("New alt text");
	});

	it("shows caption textarea only for images", async () => {
		const imageItem = makeImageItem();
		const screen = await renderPanel({ item: imageItem });
		// Caption textarea should exist for images - find by placeholder
		const captionArea = screen.getByPlaceholder("Optional caption for display");
		await expect.element(captionArea).toBeInTheDocument();
		await expect.element(captionArea).toHaveValue("Photo caption");
	});

	it("hides caption textarea for non-images", async () => {
		const pdfItem = makePdfItem();
		const screen = await renderPanel({ item: pdfItem });
		await expect
			.element(screen.getByPlaceholder("Optional caption for display"), { timeout: 100 })
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByLabelText("Caption"), { timeout: 100 })
			.not.toBeInTheDocument();
	});

	it("filename input is disabled with tooltip help", async () => {
		const item = makeImageItem();
		const screen = await renderPanel({ item });
		const filenameInput = screen.getByLabelText("Filename");
		await expect.element(filenameInput).toBeDisabled();
		expect(filenameInput.element().className).toContain("bg-kumo-tint");
		expect(filenameInput.element().className).toContain("w-full");
		await expect
			.element(screen.getByRole("button", { name: "Why can't this be changed?" }))
			.toBeInTheDocument();
	});

	it("save button is disabled when no changes", async () => {
		const item = makeImageItem();
		const screen = await renderPanel({ item });
		const saveBtn = screen.getByRole("button", { name: "Save" });
		await expect.element(saveBtn).toBeDisabled();
	});

	it("save button is enabled after changing alt text", async () => {
		const item = makeImageItem({ alt: "Original" });
		const screen = await renderPanel({ item });
		const altInput = screen.getByLabelText("Alt Text");
		await altInput.fill("Changed alt text");
		const saveBtn = screen.getByRole("button", { name: "Save" });
		await expect.element(saveBtn).toBeEnabled();
	});

	it("save calls updateMedia with correct payload", async () => {
		const onClose = vi.fn();
		const item = makeImageItem({ alt: "Old alt", caption: "Old caption" });
		const screen = await renderPanel({ item, onClose });

		const altInput = screen.getByLabelText("Alt Text");
		await altInput.fill("New alt");

		const saveBtn = screen.getByRole("button", { name: "Save" });
		await expect.element(saveBtn).toBeEnabled();
		saveBtn.element().click();

		await vi.waitFor(() => {
			expect(updateMedia).toHaveBeenCalledWith("media-1", {
				alt: "New alt",
				caption: "Old caption",
			});
			expect(onClose).toHaveBeenCalled();
		});
	});

	it("saves empty strings when clearing alt text and caption", async () => {
		const item = makeImageItem({ alt: "Old alt", caption: "Old caption" });
		const screen = await renderPanel({ item });

		await screen.getByLabelText("Alt Text").fill("");
		await screen.getByLabelText("Caption").fill("");
		screen.getByRole("button", { name: "Save" }).element().click();

		await vi.waitFor(() => {
			expect(updateMedia).toHaveBeenCalledWith("media-1", {
				alt: "",
				caption: "",
			});
		});
	});

	it("disables editing and closing while a save is pending", async () => {
		let resolveUpdate!: (item: MediaItem) => void;
		vi.mocked(updateMedia).mockImplementationOnce(
			() => new Promise<MediaItem>((resolve) => (resolveUpdate = resolve)),
		);
		const onClose = vi.fn();
		const item = makeImageItem({ alt: "Old alt", caption: "Old caption" });
		const screen = await renderPanel({ item, onClose });

		const altInput = screen.getByLabelText("Alt Text");
		await altInput.fill("New alt");
		screen.getByRole("button", { name: "Save" }).element().click();

		await expect.element(altInput).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Saving..." })).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Close" })).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Cancel" })).toBeDisabled();

		screen.getByRole("button", { name: "Close" }).element().click();
		expect(onClose).not.toHaveBeenCalled();

		resolveUpdate({ ...item, alt: "New alt" });
		await vi.waitFor(() => {
			expect(onClose).toHaveBeenCalled();
		});
	});

	it("saves dirty metadata with the keyboard shortcut", async () => {
		const onClose = vi.fn();
		const item = makeImageItem({ alt: "Old alt", caption: "Old caption" });
		const screen = await renderPanel({ item, onClose });

		await screen.getByLabelText("Alt Text").fill("Shortcut alt");
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "s", ctrlKey: true }));

		await vi.waitFor(() => {
			expect(updateMedia).toHaveBeenCalledWith("media-1", {
				alt: "Shortcut alt",
				caption: "Old caption",
			});
			expect(onClose).toHaveBeenCalled();
		});
	});

	it("loads bounded Location options only after the control opens", async () => {
		const screen = await renderPanel({ item: makeLocalItem(), canMoveLocation: true });

		expect(fetchMediaFolders).not.toHaveBeenCalled();
		await expect
			.element(screen.getByRole("combobox", { name: "Location" }))
			.toHaveTextContent("Product photos");

		screen.getByRole("combobox", { name: "Location" }).element().click();

		await vi.waitFor(() => {
			expect(fetchMediaFolders).toHaveBeenCalledWith({
				limit: 100,
				cursor: undefined,
				search: undefined,
			});
		});
		await expect.element(screen.getByRole("option", { name: "Main library" })).toBeInTheDocument();
		await expect.element(screen.getByRole("option", { name: "Press" })).toBeInTheDocument();
		await expect.element(screen.getByText("1 folder loaded")).toBeInTheDocument();
	});

	it("saves image metadata and Location in one update", async () => {
		const screen = await renderPanel({ item: makeLocalItem(), canMoveLocation: true });

		screen.getByRole("combobox", { name: "Location" }).element().click();
		await expect.element(screen.getByRole("option", { name: "Press" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Press" }).element().click();
		await screen.getByLabelText("Alt Text").fill("Updated alt");
		screen.getByRole("button", { name: "Save" }).element().click();

		await vi.waitFor(() => {
			expect(updateMedia).toHaveBeenCalledWith("media-1", {
				alt: "Updated alt",
				caption: "Photo caption",
				folderId: "folder-2",
			});
		});
	});

	it("does not overwrite Location during a metadata-only save", async () => {
		const screen = await renderPanel({ item: makeLocalItem(), canMoveLocation: true });

		await screen.getByLabelText("Alt Text").fill("Metadata only");
		screen.getByRole("button", { name: "Save" }).element().click();

		await vi.waitFor(() => {
			expect(updateMedia).toHaveBeenCalledWith("media-1", {
				alt: "Metadata only",
				caption: "Photo caption",
			});
		});
	});

	it("searches Location independently and resets the search after selection", async () => {
		const screen = await renderPanel({ item: makeLocalItem(), canMoveLocation: true });
		const locationTrigger = screen
			.getByTestId("media-detail-dialog-details-column")
			.getByRole("combobox", { name: "Location" });

		locationTrigger.element().click();
		await screen.getByPlaceholder("Search folders").fill("press");
		await vi.waitFor(() => {
			expect(fetchMediaFolders).toHaveBeenLastCalledWith({
				limit: 100,
				cursor: undefined,
				search: "press",
			});
		});
		await expect.element(screen.getByRole("option", { name: "Press" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Press" }).element().click();
		await expect.element(screen.getByRole("option", { name: "Press" })).not.toBeInTheDocument();
		locationTrigger.element().click();

		await expect.element(screen.getByPlaceholder("Search folders")).toHaveValue("");
	});

	it("ignores duplicate Location saves while the first update is pending", async () => {
		let resolveUpdate!: (item: LocalMediaItem) => void;
		vi.mocked(updateMedia).mockImplementationOnce(
			() => new Promise<LocalMediaItem>((resolve) => (resolveUpdate = resolve)),
		);
		const item = makeLocalItem();
		const screen = await renderPanel({ item, canMoveLocation: true });

		screen.getByRole("combobox", { name: "Location" }).element().click();
		await expect.element(screen.getByRole("option", { name: "Press" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Press" }).element().click();
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		const save = screen.getByRole("button", { name: "Save" }).element();
		save.click();
		save.click();

		await vi.waitFor(() => expect(updateMedia).toHaveBeenCalledTimes(1));
		resolveUpdate({ ...item, folderId: "folder-2" });
	});

	it.each([
		["video", "video/mp4"],
		["audio", "audio/mpeg"],
		["document", "application/pdf"],
	])("moves a local %s without image metadata", async (_kind, mimeType) => {
		const screen = await renderPanel({
			item: makeLocalItem({ mimeType, alt: undefined, caption: undefined }),
			canMoveLocation: true,
		});

		screen.getByRole("combobox", { name: "Location" }).element().click();
		await expect.element(screen.getByRole("option", { name: "Main library" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Main library" }).element().click();
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		screen.getByRole("button", { name: "Save" }).element().click();

		await vi.waitFor(() => {
			expect(updateMedia).toHaveBeenCalledWith("media-1", { folderId: null });
		});
	});

	it("loads one additional bounded Location page on request", async () => {
		vi.mocked(fetchMediaFolders).mockImplementation(async ({ cursor }) =>
			cursor === "next-folder"
				? { items: [{ id: "folder-3", name: "Archive" }] }
				: { items: [{ id: "folder-2", name: "Press" }], nextCursor: "next-folder" },
		);
		const screen = await renderPanel({ item: makeLocalItem(), canMoveLocation: true });

		screen.getByRole("combobox", { name: "Location" }).element().click();
		await expect
			.element(screen.getByRole("button", { name: "Load more folders" }))
			.toBeInTheDocument();
		screen.getByRole("button", { name: "Load more folders" }).element().click();

		await expect.element(screen.getByRole("option", { name: "Archive" })).toBeInTheDocument();
		expect(fetchMediaFolders).toHaveBeenLastCalledWith({
			limit: 100,
			cursor: "next-folder",
			search: undefined,
		});
	});

	it("shows a read-only Location when the user cannot move the item", async () => {
		const screen = await renderPanel({ item: makeLocalItem(), canMoveLocation: false });

		await expect.element(screen.getByText("Location")).toBeInTheDocument();
		await expect.element(screen.getByText("Product photos")).toBeInTheDocument();
		expect(screen.getByRole("combobox", { name: "Location" }).query()).toBeNull();
		expect(fetchMediaFolders).not.toHaveBeenCalled();
	});

	it("refreshes the open item when its saved folder no longer exists", async () => {
		const refreshed = makeLocalItem({ folderId: null });
		let resolveRefresh!: (item: LocalMediaItem) => void;
		vi.mocked(fetchMediaFolder).mockRejectedValueOnce(
			new ApiResponseError(404, "NOT_FOUND", "Media folder not found"),
		);
		vi.mocked(fetchMediaItem).mockImplementationOnce(
			() => new Promise<LocalMediaItem>((resolve) => (resolveRefresh = resolve)),
		);
		const onItemRefreshed = vi.fn();

		const screen = await renderPanel({
			item: makeLocalItem(),
			canMoveLocation: true,
			onItemRefreshed,
		});

		await vi.waitFor(() => expect(fetchMediaItem).toHaveBeenCalledWith("media-1"));
		await expect
			.element(screen.getByRole("combobox", { name: "Location" }))
			.toHaveTextContent("Loading...");
		resolveRefresh(refreshed);
		await vi.waitFor(() => {
			expect(onItemRefreshed).toHaveBeenCalledWith(refreshed);
		});
	});

	it("refreshes the open item when a selected folder disappears during save", async () => {
		const refreshed = makeLocalItem({ folderId: null });
		vi.mocked(updateMedia).mockRejectedValueOnce(
			new ApiResponseError(404, "NOT_FOUND", "Media folder not found"),
		);
		vi.mocked(fetchMediaItem).mockResolvedValueOnce(refreshed);
		const onItemRefreshed = vi.fn();
		const screen = await renderPanel({
			item: makeLocalItem(),
			canMoveLocation: true,
			onItemRefreshed,
		});

		screen.getByRole("combobox", { name: "Location" }).element().click();
		await expect.element(screen.getByRole("option", { name: "Main library" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Main library" }).element().click();
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		screen.getByRole("button", { name: "Save" }).element().click();

		await vi.waitFor(() => {
			expect(fetchMediaItem).toHaveBeenCalledWith("media-1");
			expect(onItemRefreshed).toHaveBeenCalledWith(refreshed);
		});
		await expect
			.element(
				screen.getByText(
					"The selected folder no longer exists. Choose another location and save again.",
				),
			)
			.toBeInTheDocument();
	});

	it("blocks stale save retries while missing-folder recovery is pending", async () => {
		let resolveRefresh!: (item: LocalMediaItem) => void;
		vi.mocked(updateMedia).mockRejectedValueOnce(
			new ApiResponseError(404, "NOT_FOUND", "Media folder not found"),
		);
		vi.mocked(fetchMediaItem).mockImplementationOnce(
			() => new Promise<LocalMediaItem>((resolve) => (resolveRefresh = resolve)),
		);
		const item = makeLocalItem();
		const screen = await renderPanel({ item, canMoveLocation: true });

		screen.getByRole("combobox", { name: "Location" }).element().click();
		await expect.element(screen.getByRole("option", { name: "Main library" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Main library" }).element().click();
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		const save = screen.getByRole("button", { name: "Save" }).element();
		save.click();

		await vi.waitFor(() => expect(fetchMediaItem).toHaveBeenCalledWith("media-1"));
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
		const shortcut = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true });
		window.dispatchEvent(shortcut);
		expect(shortcut.defaultPrevented).toBe(false);
		save.click();
		expect(updateMedia).toHaveBeenCalledTimes(1);
		resolveRefresh({ ...item, folderId: null });
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
	});

	it("reports when the media itself was deleted during a save", async () => {
		vi.mocked(updateMedia).mockRejectedValueOnce(
			new ApiResponseError(404, "NOT_FOUND", "Media item not found"),
		);
		vi.mocked(fetchMediaItem).mockRejectedValueOnce(
			new ApiResponseError(404, "NOT_FOUND", "Media item not found"),
		);
		const screen = await renderPanel({ item: makeLocalItem(), canMoveLocation: true });

		screen.getByRole("combobox", { name: "Location" }).element().click();
		await expect.element(screen.getByRole("option", { name: "Main library" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Main library" }).element().click();
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeEnabled();
		screen.getByRole("button", { name: "Save" }).element().click();

		await expect.element(screen.getByText("This media item no longer exists.")).toBeInTheDocument();
		expect(
			screen
				.getByText("The selected folder no longer exists. Choose another location and save again.")
				.query(),
		).toBeNull();
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();
	});

	it("does not consume the keyboard save shortcut when nothing can be saved", async () => {
		await renderPanel({
			item: makeImageItem({ provider: "cloudflare-images" }),
			providerName: "Cloudflare Images",
		});

		const event = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true });
		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(false);
		expect(updateMedia).not.toHaveBeenCalled();
	});

	it("delete with confirm calls deleteMedia and onClose + onDeleted", async () => {
		const onClose = vi.fn();
		const onDeleted = vi.fn();
		const item = makeImageItem();

		const screen = await renderPanel({ item, onClose, onDeleted });
		const deleteBtn = screen.getByRole("button", { name: "Delete" });
		deleteBtn.element().click();

		// ConfirmDialog should appear
		await expect.element(screen.getByText("Delete Media?")).toBeInTheDocument();

		// Direct DOM click to bypass Base UI inert overlay
		const allDeleteBtns = screen.getByRole("button", { name: "Delete" }).all();
		allDeleteBtns.at(-1)!.element().click();

		// Wait for mutation to complete
		await vi.waitFor(() => {
			expect(deleteMedia).toHaveBeenCalledWith("media-1");
			expect(onClose).toHaveBeenCalled();
			expect(onDeleted).toHaveBeenCalled();
		});
	});

	it("deletes provider assets through the provider API when deletion is supported", async () => {
		const onDeleted = vi.fn();
		const screen = await renderPanel({
			item: makeImageItem({ id: "provider-1", provider: "cloudflare-images" }),
			providerName: "Cloudflare Images",
			canDelete: true,
			onDeleted,
		});

		screen.getByRole("button", { name: "Delete" }).element().click();
		await expect.element(screen.getByText("Delete Media?")).toBeInTheDocument();
		screen.getByRole("button", { name: "Delete" }).all().at(-1)!.element().click();

		await vi.waitFor(() => {
			expect(deleteFromProvider).toHaveBeenCalledWith("cloudflare-images", "provider-1");
			expect(deleteMedia).not.toHaveBeenCalled();
			expect(onDeleted).toHaveBeenCalledTimes(1);
		});
	});

	it("delete cancelled does not call deleteMedia", async () => {
		const item = makeImageItem();

		const screen = await renderPanel({ item });
		const deleteBtn = screen.getByRole("button", { name: "Delete" });
		deleteBtn.element().click();

		// ConfirmDialog should appear
		await expect.element(screen.getByText("Delete Media?")).toBeInTheDocument();

		// Direct DOM click to bypass Base UI inert overlay
		screen.getByRole("button", { name: "Cancel" }).all().at(-1)!.element().click();

		expect(deleteMedia).not.toHaveBeenCalled();
	});

	it("close button calls onClose when clean", async () => {
		const onClose = vi.fn();
		const item = makeImageItem();
		const screen = await renderPanel({ item, onClose });

		screen.getByRole("button", { name: "Close" }).element().click();

		expect(onClose).toHaveBeenCalled();
	});

	it("close button opens discard confirmation when dirty", async () => {
		const onClose = vi.fn();
		const item = makeImageItem({ alt: "Original" });
		const screen = await renderPanel({ item, onClose });

		await screen.getByLabelText("Alt Text").fill("Changed alt");
		screen.getByRole("button", { name: "Close" }).element().click();

		await expect.element(screen.getByText("Discard changes?")).toBeInTheDocument();
		expect(onClose).not.toHaveBeenCalled();

		screen.getByRole("button", { name: "Discard" }).element().click();
		expect(onClose).toHaveBeenCalled();
	});

	it("cancels the close fallback when reopened before the fallback timer fires", async () => {
		vi.useFakeTimers();
		try {
			const onClose = vi.fn();
			const onClosed = vi.fn();
			const firstItem = makeImageItem({ id: "media-1", filename: "first.jpg" });
			const secondItem = makeImageItem({ id: "media-2", filename: "second.jpg" });

			const screen = await render(
				<QueryWrapper>
					<MediaDetailPanel
						open
						item={firstItem}
						onClose={onClose}
						onClosed={onClosed}
						onDeleted={vi.fn()}
					/>
				</QueryWrapper>,
			);

			screen.getByRole("button", { name: "Close" }).element().click();
			expect(onClose).toHaveBeenCalled();

			await screen.rerender(
				<QueryWrapper>
					<MediaDetailPanel
						open
						item={secondItem}
						onClose={onClose}
						onClosed={onClosed}
						onDeleted={vi.fn()}
					/>
				</QueryWrapper>,
			);
			await vi.advanceTimersByTimeAsync(500);

			expect(onClosed).not.toHaveBeenCalled();
			await expect.element(screen.getByLabelText("Filename")).toHaveValue("second.jpg");
		} finally {
			vi.useRealTimers();
		}
	});

	it("form fields reset when item prop changes", async () => {
		const item1 = makeImageItem({ id: "m1", alt: "Alt one", caption: "Cap one" });
		const item2 = makeImageItem({ id: "m2", alt: "Alt two", caption: "Cap two" });

		const screen = await renderPanel({ item: item1 });

		// Verify item1 alt is shown
		const altInput = screen.getByLabelText("Alt Text");
		await expect.element(altInput).toHaveValue("Alt one");

		// Rerender with item2
		await screen.rerender(
			<QueryWrapper>
				<MediaDetailPanel open item={item2} onClose={vi.fn()} onDeleted={vi.fn()} />
			</QueryWrapper>,
		);

		// The alt text should now show item2's alt
		await expect.element(screen.getByLabelText("Alt Text")).toHaveValue("Alt two");
	});
});

describe("MediaDetailPanel file URL", () => {
	it("shows the absolute file URL with a Copy URL action", async () => {
		const screen = await renderPanel({
			item: makeImageItem({ url: "/_emdash/api/media/file/01ABC.jpg" }),
		});

		// Relative local-storage URLs are shown as absolute (origin-resolved)
		// so they can be pasted anywhere. The Kumo ClipboardText component
		// renders the value as text and a copy button (labelled "Copy URL").
		const absolute = new URL("/_emdash/api/media/file/01ABC.jpg", window.location.origin).href;
		await expect.element(screen.getByText(absolute)).toBeVisible();
		await expect.element(screen.getByRole("button", { name: /Copy URL/ })).toBeVisible();
	});

	it("does not expose provider preview URLs as public URLs", async () => {
		const screen = await renderPanel({
			item: makeImageItem({ provider: "cloudflare-images", url: "https://preview.example/image" }),
			providerName: "Cloudflare Images",
		});

		await expect.element(screen.getByText("Managed by Cloudflare Images")).toBeVisible();
		await expect.element(screen.getByText("No public URL available")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: /Copy URL/ }), { timeout: 100 })
			.not.toBeInTheDocument();
	});

	it("renders provider assets read-only", async () => {
		const screen = await renderPanel({
			item: makeImageItem({ provider: "cloudflare-images" }),
			providerName: "Cloudflare Images",
		});

		await expect
			.element(screen.getByRole("button", { name: "Delete" }), { timeout: 100 })
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Save" }), { timeout: 100 })
			.not.toBeInTheDocument();
		await expect
			.element(screen.getByLabelText("Alt Text"), { timeout: 100 })
			.not.toBeInTheDocument();
		await expect.element(screen.getByText("Uploaded:"), { timeout: 100 }).not.toBeInTheDocument();
		await expect.element(screen.getByText("Location"), { timeout: 100 }).not.toBeInTheDocument();
		expect(fetchMediaFolder).not.toHaveBeenCalled();
		expect(fetchMediaFolders).not.toHaveBeenCalled();
	});
});
