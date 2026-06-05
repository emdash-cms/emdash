import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MediaLibrary } from "../../src/components/MediaLibrary";
import type { MediaItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPLOAD_CTA_PATTERN = /Upload images, videos, and documents/;
const UPLOAD_TO_LIBRARY_PATTERN = /Upload to Library/;
const UPLOAD_FILES_PATTERN = /Upload Files/;

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchMediaProviders: vi.fn().mockResolvedValue([]),
		fetchProviderMedia: vi.fn().mockResolvedValue({ items: [] }),
		uploadToProvider: vi.fn().mockResolvedValue({}),
		updateMedia: vi.fn().mockResolvedValue({}),
		deleteMedia: vi.fn().mockResolvedValue({}),
	};
});

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function dispatchFileDrop(target: Element, files: File[]) {
	const dataTransfer = new DataTransfer();
	for (const file of files) {
		dataTransfer.items.add(file);
	}

	target.dispatchEvent(
		new DragEvent("drop", {
			bubbles: true,
			cancelable: true,
			dataTransfer,
		}),
	);
}

function dispatchFileDrag(target: Element, type: "dragenter" | "dragover" | "dragleave") {
	const dataTransfer = new DataTransfer();
	dataTransfer.items.add(new File(["x"], "dragged.jpg", { type: "image/jpeg" }));

	target.dispatchEvent(
		new DragEvent(type, {
			bubbles: true,
			cancelable: true,
			dataTransfer,
		}),
	);
}

function renderLibrary(props: Partial<React.ComponentProps<typeof MediaLibrary>> = {}) {
	const defaultProps: React.ComponentProps<typeof MediaLibrary> = {
		items: [],
		isLoading: false,
		onUpload: vi.fn().mockResolvedValue(undefined),
		onSelect: vi.fn(),
		onDelete: vi.fn(),
		onItemUpdated: vi.fn(),
		...props,
	};
	return render(
		<QueryWrapper>
			<MediaLibrary {...defaultProps} />
		</QueryWrapper>,
	);
}

function makeMediaItem(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: "media_01",
		filename: "photo.jpg",
		mimeType: "image/jpeg",
		url: "https://example.com/photo.jpg",
		size: 102400,
		width: 800,
		height: 600,
		createdAt: "2025-01-01T00:00:00Z",
		...overrides,
	};
}

