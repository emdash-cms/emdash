import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ImageFieldRenderer, type ImageFieldValue } from "../../src/components/ImageFieldRenderer";
import { fetchMediaItem, type LocalMediaItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return { ...actual, fetchMediaItem: vi.fn() };
});

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: ({ open, onSelect }: { open: boolean; onSelect: (item: unknown) => void }) =>
		open ? (
			<>
				<button
					type="button"
					onClick={() =>
						onSelect({
							id: "replacement-image",
							filename: "replacement.webp",
							mimeType: "image/webp",
							url: "/media/replacement.webp",
							storageKey: "replacement.webp",
							provider: "local",
							size: 31_744,
							width: 1600,
							height: 800,
							focalX: 0.2,
							focalY: 0.8,
							alt: "Replacement image",
							createdAt: "2026-07-23T12:00:00.000Z",
						})
					}
				>
					Choose replacement
				</button>
				<button
					type="button"
					onClick={() =>
						onSelect({
							id: "",
							filename: "external.jpg",
							mimeType: "image/jpeg",
							url: "https://media.example/external.jpg",
							provider: "external-url",
							size: 0,
							width: 1200,
							height: 800,
							createdAt: "2026-07-23T12:00:00.000Z",
						})
					}
				>
					Choose external URL
				</button>
			</>
		) : null,
}));

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "editor-1", role: 40 } }),
}));

vi.mock("../../src/components/MediaDetailPanel.js", () => ({
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
		onItemRefreshed?: (item: LocalMediaItem) => void;
		onCroppedCopyCreated?: (item: LocalMediaItem) => void;
	}) =>
		open ? (
			<>
				<button
					type="button"
					onClick={() =>
						onItemRefreshed?.({
							id: "featured-image",
							filename: "notes-on-simplicity.jpg",
							mimeType: "image/jpeg",
							url: "/_emdash/api/media/file/featured-image.jpg",
							storageKey: "featured-image.jpg",
							size: 30_000,
							width: 1200,
							height: 800,
							contentHash: "sha256:replaced-original",
							status: "ready",
							authorId: "editor-1",
							folderId: null,
							createdAt: "2026-01-01T00:00:00.000Z",
						})
					}
				>
					Refresh original asset
				</button>
				<button
					type="button"
					onClick={() => {
						onCroppedCopyCreated?.({
							id: "cropped-image",
							filename: "cropped.webp",
							mimeType: "image/webp",
							url: "/_emdash/api/media/file/cropped.webp",
							storageKey: "cropped.webp",
							size: 24_000,
							width: 900,
							height: 600,
							contentHash: "sha256:cropped-copy",
							alt: "Cropped asset alt",
							focalX: 0.4,
							focalY: 0.6,
							blurhash: "cropped-hash",
							dominantColor: "#aabbcc",
							status: "ready",
							authorId: "editor-1",
							folderId: null,
							createdAt: "2026-01-02T00:00:00.000Z",
						});
						onClose();
						onClosed?.();
					}}
				>
					Use cropped asset
				</button>
			</>
		) : null,
}));

const selectedImage: ImageFieldValue = {
	id: "featured-image",
	provider: "local",
	filename: "notes-on-simplicity.jpg",
	mimeType: "image/jpeg",
	alt: "Geometric pattern carved into white paper",
	width: 1200,
	height: 800,
	focalX: 0.25,
	focalY: 0.75,
	meta: { storageKey: "featured-image.jpg" },
};

beforeEach(() => {
	vi.mocked(fetchMediaItem).mockResolvedValue({
		id: selectedImage.id,
		filename: selectedImage.filename!,
		mimeType: selectedImage.mimeType!,
		url: "/_emdash/api/media/file/featured-image.jpg",
		storageKey: "featured-image.jpg",
		size: 1,
		width: selectedImage.width,
		height: selectedImage.height,
		contentHash: null,
		createdAt: "2026-01-01T00:00:00.000Z",
		authorId: "author-1",
		folderId: null,
	} as LocalMediaItem);
});

