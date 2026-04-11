import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MediaLibrary } from "../../src/components/MediaLibrary";
import type { MediaItem } from "../../src/lib/api";
import { render } from "../utils/render.js";

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

function renderLibrary(props: Partial<React.ComponentProps<typeof MediaLibrary>> = {}) {
	const defaultProps: React.ComponentProps<typeof MediaLibrary> = {
		items: [],
		isLoading: false,
		onUpload: vi.fn(),
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
			await expect.element(screen.getByText("Type")).toBeInTheDocument();
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
});
