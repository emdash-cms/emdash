import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";
import { userEvent } from "vitest/browser";

import { MediaDetailPanel } from "../../src/components/MediaDetailPanel";
import { ApiResponseError, type LocalMediaItem, type MediaItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

const TEST_IMAGE_URL =
	"data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='100' height='100'%3E%3Crect width='100' height='100' fill='gray'/%3E%3C/svg%3E";

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

vi.mock("../../src/components/MediaUsedIn.js", () => ({
	MediaUsedIn: ({ mediaId, open }: { mediaId: string; open: boolean }) =>
		open ? <div data-testid="media-used-in" data-media-id={mediaId} /> : null,
}));

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

const STREAM_HLS = "https://customer-abc123.cloudflarestream.com/UID/manifest/video.m3u8";
const STREAM_DASH = "https://customer-abc123.cloudflarestream.com/UID/manifest/video.mpd";
const STREAM_POSTER = "https://customer-abc123.cloudflarestream.com/UID/thumbnails/thumbnail.jpg";

/**
 * A Cloudflare Stream item. The distinguishing trait is that `url` is a poster
 * image rather than a playable file; the video itself is only reachable through
 * `meta.playback`.
 */
function makeStreamItem(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: "6a4677c7694f6e2e4270540231dd47ff",
		filename: "webinar.mp4",
		mimeType: "video/mp4",
		url: STREAM_POSTER,
		size: 75431883,
		width: 1280,
		height: 720,
		createdAt: "2025-01-15T10:30:00Z",
		provider: "cloudflare-stream",
		meta: { playback: { hls: STREAM_HLS, dash: STREAM_DASH } },
		...overrides,
	};
}