describe("ImageFieldRenderer", () => {
	it("renders the featured variant as a full-width media card with metadata", async () => {
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={selectedImage}
				onChange={vi.fn()}
				variant="featured"
			/>,
		);

		const filename = screen.getByText("notes-on-simplicity.jpg");
		await expect.element(filename).toBeVisible();
		const metadata = screen.getByText("1200 × 800 · image/jpeg");
		await expect.element(metadata).toBeVisible();
		expect(metadata.element()).toHaveAttribute("dir", "ltr");
		const chooseAnotherButton = screen.getByRole("button", { name: "Replace" });
		await expect.element(chooseAnotherButton).toBeVisible();
		expect(chooseAnotherButton.element().querySelector("svg")).not.toBeNull();
		await expect.element(screen.getByRole("button", { name: "Edit asset" })).toBeVisible();
		const removeButton = screen.getByRole("button", { name: "Remove image" });
		await expect.element(removeButton).toBeVisible();
		expect(removeButton.element()).toHaveTextContent("Remove");

		const image = screen.container.querySelector("img");
		expect(image).toHaveAttribute("src", "/_emdash/api/media/file/featured-image.jpg");
		expect(image?.style.objectPosition).toBe("25% 75%");
		expect(getComputedStyle(image!.parentElement!).aspectRatio).toBe("16 / 9");
	});

	it("refreshes a featured local preview from the current media item", async () => {
		vi.mocked(fetchMediaItem).mockResolvedValueOnce({
			id: selectedImage.id,
			filename: selectedImage.filename!,
			mimeType: selectedImage.mimeType!,
			url: "/_emdash/api/media/file/featured-image.jpg",
			storageKey: "featured-image.jpg",
			size: 42_500,
			width: 449,
			height: 299,
			contentHash: "sha256:cropped",
			createdAt: "2026-01-01T00:00:00.000Z",
			authorId: "author-1",
			folderId: null,
		} as LocalMediaItem);

		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={selectedImage}
				onChange={vi.fn()}
				variant="featured"
			/>,
		);

		await vi.waitFor(() =>
			expect(fetchMediaItem).toHaveBeenCalledWith(
				"featured-image",
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			),
		);
		await expect
			.element(screen.container.querySelector("img")!)
			.toHaveAttribute(
				"src",
				"/_emdash/api/media/file/featured-image.jpg?_emdash_media=sha256%3Acropped",
			);
		await expect.element(screen.getByText("449 × 299 · image/jpeg")).toBeVisible();
	});

	it("refreshes a featured dark mode preview from the current media item", async () => {
		vi.mocked(fetchMediaItem).mockImplementation(async (id) => {
			const dark = id === "dark-image";
			return {
				id,
				filename: dark ? "featured-dark.jpg" : selectedImage.filename!,
				mimeType: "image/jpeg",
				url: `/_emdash/api/media/file/${dark ? "featured-dark.jpg" : "featured-image.jpg"}`,
				storageKey: dark ? "featured-dark.jpg" : "featured-image.jpg",
				size: 42_500,
				width: dark ? 320 : 449,
				height: dark ? 200 : 299,
				contentHash: dark ? "sha256:dark-cropped" : "sha256:cropped",
				createdAt: "2026-01-01T00:00:00.000Z",
				authorId: "author-1",
				folderId: null,
			};
		});
		const value: ImageFieldValue = {
			...selectedImage,
			darkVariant: {
				id: "dark-image",
				provider: "local",
				filename: "featured-dark.jpg",
				meta: { storageKey: "featured-dark.jpg" },
			},
		};

		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={value}
				onChange={vi.fn()}
				variant="featured"
				darkVariant
			/>,
		);

		await vi.waitFor(() =>
			expect(fetchMediaItem).toHaveBeenCalledWith(
				"dark-image",
				expect.objectContaining({ signal: expect.any(AbortSignal) }),
			),
		);
		await expect
			.element(screen.container.querySelectorAll("img")[1]!)
			.toHaveAttribute(
				"src",
				"/_emdash/api/media/file/featured-dark.jpg?_emdash_media=sha256%3Adark-cropped",
			);
	});

	it("falls back cleanly when optional featured-image metadata is missing", async () => {
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={{ id: "legacy", src: "https://example.com/legacy.jpg" }}
				onChange={vi.fn()}
				variant="featured"
			/>,
		);

		await expect.element(screen.getByText("Selected image")).toBeVisible();
		expect(screen.container.textContent).not.toContain("×");
		expect(screen.container.textContent).not.toContain("·");
	});

	it("encodes path-unsafe characters in local storage keys", async () => {
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={{
					...selectedImage,
					meta: { storageKey: "featured?draft#1.jpg" },
				}}
				onChange={vi.fn()}
				variant="featured"
			/>,
		);

		const image = screen.container.querySelector("img");
		expect(image).toHaveAttribute("src", "/_emdash/api/media/file/featured%3Fdraft%231.jpg");
	});

	it("preserves filename and MIME type when a replacement is selected", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={selectedImage}
				onChange={onChange}
				variant="featured"
			/>,
		);

		await screen.getByRole("button", { name: "Replace" }).click();
		await screen.getByRole("button", { name: "Choose replacement" }).click();

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "replacement-image",
				filename: "replacement.webp",
				mimeType: "image/webp",
				width: 1600,
				height: 800,
				focalX: 0.2,
				focalY: 0.8,
			}),
		);
	});

	it("stores an external URL as a renderable direct media value", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={selectedImage}
				onChange={onChange}
				variant="featured"
			/>,
		);

		await screen.getByRole("button", { name: "Replace" }).click();
		await screen.getByRole("button", { name: "Choose external URL" }).click();

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "",
				provider: "external",
				src: "https://media.example/external.jpg",
			}),
		);
		expect(onChange.mock.calls[0]?.[0].previewUrl).toBeUndefined();
	});

	it("does not offer asset editing in mobile actions for an external featured image", async () => {
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={{
					id: "",
					provider: "external",
					src: "https://media.example/external.jpg",
					filename: "external.jpg",
					mimeType: "image/jpeg",
				}}
				onChange={vi.fn()}
				variant="featured"
			/>,
		);

		await screen.getByRole("button", { name: "Image actions" }).click();

		await expect.element(screen.getByRole("menuitem", { name: "Replace" })).toBeVisible();
		expect(screen.getByRole("menuitem", { name: "Edit asset" }).query()).toBeNull();
		await expect.element(screen.getByRole("menuitem", { name: "Remove" })).toBeVisible();
	});

	it("removes the featured image immediately", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={selectedImage}
				onChange={onChange}
				variant="featured"
			/>,
		);

		await screen.getByRole("button", { name: "Remove image" }).click();
		expect(onChange).toHaveBeenCalledWith(null);
	});

	it("keeps the featured card and actions available when the image is broken", async () => {
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={selectedImage}
				onChange={vi.fn()}
				variant="featured"
			/>,
		);
		const image = screen.container.querySelector("img");
		expect(image).not.toBeNull();

		image!.dispatchEvent(new Event("error"));

		await expect.element(screen.getByText("Image not found")).toBeVisible();
		await expect.element(screen.getByText("notes-on-simplicity.jpg")).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Replace" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Edit asset" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Remove image" })).toBeVisible();
	});

	it("opens the picker from the featured empty state and reports required validation", async () => {
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={undefined}
				onChange={vi.fn()}
				required
				variant="featured"
			/>,
		);

		const selectButton = screen.getByRole("button", { name: "Select image" });
		await expect.element(selectButton).toBeVisible();
		await expect.element(screen.getByText("This field is required")).toBeVisible();

		await selectButton.click();
		await expect.element(screen.getByRole("button", { name: "Choose replacement" })).toBeVisible();
	});

	it("offers no dark mode slot unless the field enables it", async () => {
		const screen = await render(
			<ImageFieldRenderer label="Image" value={selectedImage} onChange={vi.fn()} />,
		);

		expect(screen.getByRole("button", { name: "Add dark mode variant" }).query()).toBeNull();
	});

	it("offers the dark mode slot only once a primary image is selected", async () => {
		const screen = await render(
			<ImageFieldRenderer label="Image" value={undefined} onChange={vi.fn()} darkVariant />,
		);

		expect(screen.getByRole("button", { name: "Add dark mode variant" }).query()).toBeNull();
	});

	it("upgrades a legacy string value instead of discarding it", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<ImageFieldRenderer
				label="Image"
				value="https://example.com/legacy.jpg"
				onChange={onChange}
				darkVariant
			/>,
		);

		await screen.getByRole("button", { name: "Add dark mode variant" }).click();
		await screen.getByRole("button", { name: "Choose replacement" }).click();

		expect(onChange).toHaveBeenCalledWith({
			id: "",
			src: "https://example.com/legacy.jpg",
			darkVariant: expect.objectContaining({ id: "replacement-image" }),
		});
	});

	it("keeps the upgraded url when the dark mode variant is removed again", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<ImageFieldRenderer
				label="Image"
				value={{ id: "", src: "https://example.com/legacy.jpg", darkVariant: selectedImage }}
				onChange={onChange}
				darkVariant
			/>,
		);

		await screen.getByRole("button", { name: "Remove dark mode variant" }).click();

		expect(onChange).toHaveBeenCalledWith({ id: "", src: "https://example.com/legacy.jpg" });
	});

	it("stores a picked dark mode variant next to the primary image", async () => {
		const onChange = vi.fn();
		const screen = await render(
			<ImageFieldRenderer label="Image" value={selectedImage} onChange={onChange} darkVariant />,
		);

		await screen.getByRole("button", { name: "Add dark mode variant" }).click();
		await screen.getByRole("button", { name: "Choose replacement" }).click();

		expect(onChange).toHaveBeenCalledWith({
			...selectedImage,
			darkVariant: expect.objectContaining({
				id: "replacement-image",
				filename: "replacement.webp",
				meta: { storageKey: "replacement.webp" },
			}),
		});
	});

	it("shows the stored dark mode variant and removes only that variant", async () => {
		const onChange = vi.fn();
		const withDark: ImageFieldValue = {
			...selectedImage,
			darkVariant: {
				id: "dark-image",
				provider: "local",
				filename: "notes-on-simplicity-dark.jpg",
				meta: { storageKey: "dark-image.jpg" },
			},
		};
		const screen = await render(
			<ImageFieldRenderer label="Image" value={withDark} onChange={onChange} darkVariant />,
		);

		await expect.element(screen.getByText("notes-on-simplicity-dark.jpg")).toBeVisible();
		const images = screen.container.querySelectorAll("img");
		expect(images[1]).toHaveAttribute("src", "/_emdash/api/media/file/dark-image.jpg");

		await screen.getByRole("button", { name: "Remove dark mode variant" }).click();
		expect(onChange).toHaveBeenCalledWith(selectedImage);
	});

	it("gives the dark mode variant its own focal point", async () => {
		const withDark: ImageFieldValue = {
			...selectedImage,
			darkVariant: {
				id: "dark-image",
				provider: "local",
				focalX: 0.1,
				focalY: 0.2,
				meta: { storageKey: "dark-image.jpg" },
			},
		};
		const screen = await render(
			<ImageFieldRenderer label="Image" value={withDark} onChange={vi.fn()} darkVariant />,
		);

		const images = screen.container.querySelectorAll("img");
		expect(images[0]?.style.objectPosition).toBe("25% 75%");
		expect(images[1]?.style.objectPosition).toBe("10% 20%");
	});

	it("keeps the dark mode variant when the primary image is replaced", async () => {
		const onChange = vi.fn();
		const darkVariant: ImageFieldValue = { id: "dark-image", provider: "local" };
		const screen = await render(
			<ImageFieldRenderer
				label="Image"
				value={{ ...selectedImage, darkVariant }}
				onChange={onChange}
				darkVariant
			/>,
		);

		await screen.getByRole("button", { name: "Replace", exact: true }).click();
		await screen.getByRole("button", { name: "Choose replacement" }).click();

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({ id: "replacement-image", darkVariant }),
		);
	});

	it("does not show featured metadata in the default variant", async () => {
		const screen = await render(
			<ImageFieldRenderer label="Image" value={selectedImage} onChange={vi.fn()} />,
		);

		expect(screen.getByText("notes-on-simplicity.jpg").query()).toBeNull();
		expect(screen.getByText("1200 × 800 · image/jpeg").query()).toBeNull();
	});

	it("uses a cropped copy for the field without dropping its dark mode variant", async () => {
		const darkVariant: ImageFieldValue = { id: "dark-image", provider: "local" };
		const onChange = vi.fn();
		const screen = await render(
			<ImageFieldRenderer
				label="Featured image"
				value={{ ...selectedImage, darkVariant }}
				onChange={onChange}
				variant="featured"
			/>,
		);

		await screen.getByRole("button", { name: "Edit asset" }).click();
		await screen.getByRole("button", { name: "Use cropped asset" }).click();

		expect(onChange).toHaveBeenCalledWith({
			id: "cropped-image",
			provider: "local",
			src: undefined,
			previewUrl: undefined,
			alt: "Cropped asset alt",
			width: 900,
			height: 600,
			focalX: 0.4,
			focalY: 0.6,
			filename: "cropped.webp",
			mimeType: "image/webp",
			blurhash: "cropped-hash",
			dominantColor: "#aabbcc",
			meta: { storageKey: "cropped.webp" },
			darkVariant,
		});
	});

	it("refreshes a custom field preview from the edited item without persisting its content hash", async () => {
		let persistedValue: ImageFieldValue | null | undefined;
		function Harness() {
			const [value, setValue] = React.useState<ImageFieldValue | null>(selectedImage);
			return (
				<ImageFieldRenderer
					label="Image"
					value={value ?? undefined}
					onChange={(next) => {
						persistedValue = next;
						setValue(next);
					}}
				/>
			);
		}
		const screen = await render(<Harness />);
		const sources: string[] = [];
		const observer = new MutationObserver(() => {
			for (const image of screen.container.querySelectorAll("img")) sources.push(image.src);
		});
		observer.observe(screen.container, {
			attributes: true,
			attributeFilter: ["src"],
			childList: true,
			subtree: true,
		});

		await screen.getByRole("button", { name: "Edit asset" }).click();
		await screen.getByRole("button", { name: "Use cropped asset" }).click();

		await vi.waitFor(() => {
			expect(
				sources.some((source) =>
					source.endsWith(
						"/_emdash/api/media/file/cropped.webp?_emdash_media=sha256%3Acropped-copy",
					),
				),
			).toBe(true);
		});
		observer.disconnect();
		expect(persistedValue).not.toHaveProperty("contentHash");
	});

	it("refreshes both previews when light and dark variants share one replaced asset", async () => {
		function Harness() {
			const [value, setValue] = React.useState<ImageFieldValue>({
				...selectedImage,
				darkVariant: { ...selectedImage },
			});
			return (
				<ImageFieldRenderer
					label="Image"
					value={value}
					onChange={(next) => next && setValue(next)}
					darkVariant
				/>
			);
		}
		const screen = await render(<Harness />);
		const refreshedSource =
			"/_emdash/api/media/file/featured-image.jpg?_emdash_media=sha256%3Areplaced-original";
		const sources: string[] = [];
		const observer = new MutationObserver(() => {
			for (const image of screen.container.querySelectorAll("img")) sources.push(image.src);
		});
		observer.observe(screen.container, {
			attributes: true,
			attributeFilter: ["src"],
			childList: true,
			subtree: true,
		});

		await screen.getByRole("button", { name: "Edit asset" }).click();
		await screen.getByRole("button", { name: "Refresh original asset" }).click();

		await vi.waitFor(() => {
			expect(sources.filter((source) => source.endsWith(refreshedSource))).toHaveLength(2);
		});
		observer.disconnect();
	});
});
