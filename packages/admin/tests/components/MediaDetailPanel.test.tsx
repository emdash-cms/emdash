import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "vitest-browser-react";

import { MediaDetailPanel } from "../../src/components/MediaDetailPanel";
import type { MediaItem } from "../../src/lib/api";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		updateMedia: vi.fn().mockResolvedValue({}),
		deleteMedia: vi.fn().mockResolvedValue({}),
	};
});

// Import the mocked functions for assertions
import { updateMedia, deleteMedia } from "../../src/lib/api";

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderPanel(props: Partial<React.ComponentProps<typeof MediaDetailPanel>> = {}) {
	const defaultProps = {
		item: null as MediaItem | null,
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

describe("MediaDetailPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("renders nothing when item is null", async () => {
		const screen = await renderPanel({ item: null });
		// The component returns null, so "Media Details" heading shouldn't exist
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
	});

	it("hides caption textarea for non-images", async () => {
		const pdfItem = makePdfItem();
		const screen = await renderPanel({ item: pdfItem });
		await expect
			.element(screen.getByLabelText("Caption"), { timeout: 100 })
			.not.toBeInTheDocument();
	});

	it("filename input is disabled", async () => {
		const item = makeImageItem();
		const screen = await renderPanel({ item });
		const filenameInput = screen.getByLabelText("Filename");
		await expect.element(filenameInput).toBeDisabled();
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
		const item = makeImageItem({ alt: "Old alt", caption: "Old caption" });
		const screen = await renderPanel({ item });

		const altInput = screen.getByLabelText("Alt Text");
		await altInput.fill("New alt");

		const saveBtn = screen.getByRole("button", { name: "Save" });
		await saveBtn.click();

		expect(updateMedia).toHaveBeenCalledWith("media-1", {
			alt: "New alt",
			caption: "Old caption",
		});
	});

	it("delete with confirm calls deleteMedia and onClose + onDeleted", async () => {
		const onClose = vi.fn();
		const onDeleted = vi.fn();
		const item = makeImageItem();

		const screen = await renderPanel({ item, onClose, onDeleted });
		const deleteBtn = screen.getByRole("button", { name: "Delete" });
		await deleteBtn.click();

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

	it("delete cancelled does not call deleteMedia", async () => {
		const item = makeImageItem();

		const screen = await renderPanel({ item });
		const deleteBtn = screen.getByRole("button", { name: "Delete" });
		await deleteBtn.click();

		// ConfirmDialog should appear
		await expect.element(screen.getByText("Delete Media?")).toBeInTheDocument();

		// Direct DOM click to bypass Base UI inert overlay
		screen.getByRole("button", { name: "Cancel" }).element().click();

		expect(deleteMedia).not.toHaveBeenCalled();
	});

	it("escape key calls onClose", async () => {
		const onClose = vi.fn();
		const item = makeImageItem();
		await renderPanel({ item, onClose });

		await new Promise<void>((resolve) => {
			window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
			resolve();
		});

		expect(onClose).toHaveBeenCalled();
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
				<MediaDetailPanel item={item2} onClose={vi.fn()} onDeleted={vi.fn()} />
			</QueryWrapper>,
		);

		// The alt text should now show item2's alt
		await expect.element(screen.getByLabelText("Alt Text")).toHaveValue("Alt two");
	});
});
