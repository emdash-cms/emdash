/**
 * GalleryDetailPanel tests: thumbnail selection, caption editing, removal,
 * and the `nodeKey`-keyed resync effect (code-review finding #4 — the panel
 * must not clobber in-progress local edits when a parent re-renders with a
 * new `attributes` object identity for the SAME gallery node, but must reset
 * when the sidebar switches to a DIFFERENT gallery node).
 */
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import {
	GalleryDetailPanel,
	type GalleryDetailPanelProps,
} from "../src/components/editor/GalleryDetailPanel";
import type { GalleryAttributes, GalleryImage } from "../src/components/editor/GalleryNode";
import { render } from "./utils/render.tsx";

vi.mock("../src/lib/api", async () => {
	const actual = await vi.importActual("../src/lib/api");
	return {
		...actual,
		fetchMediaList: vi.fn().mockResolvedValue({ items: [] }),
		fetchMediaProviders: vi.fn().mockResolvedValue([]),
		fetchProviderMedia: vi.fn().mockResolvedValue({ items: [] }),
		fetchMediaItem: vi.fn().mockResolvedValue({
			id: "m2",
			filename: "m2.jpg",
			mimeType: "image/jpeg",
			url: "/media/m2.jpg",
			storageKey: "m2.jpg",
			size: 100,
			status: "ready",
			authorId: "editor-1",
			folderId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		}),
		uploadMedia: vi.fn().mockResolvedValue({}),
		uploadToProvider: vi.fn().mockResolvedValue({}),
		updateMedia: vi.fn().mockResolvedValue({}),
	};
});

vi.mock("../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "editor-1", role: 40 } }),
}));

vi.mock("../src/components/MediaDetailPanel.js", () => ({
	MediaDetailPanel: ({
		open,
		onClose,
		onClosed,
		onItemRefreshed,
		onCroppedCopyCreated,
	}: {
		open: boolean;
		onClose: () => void;
		onClosed?: () => void;
		onItemRefreshed?: (item: unknown) => void;
		onCroppedCopyCreated?: (item: unknown) => void;
	}) =>
		open ? (
			<>
				<button
					type="button"
					onClick={() =>
						onItemRefreshed?.({
							id: "m2",
							filename: "m2.jpg",
							mimeType: "image/jpeg",
							url: "/_emdash/api/media/file/m2.jpg",
							storageKey: "m2.jpg",
							size: 70,
							width: 600,
							height: 400,
							contentHash: "sha256:replaced-gallery",
							status: "ready",
							authorId: "editor-1",
							folderId: null,
							createdAt: "2026-01-01T00:00:00.000Z",
						})
					}
				>
					Refresh gallery asset
				</button>
				<button
					type="button"
					onClick={() => {
						onCroppedCopyCreated?.({
							id: "m2-cropped",
							filename: "m2-cropped.jpg",
							mimeType: "image/jpeg",
							url: "/media/m2-cropped.jpg",
							storageKey: "m2-cropped.jpg",
							size: 80,
							width: 640,
							height: 480,
							focalX: 0.4,
							focalY: 0.6,
							blurhash: "cropped-hash",
							dominantColor: "#123456",
							status: "ready",
							authorId: "editor-1",
							folderId: null,
							createdAt: "2026-01-02T00:00:00.000Z",
						});
						onClose();
						onClosed?.();
					}}
				>
					Use cropped gallery asset
				</button>
			</>
		) : null,
}));

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function makeImage(overrides: Partial<GalleryImage> = {}): GalleryImage {
	return {
		_type: "image",
		_key: "img1",
		asset: { _type: "reference", _ref: "m1", url: "/media/m1.jpg" },
		alt: "Image One",
		...overrides,
	};
}

