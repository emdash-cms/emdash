import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { ImageFieldRenderer, type ImageFieldValue } from "../../src/components/ImageFieldRenderer";
import { render } from "../utils/render.tsx";

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: ({ open, onSelect }: { open: boolean; onSelect: (item: unknown) => void }) =>
		open ? (
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
						alt: "Replacement image",
						createdAt: "2026-07-23T12:00:00.000Z",
					})
				}
			>
				Choose replacement
			</button>
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
	meta: { storageKey: "featured-image.jpg" },
};

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
		const changeButton = screen.getByRole("button", { name: "Change" });
		await expect.element(changeButton).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Remove image" })).toBeVisible();

		const image = screen.container.querySelector("img");
		expect(image).toHaveAttribute("src", "/_emdash/api/media/file/featured-image.jpg");
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

		await screen.getByRole("button", { name: "Change" }).click();
		await screen.getByRole("button", { name: "Choose replacement" }).click();

		expect(onChange).toHaveBeenCalledWith(
			expect.objectContaining({
				id: "replacement-image",
				filename: "replacement.webp",
				mimeType: "image/webp",
				width: 1600,
				height: 800,
			}),
		);
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
		await expect.element(screen.getByRole("button", { name: "Change" })).toBeVisible();
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

	it("does not show featured metadata in the default variant", async () => {
		const screen = await render(
			<ImageFieldRenderer label="Image" value={selectedImage} onChange={vi.fn()} />,
		);

		expect(screen.getByText("notes-on-simplicity.jpg").query()).toBeNull();
		expect(screen.getByText("1200 × 800 · image/jpeg").query()).toBeNull();
	});
});
