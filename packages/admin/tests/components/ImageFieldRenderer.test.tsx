import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { ImageFieldRenderer, type ImageFieldValue } from "../../src/components/ImageFieldRenderer";
import { render } from "../utils/render.tsx";

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
		const replaceButton = screen.getByRole("button", { name: "Replace" });
		await expect.element(replaceButton).toBeVisible();
		expect(replaceButton.element().querySelector("svg")).not.toBeNull();
		const removeButton = screen.getByRole("button", { name: "Remove image" });
		await expect.element(removeButton).toBeVisible();
		expect(removeButton.element()).toHaveTextContent("Remove");

		const image = screen.container.querySelector("img");
		expect(image).toHaveAttribute("src", "/_emdash/api/media/file/featured-image.jpg");
		expect(image?.style.objectPosition).toBe("25% 75%");
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

		await screen.getByRole("button", { name: "Change", exact: true }).click();
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
});
