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

		await expect.element(screen.getByText("notes-on-simplicity.jpg")).toBeVisible();
		const metadata = screen.getByText("1200 × 800 · image/jpeg");
		await expect.element(metadata).toBeVisible();
		expect(metadata.element()).toHaveAttribute("dir", "ltr");
		await expect.element(screen.getByRole("button", { name: "Change" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Remove image" })).toBeVisible();

		const image = screen.container.querySelector("img");
		expect(image).not.toBeNull();
		expect(image).toHaveClass("h-full", "w-full", "object-cover");
		expect(image?.parentElement).toHaveClass("aspect-[3/2]");

		const card = screen.getByText("notes-on-simplicity.jpg").element().closest(".ring-kumo-line");
		expect(card).toHaveClass("w-full");
		expect(card?.querySelector(".opacity-0")).toBeNull();
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

	it("keeps the featured empty state full width and reports required validation", async () => {
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
		expect(selectButton.element()).toHaveClass("w-full", "ring-kumo-line");
		await expect.element(screen.getByText("This field is required")).toBeVisible();
	});

	it("leaves the default selected-image presentation unchanged", async () => {
		const screen = await render(
			<ImageFieldRenderer label="Image" value={selectedImage} onChange={vi.fn()} />,
		);

		expect(screen.getByText("notes-on-simplicity.jpg").query()).toBeNull();
		expect(screen.container.querySelector(".opacity-0")).not.toBeNull();
	});
});
