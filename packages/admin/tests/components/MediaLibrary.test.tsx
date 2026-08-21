import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MediaLibrary } from "../../src/components/MediaLibrary";
import type { MediaItem } from "../../src/lib/api";
import { deleteMedia } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPLOAD_CTA_PATTERN = /Upload images, videos, and documents to keep reusable assets/;
const UPLOAD_TO_LIBRARY_PATTERN = /Upload to Library/;
const UPLOAD_FILES_PATTERN = /Upload Files/;

function setInputFiles(input: HTMLInputElement, files: File[]) {
	const transfer = new DataTransfer();
	for (const file of files) transfer.items.add(file);
	input.files = transfer.files;
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

function dropFiles(target: EventTarget, files: File[]) {
	const transfer = new DataTransfer();
	for (const file of files) transfer.items.add(file);
	target.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true }));
	target.dispatchEvent(new DragEvent("drop", { dataTransfer: transfer, bubbles: true }));
}

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

function renderLibrary(props: Partial<React.ComponentProps<typeof MediaLibrary>> = {}) {
	const defaultProps: React.ComponentProps<typeof MediaLibrary> = {
		items: [],
		isLoading: false,
		onUpload: vi.fn(),
		onSelect: vi.fn(),
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
			await expect.element(screen.getByRole("tab", { name: "Grid view" })).toBeInTheDocument();
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
			const listBtn = screen.getByRole("tab", { name: "List view" });
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
		it("opens an empty upload dialog from the page action", async () => {
			const onUpload = vi.fn();
			const screen = await renderLibrary({ onUpload });

			screen.getByRole("button", { name: UPLOAD_TO_LIBRARY_PATTERN }).element().click();

			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: "Browse files", exact: true }))
				.toBeInTheDocument();
			expect(onUpload).not.toHaveBeenCalled();
		});

		it("opens the same empty dialog from the empty-state action", async () => {
			const screen = await renderLibrary();

			screen.getByRole("button", { name: UPLOAD_FILES_PATTERN }).element().click();

			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
		});

		it("opens the upload dialog and caps parallel uploads at three", async () => {
			const pending: Array<{ file: File; resolve: () => void }> = [];
			const onUpload = vi.fn(
				(file: File, _options?: { signal?: AbortSignal }) =>
					new Promise<void>((resolve) => {
						pending.push({ file, resolve });
					}),
			);
			const screen = await renderLibrary({ onUpload });
			const files = ["one.jpg", "two.jpg", "three.jpg", "four.jpg"].map(
				(name) => new File([name], name, { type: "image/jpeg" }),
			);

			screen.getByRole("button", { name: UPLOAD_TO_LIBRARY_PATTERN }).element().click();
			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
			setInputFiles(
				screen.getByLabelText("Browse files to upload").element() as HTMLInputElement,
				files,
			);

			await vi.waitFor(() => expect(onUpload).toHaveBeenCalledTimes(3));
			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
			await expect.element(screen.getByText("Queued", { exact: true })).toBeInTheDocument();

			const firstSignal = onUpload.mock.calls[0]?.[1]?.signal;
			screen.getByRole("button", { name: "Cancel one.jpg" }).element().click();
			expect(firstSignal?.aborted).toBe(true);
			await vi.waitFor(() => expect(onUpload).toHaveBeenCalledTimes(4));
			pending.forEach(({ resolve }) => resolve());
		});

		it("clears the page overlay when a file drag leaves the window", async () => {
			const screen = await renderLibrary();
			const transfer = new DataTransfer();
			transfer.items.add(new File(["image"], "dragged.jpg", { type: "image/jpeg" }));
			window.dispatchEvent(new DragEvent("dragenter", { dataTransfer: transfer, bubbles: true }));
			await expect.element(screen.getByText("Drop files to upload")).toBeInTheDocument();

			window.dispatchEvent(new DragEvent("dragleave", { relatedTarget: null, bubbles: true }));

			await vi.waitFor(() => expect(screen.getByText("Drop files to upload").query()).toBeNull());
		});

		it("opens the same direct-upload dialog for files dropped on the page", async () => {
			const onUpload = vi.fn().mockResolvedValue(undefined);
			const screen = await renderLibrary({ onUpload });
			const files = [
				new File(["image"], "dropped.jpg", { type: "image/jpeg" }),
				new File(["pdf"], "notes.pdf", { type: "application/pdf" }),
			];

			dropFiles(window, files);

			await vi.waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
		});

		it("retries one failed file without restarting completed files", async () => {
			const onUpload = vi
				.fn<(file: File) => Promise<void>>()
				.mockRejectedValueOnce(new Error("network"))
				.mockResolvedValue(undefined);
			const screen = await renderLibrary({ onUpload });

			screen.getByRole("button", { name: UPLOAD_TO_LIBRARY_PATTERN }).element().click();
			await expect
				.element(screen.getByRole("heading", { name: "Upload to Library" }))
				.toBeInTheDocument();
			setInputFiles(screen.getByLabelText("Browse files to upload").element() as HTMLInputElement, [
				new File(["broken"], "broken.jpg", { type: "image/jpeg" }),
			]);

			await expect.element(screen.getByText("Upload failed", { exact: true })).toBeInTheDocument();
			screen.getByRole("button", { name: "Retry broken.jpg" }).element().click();

			await vi.waitFor(() => expect(onUpload).toHaveBeenCalledTimes(2));
			await expect.element(screen.getByText("Complete", { exact: true })).toBeInTheDocument();
		});
	});

	describe("item selection", () => {
		it("clicking an item opens detail dialog", async () => {
			const items = [makeMediaItem({ id: "1", filename: "photo.jpg", alt: "A photo" })];
			const screen = await renderLibrary({ items });

			// Click the grid item button
			await screen.getByRole("button", { name: "photo.jpg" }).click();

			// MediaDetailPanel should open showing the item details
			await expect.element(screen.getByText("Media Details")).toBeInTheDocument();
		});

		it("opens the detail dialog on an animation frame so Kumo entry animation runs", async () => {
			let openFrame: FrameRequestCallback | undefined;
			const requestAnimationFrameSpy = vi
				.spyOn(window, "requestAnimationFrame")
				.mockImplementation((callback) => {
					openFrame = callback;
					return 1;
				});
			const cancelAnimationFrameSpy = vi
				.spyOn(window, "cancelAnimationFrame")
				.mockImplementation(() => undefined);

			try {
				const items = [makeMediaItem({ id: "1", filename: "photo.jpg", alt: "A photo" })];
				const screen = await renderLibrary({ items });

				await screen.getByRole("button", { name: "photo.jpg" }).click();

				expect(requestAnimationFrameSpy).toHaveBeenCalledTimes(1);
				await expect
					.element(screen.getByText("Media Details"), { timeout: 100 })
					.not.toBeInTheDocument();

				openFrame?.(performance.now());

				await expect.element(screen.getByText("Media Details")).toBeInTheDocument();
			} finally {
				requestAnimationFrameSpy.mockRestore();
				cancelAnimationFrameSpy.mockRestore();
			}
		});

		it("preserves unsaved alt text when the media list refetches the same item", async () => {
			const item = makeMediaItem({ id: "1", filename: "photo.jpg", alt: "Server alt" });
			const screen = await renderLibrary({ items: [item] });

			await screen.getByRole("button", { name: "photo.jpg" }).click();
			await screen.getByLabelText("Alt Text").fill("Unsaved alt");

			await screen.rerender(
				<QueryWrapper>
					<MediaLibrary
						items={[makeMediaItem({ id: "1", filename: "photo.jpg", alt: "Refetched alt" })]}
						isLoading={false}
					/>
				</QueryWrapper>,
			);

			await expect.element(screen.getByLabelText("Alt Text")).toHaveValue("Unsaved alt");
		});

		it("deletes from the detail dialog with one local delete call", async () => {
			const onItemUpdated = vi.fn();
			const items = [makeMediaItem({ id: "1", filename: "photo.jpg" })];
			const screen = await renderLibrary({ items, onItemUpdated });

			await screen.getByRole("button", { name: "photo.jpg" }).click();
			screen.getByRole("button", { name: "Delete" }).element().click();
			await expect.element(screen.getByText("Delete Media?")).toBeInTheDocument();
			screen.getByRole("button", { name: "Delete" }).all().at(-1)!.element().click();

			await vi.waitFor(() => {
				expect(deleteMedia).toHaveBeenCalledTimes(1);
				expect(deleteMedia).toHaveBeenCalledWith("1");
				expect(onItemUpdated).toHaveBeenCalledTimes(1);
			});
		});

		it("focuses the persistent heading after deleting the last asset", async () => {
			function Harness() {
				const [items, setItems] = React.useState([
					makeMediaItem({ id: "1", filename: "photo.jpg" }),
				]);
				return <MediaLibrary items={items} isLoading={false} onItemUpdated={() => setItems([])} />;
			}

			const screen = await render(
				<QueryWrapper>
					<Harness />
				</QueryWrapper>,
			);

			await screen.getByRole("button", { name: "photo.jpg" }).click();
			screen.getByRole("button", { name: "Delete" }).element().click();
			await expect.element(screen.getByText("Delete Media?")).toBeInTheDocument();
			screen.getByRole("button", { name: "Delete" }).all().at(-1)!.element().click();

			await vi.waitFor(() => {
				expect(document.activeElement).toBe(
					screen.getByRole("heading", { name: "Media Library", exact: true }).element(),
				);
			});
		});
	});

	describe("empty state", () => {
		it("shows upload CTA when no items", async () => {
			const screen = await renderLibrary({ items: [] });
			await expect.element(screen.getByText("Your media library is empty")).toBeInTheDocument();
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
			expect(screen.getByText("Your media library is empty").query()).toBeNull();
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
			await screen.getByRole("tab", { name: "List view" }).click();

			await expect.element(screen.getByText("document.pdf")).toBeInTheDocument();
			await expect.element(screen.getByText("application/pdf")).toBeInTheDocument();
			await expect.element(screen.getByText("1 MB")).toBeInTheDocument();
		});
	});

	describe("header", () => {
		it("shows Media Library heading", async () => {
			const screen = await renderLibrary();
			await expect
				.element(screen.getByRole("heading", { name: "Media Library", exact: true }))
				.toBeInTheDocument();
		});
	});

	describe("load more pagination", () => {
		it("renders Load More button when hasMore is true", async () => {
			const items = [makeMediaItem({ id: "1", filename: "a.jpg" })];
			const screen = await renderLibrary({ items, hasMore: true, onLoadMore: vi.fn() });
			await expect.element(screen.getByRole("button", { name: "Load More" })).toBeInTheDocument();
			expect(screen.getByText("1 item").query()).toBeNull();
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

		it("does not flash the empty-library state while clearing a zero-result search", async () => {
			function Harness() {
				const [search, setSearch] = React.useState("");
				const items = search ? [] : [makeMediaItem({ id: "1", filename: "restored.jpg" })];

				return <MediaLibrary items={items} onLocalSearchChange={setSearch} isLoading={false} />;
			}

			const screen = await render(
				<QueryWrapper>
					<Harness />
				</QueryWrapper>,
			);

			await screen.getByRole("searchbox", { name: "Search media" }).fill("missing");
			await expect.element(screen.getByText("No matching media")).toBeInTheDocument();

			await screen.getByRole("searchbox", { name: "Search media" }).fill("");

			expect(screen.getByText("Your media library is empty").query()).toBeNull();
			await expect.element(screen.getByAltText("restored.jpg")).toBeInTheDocument();
		});

		it("does not keep the local filter toolbar visible on empty provider tabs", async () => {
			const api = await import("../../src/lib/api");
			(api.fetchMediaProviders as any).mockResolvedValueOnce([
				{
					id: "cloudflare-images",
					name: "Cloudflare Images",
					capabilities: { browse: true, search: false, upload: false, delete: false },
				},
			]);

			const screen = await renderLibrary({
				items: [makeMediaItem({ id: "1", filename: "a.jpg" })],
			});

			await screen.getByRole("combobox", { name: "Filter by type" }).click();
			await screen.getByRole("option", { name: "Images" }).click();
			await screen.getByRole("tab", { name: "Cloudflare Images" }).click();

			await expect.element(screen.getByText("No media found")).toBeInTheDocument();
			expect(screen.getByRole("tab", { name: "Grid view" }).query()).toBeNull();
			expect(screen.getByRole("tab", { name: "List view" }).query()).toBeNull();
		});
	});
});