describe("MediaLibrary", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("rendering items", () => {
		it("displays media items in grid view by default", async () => {
			const items = [
				makeMediaItem({ id: "1", filename: "image1.jpg" }),
				makeMediaItem({ id: "2", filename: "image2.jpg" }),
			];
			const screen = await renderLibrary({ items });
			// Grid view is default — items render as buttons with alt text
			await expect.element(screen.getByRole("button", { name: "Grid view" })).toBeInTheDocument();
			// Images should be present via their img alt attributes
			await expect.element(screen.getByAltText("image1.jpg")).toBeInTheDocument();
			await expect.element(screen.getByAltText("image2.jpg")).toBeInTheDocument();
		});

		it("grid items show image thumbnails for image mimeTypes", async () => {
			const items = [makeMediaItem({ id: "1", filename: "pic.jpg", mimeType: "image/jpeg" })];
			const screen = await renderLibrary({ items });
			const img = screen.getByAltText("pic.jpg");
			await expect.element(img).toBeInTheDocument();
			await expect.element(img).toHaveAttribute("src", "https://example.com/photo.jpg");
		});
	});

	describe("view mode toggle", () => {
		it("switches between grid and list view", async () => {
			const items = [makeMediaItem({ id: "1", filename: "test.jpg" })];
			const screen = await renderLibrary({ items });

			// Default is grid
			const listBtn = screen.getByRole("button", { name: "List view" });
			await listBtn.click();

			// In list view, filename appears in table cell
			await expect.element(screen.getByText("test.jpg")).toBeInTheDocument();
			// Table headers should be visible
			await expect.element(screen.getByText("Filename")).toBeInTheDocument();
			await expect.element(screen.getByText("Type", { exact: true })).toBeInTheDocument();
			await expect.element(screen.getByText("Size")).toBeInTheDocument();
		});
	});

	describe("upload", () => {
		it("upload button triggers file input", async () => {
			const screen = await renderLibrary();
			// The upload button should be present
			await expect
				.element(screen.getByRole("button", { name: UPLOAD_TO_LIBRARY_PATTERN }))
				.toBeInTheDocument();
			// Hidden file input should exist
			const fileInput = screen.getByLabelText("Upload files");
			await expect.element(fileInput).toBeInTheDocument();
		});

		it("shows active drop state while files are dragged over the library", async () => {
			const screen = await renderLibrary();
			const dropZone = screen.getByText("Drag files here to upload").element();

			dispatchFileDrag(dropZone, "dragenter");

			await expect.element(screen.getByText("Drop files to upload to Library")).toBeInTheDocument();
		});

		it("uploads every dropped file through the existing upload callback", async () => {
			const onUpload = vi.fn().mockResolvedValue(undefined);
			const screen = await renderLibrary({ onUpload });
			const dropZone = screen.getByText("Drag files here to upload").element();
			const files = [
				new File(["one"], "one.jpg", { type: "image/jpeg" }),
				new File(["two"], "two.jpg", { type: "image/jpeg" }),
			];

			dispatchFileDrop(dropZone, files);

			await vi.waitFor(() => {
				expect(onUpload).toHaveBeenCalledTimes(2);
			});
			expect(onUpload).toHaveBeenNthCalledWith(1, files[0]);
			expect(onUpload).toHaveBeenNthCalledWith(2, files[1]);
			await expect.element(screen.getByText("2 files uploaded")).toBeInTheDocument();
		});

		it("shows batch progress while a dropped upload is pending", async () => {
			const onUpload = vi.fn(
				() =>
					new Promise<void>(() => {
						// Keep the first upload pending so progress remains visible.
					}),
			);
			const screen = await renderLibrary({ onUpload });
			const dropZone = screen.getByText("Drag files here to upload").element();

			dispatchFileDrop(dropZone, [
				new File(["one"], "one.jpg", { type: "image/jpeg" }),
				new File(["two"], "two.jpg", { type: "image/jpeg" }),
			]);

			await expect.element(screen.getByText("Uploading 0/2...")).toBeInTheDocument();
		});

		it("shows a reject drop state while an upload is pending", async () => {
			const onUpload = vi.fn(
				() =>
					new Promise<void>(() => {
						// Keep the first upload pending so dragover should reject new drops.
					}),
			);
			const screen = await renderLibrary({ onUpload });
			const dropZone = screen.getByText("Drag files here to upload").element();

			dispatchFileDrop(dropZone, [
				new File(["one"], "one.jpg", { type: "image/jpeg" }),
				new File(["two"], "two.jpg", { type: "image/jpeg" }),
			]);
			await expect.element(screen.getByText("Uploading 0/2...")).toBeInTheDocument();

			dispatchFileDrag(dropZone, "dragenter");

			await expect.element(screen.getByText("Uploads are not available here")).toBeInTheDocument();
			expect(dropZone.closest('[aria-live="polite"]')?.className).toContain("border-kumo-danger");
		});

		it("does not start another upload batch while a dropped upload is pending", async () => {
			const onUpload = vi.fn(
				() =>
					new Promise<void>(() => {
						// Keep the first upload pending so a second drop exercises the in-flight guard.
					}),
			);
			const screen = await renderLibrary({ onUpload });
			const dropZone = screen.getByText("Drag files here to upload").element();
			const firstFile = new File(["one"], "one.jpg", { type: "image/jpeg" });

			dispatchFileDrop(dropZone, [
				firstFile,
				new File(["queued"], "queued.jpg", { type: "image/jpeg" }),
			]);
			await expect.element(screen.getByText("Uploading 0/2...")).toBeInTheDocument();

			dispatchFileDrop(dropZone, [new File(["two"], "two.jpg", { type: "image/jpeg" })]);

			await vi.waitFor(() => {
				expect(onUpload).toHaveBeenCalledTimes(1);
			});
			expect(onUpload).toHaveBeenCalledWith(firstFile);
			await expect.element(screen.getByText("Uploading 0/2...")).toBeInTheDocument();
			expect(document.body.textContent).not.toContain("Upload already in progress");
		});

		it("shows a partial failure message for dropped batches", async () => {
			const onUpload = vi
				.fn()
				.mockResolvedValueOnce(undefined)
				.mockRejectedValueOnce(new Error("network failed"));
			const screen = await renderLibrary({ onUpload });
			const dropZone = screen.getByText("Drag files here to upload").element();

			dispatchFileDrop(dropZone, [
				new File(["one"], "one.jpg", { type: "image/jpeg" }),
				new File(["two"], "two.jpg", { type: "image/jpeg" }),
			]);

			await expect.element(screen.getByText("1 file uploaded, 1 file failed")).toBeInTheDocument();
		});

		it("rejects dropped files outside the library upload allowlist", async () => {
			const onUpload = vi.fn().mockResolvedValue(undefined);
			const screen = await renderLibrary({ onUpload });
			const dropZone = screen.getByText("Drag files here to upload").element();

			dispatchFileDrop(dropZone, [
				new File(["script"], "script.sh", { type: "text/x-shellscript" }),
			]);

			await expect
				.element(screen.getByText("The media library does not accept that file"))
				.toBeInTheDocument();
			expect(onUpload).not.toHaveBeenCalled();
		});

		it("uploads accepted dropped files and reports rejected files", async () => {
			const onUpload = vi.fn().mockResolvedValue(undefined);
			const screen = await renderLibrary({ onUpload });
			const dropZone = screen.getByText("Drag files here to upload").element();
			const accepted = new File(["image"], "accepted.jpg", { type: "image/jpeg" });

			dispatchFileDrop(dropZone, [
				accepted,
				new File(["script"], "script.sh", { type: "text/x-shellscript" }),
			]);

			await vi.waitFor(() => {
				expect(onUpload).toHaveBeenCalledTimes(1);
			});
			expect(onUpload).toHaveBeenCalledWith(accepted);
			await expect.element(screen.getByText("1 file uploaded, 1 file failed")).toBeInTheDocument();
		});

		it("accepts dropped files with generic MIME metadata when the extension is allowed", async () => {
			const onUpload = vi.fn().mockResolvedValue(undefined);
			const screen = await renderLibrary({ onUpload });
			const dropZone = screen.getByText("Drag files here to upload").element();
			const file = new File(["pdf"], "proposal.pdf", { type: "application/octet-stream" });

			dispatchFileDrop(dropZone, [file]);

			await vi.waitFor(() => {
				expect(onUpload).toHaveBeenCalledTimes(1);
			});
			expect(onUpload).toHaveBeenCalledWith(file);
		});
	});

	describe("item selection", () => {
		it("clicking an item opens detail panel", async () => {
			const items = [makeMediaItem({ id: "1", filename: "photo.jpg", alt: "A photo" })];
			const screen = await renderLibrary({ items });

			// Click the grid item button
			await screen.getByRole("button", { name: "photo.jpg" }).click();

			// MediaDetailPanel should open showing the item details
			await expect.element(screen.getByText("Media Details")).toBeInTheDocument();
		});
	});

	describe("empty state", () => {
		it("shows upload CTA when no items", async () => {
			const screen = await renderLibrary({ items: [] });
			await expect.element(screen.getByText("No media yet")).toBeInTheDocument();
			await expect.element(screen.getByText(UPLOAD_CTA_PATTERN)).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }))
				.toBeInTheDocument();
		});
	});

	describe("loading state", () => {
		it("displays loading state", async () => {
			const screen = await renderLibrary({ isLoading: true });
			// When loading, neither empty state nor items are shown
			expect(screen.getByText("No media yet").query()).toBeNull();
		});
	});

	describe("list view details", () => {
		it("list view shows table with filename and details", async () => {
			const items = [
				makeMediaItem({
					id: "1",
					filename: "document.pdf",
					mimeType: "application/pdf",
					size: 1048576,
				}),
			];
			const screen = await renderLibrary({ items });

			// Switch to list view
			await screen.getByRole("button", { name: "List view" }).click();

			await expect.element(screen.getByText("document.pdf")).toBeInTheDocument();
			await expect.element(screen.getByText("application/pdf")).toBeInTheDocument();
			await expect.element(screen.getByText("1 MB")).toBeInTheDocument();
		});
	});

	describe("header", () => {
		it("shows Media Library heading", async () => {
			const screen = await renderLibrary();
			await expect.element(screen.getByText("Media Library")).toBeInTheDocument();
		});
	});

	describe("load more pagination", () => {
		it("renders Load More button when hasMore is true", async () => {
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({ items, hasMore: true, onLoadMore: vi.fn() });
			await expect.element(screen.getByRole("button", { name: "Load More" })).toBeInTheDocument();
		});

		it("does not render Load More button when hasMore is false", async () => {
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({ items, hasMore: false, onLoadMore: vi.fn() });
			expect(screen.getByRole("button", { name: "Load More" }).query()).toBeNull();
		});

		it("invokes onLoadMore when Load More button is clicked", async () => {
			const onLoadMore = vi.fn();
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({ items, hasMore: true, onLoadMore });
			await screen.getByRole("button", { name: "Load More" }).click();
			expect(onLoadMore).toHaveBeenCalled();
		});

		it("keeps already-loaded items visible while fetching the next page (isLoading=true with items)", async () => {
			// Reproduces the Copilot review concern: when isLoading flips true
			// during a Load-More fetch, the grid must not be blanked out into a
			// centered spinner — already-rendered items should remain visible.
			const items = [makeMediaItem({ id: "1", filename: "first-page.jpg" })];
			const screen = await renderLibrary({
				items,
				isLoading: true,
				hasMore: true,
				onLoadMore: vi.fn(),
			});
			await expect.element(screen.getByAltText("first-page.jpg")).toBeInTheDocument();
		});
	});

	// #1221: the local library gained filename search + a type filter.
	describe("local search and filter", () => {
		it("reports the debounced filename query upward", async () => {
			const onLocalSearchChange = vi.fn();
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({ items, onLocalSearchChange });

			await screen.getByRole("searchbox", { name: "Search media" }).fill("vacation");

			await vi.waitFor(() => {
				expect(onLocalSearchChange).toHaveBeenCalledWith("vacation");
			});
		});

		it("reports a MIME filter when a type is chosen", async () => {
			const onLocalMimeFilterChange = vi.fn();
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({ items, onLocalMimeFilterChange });

			// Open the type filter and choose Images.
			await screen.getByRole("combobox", { name: "Filter by type" }).click();
			await screen.getByRole("option", { name: "Images" }).click();

			expect(onLocalMimeFilterChange).toHaveBeenCalledWith("image/");
		});
	});
});