/** A locally stored video, whose `url` *is* the playable file. */
function makeLocalVideoItem(overrides: Partial<MediaItem> = {}): MediaItem {
	return {
		id: "media-3",
		filename: "clip.mp4",
		mimeType: "video/mp4",
		url: "https://example.com/clip.mp4",
		size: 5242880,
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

async function openFocalEditor(screen: Awaited<ReturnType<typeof renderPanel>>) {
	const editTab = screen.getByRole("tab", { name: "Focal point" }).element();
	editTab.focus();
	editTab.click();
	const surface = screen.getByRole("button", {
		name: "Focal point. Use arrow keys to move it.",
	});
	await expect.element(surface).toBeVisible();
	surface.element().focus();
	await expect.element(surface).toHaveFocus();
	return surface;
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
		await expect.element(screen.getByText("JPEG")).toBeInTheDocument();
		await expect.element(screen.getByText("Size:")).toBeInTheDocument();
		await expect.element(screen.getByText("Dimensions:")).toBeInTheDocument();
		await expect.element(screen.getByText("Uploaded:")).toBeInTheDocument();
		await expect.element(screen.getByText("Format:")).toBeInTheDocument();
	});

	it("groups the preview, metadata, and actions in an accessible dialog", async () => {
		const screen = await renderPanel();
		const dialog = screen.getByRole("dialog", { name: "Media Details" }).element();
		const preview = screen.getByAltText("A nice photo");
		const filename = screen.getByLabelText("Filename");
		const altText = screen.getByLabelText("Alt Text");
		const caption = screen.getByLabelText("Caption");
		const close = screen.getByRole("button", { name: "Close" });
		const deleteButton = screen.getByRole("button", { name: "Delete" });
		const cancel = screen.getByRole("button", { name: "Cancel" });
		const save = screen.getByRole("button", { name: "Save" });

		for (const locator of [
			preview,
			filename,
			altText,
			caption,
			close,
			deleteButton,
			cancel,
			save,
		]) {
			await expect.element(locator).toBeVisible();
			expect(dialog).toContainElement(locator.element());
		}
		await expect.element(screen.getByText("200 KB")).toBeVisible();
		await expect.element(screen.getByText("1920 × 1080")).toBeVisible();
	});

	it("keeps the dialog height stable while switching image tabs", async () => {
		const screen = await renderPanel({ item: makeImageItem({ url: TEST_IMAGE_URL }) });
		const dialog = screen.getByRole("dialog", { name: "Media Details" }).element();
		const detailsHeight = dialog.getBoundingClientRect().height;

		screen.getByRole("tab", { name: "Used in" }).element().click();
		await expect.element(screen.getByTestId("media-used-in")).toBeInTheDocument();
		expect(dialog.getBoundingClientRect().height).toBe(detailsHeight);

		screen.getByRole("tab", { name: "Focal point" }).element().click();
		await expect.element(screen.getByTestId("focal-preview-square")).toBeVisible();

		expect(dialog.getBoundingClientRect().height).toBe(detailsHeight);
	});

	it("shows usage only in its dedicated local-image tab", async () => {
		const screen = await renderPanel();
		const dialog = screen.getByRole("dialog", { name: "Media Details" }).element();
		expect(Array.from(dialog.querySelectorAll('[role="tab"]'), (tab) => tab.textContent)).toEqual([
			"Details",
			"Used in",
			"Focal point",
		]);
		await expect
			.element(screen.getByTestId("media-used-in"), { timeout: 100 })
			.not.toBeInTheDocument();

		screen.getByRole("tab", { name: "Focal point" }).element().click();
		await expect
			.element(screen.getByTestId("media-used-in"), { timeout: 100 })
			.not.toBeInTheDocument();

		screen.getByRole("tab", { name: "Used in" }).element().click();
		await expect.element(screen.getByRole("tabpanel", { name: "Used in" })).toBeInTheDocument();
		await expect
			.element(screen.getByTestId("media-used-in"))
			.toHaveAttribute("data-media-id", "media-1");
		await expect.element(screen.getByAltText("A nice photo")).not.toBeVisible();
		await expect.element(screen.getByLabelText("Filename")).not.toBeVisible();
	});

	it("gives non-image local media a dedicated usage tab", async () => {
		const screen = await renderPanel({ item: makePdfItem() });
		const dialog = screen.getByRole("dialog", { name: "Media Details" }).element();
		expect(Array.from(dialog.querySelectorAll('[role="tab"]'), (tab) => tab.textContent)).toEqual([
			"Details",
			"Used in",
		]);
		await expect.element(screen.getByText("application/pdf")).toBeVisible();

		screen.getByRole("tab", { name: "Used in" }).element().click();
		await expect.element(screen.getByTestId("media-used-in")).toBeInTheDocument();
		await expect.element(screen.getByText("application/pdf")).not.toBeVisible();
	});

	it("does not offer usage for provider media", async () => {
		const screen = await renderPanel({
			item: makeImageItem({ provider: "cloudflare-images" }),
		});

		expect(screen.getByRole("tab", { name: "Used in" }).query()).toBeNull();
		await expect
			.element(screen.getByTestId("media-used-in"), { timeout: 100 })
			.not.toBeInTheDocument();
	});

	it("shows image preview for image mimeTypes", async () => {
		const item = makeImageItem();
		const screen = await renderPanel({ item });
		const img = screen.getByAltText("A nice photo");
		await expect.element(img).toBeInTheDocument();
		await expect.element(img).toHaveAttribute("src", item.url);
	});

	it("separates image details from focal-point editing with tabs", async () => {
		const screen = await renderPanel({
			item: makeLocalItem({ url: TEST_IMAGE_URL }),
			canMoveLocation: true,
		});

		await expect
			.element(screen.getByRole("tab", { name: "Details" }))
			.toHaveAttribute("aria-selected", "true");
		await expect.element(screen.getByLabelText("Filename")).toBeVisible();
		await expect
			.element(screen.getByRole("button", { name: "Focal point. Use arrow keys to move it." }))
			.not.toBeInTheDocument();
		expect(screen.getByTestId("focal-preview-square").query()).toBeNull();

		const editTab = screen.getByRole("tab", { name: "Focal point" });
		editTab.element().focus();
		editTab.element().click();

		await expect.element(editTab).toHaveFocus();
		await expect
			.element(screen.getByRole("button", { name: "Focal point. Use arrow keys to move it." }))
			.toBeVisible();
		await expect
			.element(
				screen.getByText("Move the focal point to choose what stays visible in cropped images."),
			)
			.toBeVisible();
		await expect.element(screen.getByRole("heading", { name: "Preview" })).toBeVisible();
		const previewGroup = screen.getByTestId("focal-preview-group").element();
		const portraitPreview = screen.getByTestId("focal-preview-portrait").element();
		const squarePreview = screen.getByTestId("focal-preview-square").element();
		const landscapePreview = screen.getByTestId("focal-preview-landscape").element();
		await expect.element(squarePreview).toBeVisible();
		expect(
			Array.from(previewGroup.querySelectorAll("figcaption"), (caption) => caption.textContent),
		).toEqual(["Portrait", "Square", "Landscape"]);
		await expect.element(portraitPreview).toBeVisible();
		await expect.element(landscapePreview).toBeVisible();
		expect(
			screen.getByTestId("media-detail-dialog-details-column").element().contains(squarePreview),
		).toBe(true);
		expect(
			screen.getByTestId("media-detail-dialog-preview-column").element().contains(squarePreview),
		).toBe(false);
		await expect.element(screen.getByLabelText("Filename")).not.toBeVisible();

		screen.getByRole("tab", { name: "Details" }).element().click();
		await expect.element(screen.getByLabelText("Filename")).toBeVisible();
	});

	it("preserves the focal-point draft while switching tabs", async () => {
		const screen = await renderPanel({
			item: makeImageItem({ url: TEST_IMAGE_URL, focalX: null, focalY: null }),
		});

		await openFocalEditor(screen);
		await userEvent.keyboard("{ArrowRight}");
		screen.getByRole("tab", { name: "Used in" }).element().click();
		await expect.element(screen.getByTestId("media-used-in")).toBeInTheDocument();
		screen.getByRole("tab", { name: "Focal point" }).element().click();

		const squarePreview = screen.getByTestId("focal-preview-square");
		await expect.element(squarePreview).toBeVisible();
		expect(squarePreview.element().style.objectPosition).toBe("51% 50%");
	});

	it("edits the focal point with the keyboard and saves only the focal pair", async () => {
		const screen = await renderPanel({
			item: makeImageItem({ url: TEST_IMAGE_URL, focalX: null, focalY: null }),
		});

		await openFocalEditor(screen);
		await userEvent.keyboard("{ArrowRight}");
		await userEvent.keyboard("{Shift>}{ArrowDown}{/Shift}");
		await expect.element(screen.getByRole("button", { name: "Reset" })).toBeEnabled();

		const squarePreview = screen.getByTestId("focal-preview-square").element();
		expect(squarePreview.style.objectPosition).toBe("51% 55%");
		await expect
			.element(screen.getByRole("status"))
			.toHaveTextContent("Horizontal 51%, vertical 55%");

		screen.getByRole("button", { name: "Save" }).element().click();
		await vi.waitFor(() => {
			expect(updateMedia).toHaveBeenCalledWith("media-1", {
				focalX: 0.51,
				focalY: 0.55,
			});
		});
	});

	it("keeps the focal draft visible when saving fails", async () => {
		vi.mocked(updateMedia).mockRejectedValueOnce(new Error("Update failed"));
		const screen = await renderPanel({ item: makeImageItem({ url: TEST_IMAGE_URL }) });
		await openFocalEditor(screen);
		await userEvent.keyboard("{ArrowRight}");
		const saveButton = screen.getByRole("button", { name: "Save" });
		await expect.element(saveButton).toBeEnabled();
		saveButton.element().click();

		await expect.element(screen.getByText("Update failed")).toBeVisible();
		expect(screen.getByTestId("focal-preview-square").element().style.objectPosition).toBe(
			"51% 50%",
		);
	});

	it("keeps one active pointer and clears it after cancellation or lost capture", async () => {
		const screen = await renderPanel({ item: makeImageItem({ url: TEST_IMAGE_URL }) });
		const surfaceLocator = await openFocalEditor(screen);
		const surface = surfaceLocator.element();
		vi.spyOn(surface, "getBoundingClientRect").mockReturnValue({
			x: 0,
			y: 0,
			left: 0,
			top: 0,
			right: 100,
			bottom: 100,
			width: 100,
			height: 100,
			toJSON: () => ({}),
		});
		vi.spyOn(surface, "setPointerCapture").mockImplementation(() => {});
		vi.spyOn(surface, "hasPointerCapture").mockReturnValue(true);
		const release = vi.spyOn(surface, "releasePointerCapture").mockImplementation(() => {});

		surface.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				pointerId: 1,
				clientX: 80,
				clientY: 20,
			}),
		);
		await vi.waitFor(() => {
			expect(screen.getByTestId("focal-preview-square").element().style.objectPosition).toBe(
				"80% 20%",
			);
		});

		surface.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				pointerId: 2,
				clientX: 10,
				clientY: 90,
			}),
		);
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		expect(screen.getByTestId("focal-preview-square").element().style.objectPosition).toBe(
			"80% 20%",
		);

		surface.dispatchEvent(new PointerEvent("lostpointercapture", { bubbles: true, pointerId: 1 }));
		surface.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				pointerId: 1,
				clientX: 10,
				clientY: 90,
			}),
		);
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		expect(screen.getByTestId("focal-preview-square").element().style.objectPosition).toBe(
			"80% 20%",
		);

		surface.dispatchEvent(
			new PointerEvent("pointerdown", {
				bubbles: true,
				pointerId: 3,
				clientX: 30,
				clientY: 30,
			}),
		);
		await vi.waitFor(() => {
			expect(screen.getByTestId("focal-preview-square").element().style.objectPosition).toBe(
				"30% 30%",
			);
		});
		surface.dispatchEvent(new PointerEvent("pointercancel", { bubbles: true, pointerId: 3 }));
		surface.dispatchEvent(
			new PointerEvent("pointermove", {
				bubbles: true,
				pointerId: 3,
				clientX: 90,
				clientY: 90,
			}),
		);
		await new Promise((resolve) => window.setTimeout(resolve, 0));
		expect(screen.getByTestId("focal-preview-square").element().style.objectPosition).toBe(
			"30% 30%",
		);
		expect(release).toHaveBeenCalledWith(3);
	});

	it("resets a custom focal point to the centered fallback", async () => {
		const screen = await renderPanel({
			item: makeImageItem({ url: TEST_IMAGE_URL, focalX: 0.2, focalY: 0.8 }),
		});
		await openFocalEditor(screen);
		const resetButton = screen.getByRole("button", { name: "Reset" });
		await expect.element(resetButton).toBeVisible();
		resetButton.element().click();
		const saveButton = screen.getByRole("button", { name: "Save" });
		await expect.element(saveButton).toBeEnabled();
		saveButton.element().click();

		await vi.waitFor(() => {
			expect(updateMedia).toHaveBeenCalledWith("media-1", {
				focalX: null,
				focalY: null,
			});
		});
	});

	it("does not create unsaved changes by opening Focal point", async () => {
		const onClose = vi.fn();
		const screen = await renderPanel({ item: makeImageItem({ url: TEST_IMAGE_URL }), onClose });
		await openFocalEditor(screen);
		screen.getByRole("button", { name: "Cancel" }).element().click();

		expect(onClose).toHaveBeenCalledTimes(1);
		await expect
			.element(screen.getByText("Discard changes?"), { timeout: 100 })
			.not.toBeInTheDocument();
	});

	it("does not show image preview for non-image mimeTypes", async () => {
		const item = makePdfItem();
		const screen = await renderPanel({ item });
		// Should show the mime type text instead of img
		await expect.element(screen.getByText("application/pdf")).toBeInTheDocument();
		expect(screen.getByText("Focal point").query()).toBeNull();
	});

	it("alt text input is editable", async () => {
		const item = makeImageItem({ alt: "Initial alt" });
		const screen = await renderPanel({ item });
		const altInput = screen.getByLabelText("Alt Text");
		await expect.element(altInput).toBeInTheDocument();
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
			});
			expect(onClose).toHaveBeenCalled();
		});
	});

	it("loads bounded Location options only after the control opens", async () => {
		const screen = await renderPanel({ item: makeLocalItem(), canMoveLocation: true });

		expect(fetchMediaFolders).not.toHaveBeenCalled();
		const location = screen.getByRole("combobox", { name: "Location" });
		await expect.element(location).toHaveTextContent("Product photos");
		expect(location.element().querySelector('[dir="auto"]')).toHaveTextContent("Product photos");
		expect(location.element().querySelector('[data-testid="media-location-icon"]')).not.toBeNull();

		location.element().click();

		await vi.waitFor(() => {
			expect(fetchMediaFolders).toHaveBeenCalledWith({
				limit: 100,
				cursor: undefined,
				search: undefined,
			});
		});
		const mainLibraryOption = screen.getByRole("option", { name: "Main library" });
		const folderOption = screen.getByRole("option", { name: "Press" });
		await expect.element(mainLibraryOption).toBeInTheDocument();
		await expect.element(folderOption).toBeInTheDocument();
		expect(
			mainLibraryOption.element().querySelector('[data-testid="media-location-icon"]'),
		).not.toBeNull();
		expect(
			folderOption.element().querySelector('[data-testid="media-location-icon"]'),
		).not.toBeNull();
		expect(folderOption.element().querySelector('[dir="auto"]')).toHaveTextContent("Press");
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
		const currentLocation = screen.getByText("Product photos");
		await expect.element(currentLocation).toBeInTheDocument();
		expect(currentLocation.element()).toHaveAttribute("dir", "auto");
		expect(
			currentLocation.element().parentElement?.querySelector('[data-testid="media-location-icon"]'),
		).not.toBeNull();
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

	it("does not blame the folder when missing-item recovery cannot confirm the state", async () => {
		vi.mocked(updateMedia).mockRejectedValueOnce(
			new ApiResponseError(404, "NOT_FOUND", "Media item not found"),
		);
		vi.mocked(fetchMediaItem).mockRejectedValueOnce(
			new ApiResponseError(503, "MEDIA_FETCH_ERROR", "Failed to fetch media item"),
		);
		const screen = await renderPanel({ item: makeLocalItem(), canMoveLocation: true });

		screen.getByRole("combobox", { name: "Location" }).element().click();
		await expect.element(screen.getByRole("option", { name: "Main library" })).toBeInTheDocument();
		screen.getByRole("option", { name: "Main library" }).element().click();
		const save = screen.getByRole("button", { name: "Save" });
		await expect.element(save).toBeEnabled();
		save.element().click();

		await expect
			.element(
				screen.getByText(
					"Couldn’t confirm whether the media item or selected folder still exists. Try again.",
				),
			)
			.toBeInTheDocument();
		expect(
			screen
				.getByText("The selected folder no longer exists. Choose another location and save again.")
				.query(),
		).toBeNull();
	});

	it("does not consume the keyboard save shortcut when nothing can be saved", async () => {
		const screen = await renderPanel({
			item: makeImageItem({ provider: "cloudflare-images" }),
			providerName: "Cloudflare Images",
		});
		expect(screen.getByText("Focal point").query()).toBeNull();

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
	it("shows a shortened file path while copying the absolute URL", async () => {
		const clipboardWrite = vi.spyOn(navigator.clipboard, "writeText").mockResolvedValue();
		const screen = await renderPanel({
			item: makeImageItem({ url: "/_emdash/api/media/file/01ABC.jpg" }),
		});

		const absolute = new URL("/_emdash/api/media/file/01ABC.jpg", window.location.origin).href;
		const displayedPath = screen.getByText("/_emdash/api/media/file/01ABC.jpg").element();
		expect(displayedPath.textContent).toBe("/_emdash/api/media/file/01ABC.jpg");
		expect(displayedPath.textContent).not.toContain(window.location.origin);
		const copyButton = screen.getByRole("button", { name: /Copy URL/ });
		await expect.element(copyButton).toBeVisible();
		copyButton.element().click();
		await vi.waitFor(() => expect(clipboardWrite).toHaveBeenCalledWith(absolute));
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

	describe("video preview", () => {
		// The dialog may portal outside the render container, so query the document.
		const findVideo = () => document.querySelector("video");

		it("plays a streaming item's HLS/DASH sources rather than its poster URL", async () => {
			const screen = await renderPanel({
				item: makeStreamItem(),
				providerName: "Cloudflare Stream",
			});
			await expect.element(screen.getByText("Media Details")).toBeInTheDocument();

			const video = findVideo();
			expect(video).not.toBeNull();

			// Regression: `url` is the thumbnail. Using it as `src` produced a
			// player stuck at 0:00 for every Stream asset.
			expect(video?.getAttribute("src")).toBeNull();
			expect(video?.getAttribute("poster")).toBe(STREAM_POSTER);

			const sources = Array.from(document.querySelectorAll("video source"), (s) => ({
				src: s.getAttribute("src"),
				type: s.getAttribute("type"),
			}));
			expect(sources).toEqual([
				{ src: STREAM_HLS, type: "application/x-mpegURL" },
				{ src: STREAM_DASH, type: "application/dash+xml" },
			]);
		});

		it("omits the DASH source when the provider only reports HLS", async () => {
			const screen = await renderPanel({
				item: makeStreamItem({ meta: { playback: { hls: STREAM_HLS } } }),
				providerName: "Cloudflare Stream",
			});
			await expect.element(screen.getByText("Media Details")).toBeInTheDocument();

			const sources = [...document.querySelectorAll("video source")];
			expect(sources).toHaveLength(1);
			expect(sources[0]?.getAttribute("type")).toBe("application/x-mpegURL");
		});

		it("plays a locally stored video straight from its file URL", async () => {
			const item = makeLocalVideoItem();
			const screen = await renderPanel({ item });
			await expect.element(screen.getByText("Media Details")).toBeInTheDocument();

			const video = findVideo();
			expect(video?.getAttribute("src")).toBe(item.url);
			// No streaming sources: nothing to negotiate for a plain file.
			expect(document.querySelectorAll("video source")).toHaveLength(0);
		});
	});
});