function threeImages(): GalleryImage[] {
	return [
		makeImage({
			_key: "img1",
			asset: { _type: "reference", _ref: "m1", url: "/media/m1.jpg" },
			alt: "Image One",
		}),
		makeImage({
			_key: "img2",
			asset: { _type: "reference", _ref: "m2", url: "/media/m2.jpg" },
			alt: "Image Two",
		}),
		makeImage({
			_key: "img3",
			asset: { _type: "reference", _ref: "m3", url: "/media/m3.jpg" },
			alt: "Image Three",
		}),
	];
}

type PanelAttrs = GalleryAttributes & { selectedImageKey?: string; nodeKey?: string };

function renderPanel(props: Partial<GalleryDetailPanelProps> & { attributes: PanelAttrs }) {
	const defaultProps: GalleryDetailPanelProps = {
		attributes: props.attributes,
		onUpdate: vi.fn(),
		onDelete: vi.fn(),
		onClose: vi.fn(),
		inline: true,
	};
	return render(
		<QueryWrapper>
			<GalleryDetailPanel {...defaultProps} {...props} />
		</QueryWrapper>,
	);
}

describe("GalleryDetailPanel", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("clicking a thumbnail shows that image's settings card with matching alt value", async () => {
		const attributes: PanelAttrs = { images: threeImages(), columns: 3, nodeKey: "10" };
		const screen = await renderPanel({ attributes });

		// No settings card until a thumbnail is selected.
		expect(screen.getByLabelText("Alt text").query()).toBeNull();

		const thumb = screen.getByRole("img", { name: "Image Two" });
		await expect.element(thumb).toBeInTheDocument();
		thumb.element().closest("button")!.click();

		const altInput = screen.getByLabelText("Alt text");
		await expect.element(altInput).toBeInTheDocument();
		await expect.element(altInput).toHaveValue("Image Two");
	});

	it("editing caption calls onUpdate with the patched images array", async () => {
		const onUpdate = vi.fn();
		const attributes: PanelAttrs = { images: threeImages(), columns: 3, nodeKey: "10" };
		const screen = await renderPanel({ attributes, onUpdate });

		const thumb = screen.getByRole("img", { name: "Image One" });
		await expect.element(thumb).toBeInTheDocument();
		thumb.element().closest("button")!.click();

		const captionInput = screen.getByLabelText("Caption");
		await expect.element(captionInput).toBeInTheDocument();
		const inputEl = captionInput.element() as HTMLInputElement;
		const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
			HTMLInputElement.prototype,
			"value",
		)!.set!;
		nativeInputValueSetter.call(inputEl, "New caption");
		inputEl.dispatchEvent(new Event("input", { bubbles: true }));
		inputEl.dispatchEvent(new Event("change", { bubbles: true }));

		await vi.waitFor(() => {
			expect(onUpdate).toHaveBeenCalled();
		});
		const lastCall = onUpdate.mock.calls.at(-1)![0] as Partial<GalleryAttributes>;
		const patchedImages = lastCall.images!;
		expect(patchedImages.find((img) => img._key === "img1")?.caption).toBe("New caption");
		// Other images are untouched.
		expect(patchedImages.find((img) => img._key === "img2")?.caption).toBeUndefined();
	});

	it("remove button removes only that image", async () => {
		const onUpdate = vi.fn();
		const attributes: PanelAttrs = { images: threeImages(), columns: 3, nodeKey: "10" };
		const screen = await renderPanel({ attributes, onUpdate });

		const removeBtn = screen.getByRole("button", { name: "Remove image 2" });
		await expect.element(removeBtn).toBeInTheDocument();
		removeBtn.element().click();

		await vi.waitFor(() => {
			expect(onUpdate).toHaveBeenCalled();
		});
		const lastCall = onUpdate.mock.calls.at(-1)![0] as Partial<GalleryAttributes>;
		const remaining = lastCall.images!;
		expect(remaining).toHaveLength(2);
		expect(remaining.map((img) => img._key)).toEqual(["img1", "img3"]);
	});

	it("does not clobber local edits when re-rendered with the same nodeKey but a new attrs identity", async () => {
		const onUpdate = vi.fn();
		const attributes: PanelAttrs = { images: threeImages(), columns: 3, nodeKey: "10" };
		const screen = await renderPanel({ attributes, onUpdate });

		// Local edit: remove the second image.
		const removeBtn = screen.getByRole("button", { name: "Remove image 2" });
		await expect.element(removeBtn).toBeInTheDocument();
		removeBtn.element().click();
		await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));

		// Re-render with a brand-new `attributes` object (new identity) but the
		// SAME nodeKey and the ORIGINAL (stale, unedited) images — simulating a
		// parent re-wrapping attrs without the sidebar having switched nodes.
		const staleAttrs: PanelAttrs = { images: threeImages(), columns: 3, nodeKey: "10" };
		await screen.rerender(
			<QueryWrapper>
				<GalleryDetailPanel
					attributes={staleAttrs}
					onUpdate={onUpdate}
					onDelete={vi.fn()}
					onClose={vi.fn()}
					inline
				/>
			</QueryWrapper>,
		);

		// The removed image must still be gone — local state was not clobbered.
		expect(screen.getByRole("img", { name: "Image Two" }).query()).toBeNull();
		await expect.element(screen.getByRole("img", { name: "Image One" })).toBeInTheDocument();
		await expect.element(screen.getByRole("img", { name: "Image Three" })).toBeInTheDocument();
	});

	it("resets local state when re-rendered with a different nodeKey", async () => {
		const onUpdate = vi.fn();
		const attributes: PanelAttrs = { images: threeImages(), columns: 3, nodeKey: "10" };
		const screen = await renderPanel({ attributes, onUpdate });

		// Local edit: remove the second image.
		const removeBtn = screen.getByRole("button", { name: "Remove image 2" });
		await expect.element(removeBtn).toBeInTheDocument();
		removeBtn.element().click();
		await vi.waitFor(() => expect(onUpdate).toHaveBeenCalledTimes(1));
		expect(screen.getByRole("img", { name: "Image Two" }).query()).toBeNull();

		// Re-render for a DIFFERENT gallery node (different nodeKey, fresh images).
		const otherNodeImages: GalleryImage[] = [
			makeImage({
				_key: "other1",
				asset: { _type: "reference", _ref: "o1", url: "/media/o1.jpg" },
				alt: "Other Image",
			}),
		];
		const otherAttrs: PanelAttrs = { images: otherNodeImages, columns: 2, nodeKey: "20" };
		await screen.rerender(
			<QueryWrapper>
				<GalleryDetailPanel
					attributes={otherAttrs}
					onUpdate={onUpdate}
					onDelete={vi.fn()}
					onClose={vi.fn()}
					inline
				/>
			</QueryWrapper>,
		);

		// The panel now reflects the new node's images — the previous node's
		// edited state is gone, replaced with the new node's snapshot.
		await expect.element(screen.getByRole("img", { name: "Other Image" })).toBeInTheDocument();
		expect(screen.getByRole("img", { name: "Image One" }).query()).toBeNull();
		expect(screen.getByRole("img", { name: "Image Three" }).query()).toBeNull();
	});

	it("reorders gallery images with the keyboard and announces the new position", async () => {
		const onUpdate = vi.fn();
		const screen = await renderPanel({
			attributes: { images: threeImages(), columns: 3, nodeKey: "10" },
			onUpdate,
		});
		const first = screen.getByRole("button", { name: "Image One" });
		first.element().focus();

		first
			.element()
			.dispatchEvent(
				new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }),
			);
		await expect.element(first).toHaveAttribute("aria-pressed", "true");
		await new Promise((resolve) => window.setTimeout(resolve, 50));
		document.dispatchEvent(
			new KeyboardEvent("keydown", {
				key: "ArrowDown",
				code: "ArrowDown",
				bubbles: true,
				cancelable: true,
			}),
		);
		await new Promise((resolve) => window.setTimeout(resolve, 50));
		await expect
			.element(screen.getByText("Moving Image One to position 2 of 3."))
			.toBeInTheDocument();
		document.dispatchEvent(
			new KeyboardEvent("keydown", { key: " ", code: "Space", bubbles: true, cancelable: true }),
		);

		await vi.waitFor(() => expect(onUpdate).toHaveBeenCalled());
		const images = onUpdate.mock.calls.at(-1)?.[0].images as GalleryImage[];
		expect(images.map((image) => image._key)).toEqual(["img2", "img1", "img3"]);
		await expect
			.element(screen.getByText("Image One moved to position 2 of 3."))
			.toBeInTheDocument();
	});

	it("uses a cropped copy without changing the gallery slot metadata or order", async () => {
		const onUpdate = vi.fn();
		const images = threeImages();
		images[1] = { ...images[1]!, alt: "Usage alt", caption: "Usage caption" };
		const screen = await renderPanel({
			attributes: { images, columns: 3, nodeKey: "10", selectedImageKey: "img2" },
			onUpdate,
		});

		await expect.element(screen.getByRole("button", { name: "Replace" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Edit asset" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Remove", exact: true })).toBeVisible();
		await screen.getByRole("button", { name: "Edit asset" }).click();
		await screen.getByRole("button", { name: "Use cropped gallery asset" }).click();

		await vi.waitFor(() => expect(onUpdate).toHaveBeenCalled());
		const patched = onUpdate.mock.calls.at(-1)?.[0].images as GalleryImage[];
		expect(patched.map((image) => image._key)).toEqual(["img1", "img2", "img3"]);
		expect(patched[1]).toEqual({
			...images[1],
			asset: { _type: "reference", _ref: "m2-cropped", url: "/media/m2-cropped.jpg" },
			width: 640,
			height: 480,
			focalX: 0.4,
			focalY: 0.6,
			blurhash: "cropped-hash",
			dominantColor: "#123456",
		});
	});

	it("refreshes every admin preview of a replaced gallery asset without another load request", async () => {
		const api = await import("../src/lib/api");
		const images = threeImages();
		images[1] = {
			...images[1]!,
			asset: {
				...images[1]!.asset,
				url: "/_emdash/api/media/file/m2.jpg",
			},
			alt: "Usage alt",
		};
		const screen = await renderPanel({
			attributes: { images, columns: 3, nodeKey: "10", selectedImageKey: "img2" },
		});
		expect(api.fetchMediaItem).not.toHaveBeenCalled();

		await screen.getByRole("button", { name: "Edit asset" }).click();
		await screen.getByRole("button", { name: "Refresh gallery asset" }).click();

		await vi.waitFor(() => {
			expect(
				screen.container.querySelectorAll(
					'img[src="/_emdash/api/media/file/m2.jpg?_emdash_media=sha256%3Areplaced-gallery"]',
				),
			).toHaveLength(2);
		});
		expect(api.fetchMediaItem).toHaveBeenCalledTimes(1);
	});

	it("does not open the add picker while an asset edit is loading", async () => {
		const api = await import("../src/lib/api");
		let resolveItem!: (item: Awaited<ReturnType<typeof api.fetchMediaItem>>) => void;
		vi.mocked(api.fetchMediaItem).mockImplementationOnce(
			() => new Promise((resolve) => (resolveItem = resolve)),
		);
		const screen = await renderPanel({
			attributes: {
				images: threeImages(),
				columns: 3,
				nodeKey: "10",
				selectedImageKey: "img2",
			},
		});

		await screen.getByRole("button", { name: "Edit asset" }).click();

		await expect.element(screen.getByRole("button", { name: "Add Images" })).toBeDisabled();
		resolveItem({
			id: "m2",
			filename: "m2.jpg",
			mimeType: "image/jpeg",
			url: "/media/m2.jpg",
			storageKey: "m2.jpg",
			size: 100,
			status: "ready",
			authorId: "editor-1",
			folderId: null,
			createdAt: "2026-01-01T00:00:00.000Z",
		});
	});
});
