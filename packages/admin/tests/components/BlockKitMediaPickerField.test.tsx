import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { BlockKitMediaPickerField } from "../../src/components/BlockKitMediaPickerField";
import { render } from "../utils/render";

// Stub MediaPickerModal as a test seam so tests can drive the picker selection
// flow (local pick, URL pick, close) without spinning up the real modal.
vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: ({
		open,
		onSelect,
		onOpenChange,
	}: {
		open: boolean;
		onSelect: (item: unknown) => void;
		onOpenChange: (open: boolean) => void;
	}) =>
		open ? (
			<div data-testid="media-picker-modal">
				<button
					type="button"
					onClick={() =>
						onSelect({
							id: "m1",
							filename: "photo one.png",
							mimeType: "image/png",
							url: "/media/photo one.png",
							storageKey: "uploads/photo one.png",
							provider: "local",
							size: 0,
							createdAt: "",
						})
					}
				>
					pick-local
				</button>
				<button
					type="button"
					onClick={() =>
						onSelect({
							id: "",
							filename: "ext.jpg",
							mimeType: "image/unknown",
							url: "https://cdn.example/ext.jpg",
							size: 0,
							createdAt: "",
						})
					}
				>
					pick-url
				</button>
				<button type="button" onClick={() => onOpenChange(false)}>
					close
				</button>
			</div>
		) : null,
}));

async function renderField(
	props: Partial<React.ComponentProps<typeof BlockKitMediaPickerField>> = {},
) {
	const onChange = props.onChange ?? vi.fn();
	const screen = await render(
		<BlockKitMediaPickerField
			actionId="hero"
			label="Hero"
			value=""
			onChange={onChange}
			{...props}
		/>,
	);
	return { screen, onChange };
}

async function waitForImg(): Promise<HTMLImageElement> {
	let el: HTMLImageElement | null = null;
	await vi.waitFor(
		() => {
			el = document.querySelector("img");
			expect(el).toBeTruthy();
		},
		{ timeout: 2000 },
	);
	return el!;
}

describe("BlockKitMediaPickerField", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("empty state", () => {
		it("renders the default placeholder when no value is set", async () => {
			const { screen } = await renderField();
			await expect.element(screen.getByText("Select media")).toBeInTheDocument();
		});

		it("renders the custom placeholder when provided", async () => {
			const { screen } = await renderField({ placeholder: "Pick a hero image" });
			await expect.element(screen.getByText("Pick a hero image")).toBeInTheDocument();
		});

		it("opens the picker when the empty-state button is clicked", async () => {
			const { screen } = await renderField({ placeholder: "Pick a hero image" });
			const trigger = screen.getByText("Pick a hero image");
			(trigger.element() as HTMLElement).closest("button")!.click();
			await expect.element(screen.getByTestId("media-picker-modal")).toBeInTheDocument();
		});
	});

	describe("selection", () => {
		it("rewrites and encodes a local-provider storage key for the media file route", async () => {
			const onChange = vi.fn();
			const { screen } = await renderField({ placeholder: "open", onChange });
			(screen.getByText("open").element() as HTMLElement).closest("button")!.click();
			await expect.element(screen.getByTestId("media-picker-modal")).toBeInTheDocument();
			(screen.getByText("pick-local").element() as HTMLElement).click();
			expect(onChange).toHaveBeenCalledWith(
				"hero",
				"/_emdash/api/media/file/uploads/photo%20one.png",
			);
		});

		it("uses the raw URL for items inserted via the URL tab (no provider, no storageKey)", async () => {
			const onChange = vi.fn();
			const { screen } = await renderField({ placeholder: "open", onChange });
			(screen.getByText("open").element() as HTMLElement).closest("button")!.click();
			await expect.element(screen.getByTestId("media-picker-modal")).toBeInTheDocument();
			(screen.getByText("pick-url").element() as HTMLElement).click();
			expect(onChange).toHaveBeenCalledWith("hero", "https://cdn.example/ext.jpg");
		});
	});

	describe("preview", () => {
		it("shows the selected filename with visible replace and remove actions", async () => {
			const { screen } = await renderField({
				value: "/_emdash/api/media/file/diagram%20final.png",
			});

			await expect.element(screen.getByText("diagram final.png")).toBeInTheDocument();
			await expect.element(screen.getByRole("button", { name: "Replace Hero" })).toBeVisible();
			await expect.element(screen.getByRole("button", { name: "Remove Hero" })).toBeVisible();
		});

		it("renders the image with no-referrer and lazy loading when value is a safe URL", async () => {
			await renderField({ value: "/_emdash/api/media/file/abc.png" });
			const img = await waitForImg();
			expect(img.getAttribute("src")).toBe("/_emdash/api/media/file/abc.png");
			expect(img.getAttribute("referrerpolicy")).toBe("no-referrer");
			expect(img.getAttribute("loading")).toBe("lazy");
		});

		it("renders the image for safe external URLs", async () => {
			await renderField({ value: "https://cdn.example/img.png" });
			const img = await waitForImg();
			expect(img.getAttribute("src")).toBe("https://cdn.example/img.png");
		});

		it("falls back to the placeholder for javascript: URLs", async () => {
			// Cast to any to bypass DOM-style typing on src; this string is what an
			// admin user could paste into a text_input-compatible value.
			const { screen } = await renderField({ value: "javascript:alert(1)" });
			await expect.element(screen.getByText("Select media")).toBeInTheDocument();
			expect(document.querySelector("img")).toBeNull();
		});

		it("falls back to the placeholder for protocol-relative URLs", async () => {
			const { screen } = await renderField({ value: "//evil.example/img.png" });
			await expect.element(screen.getByText("Select media")).toBeInTheDocument();
			expect(document.querySelector("img")).toBeNull();
		});

		it("falls back to the placeholder for data: URIs", async () => {
			const { screen } = await renderField({ value: "data:image/png;base64,iVBORw0KG" });
			await expect.element(screen.getByText("Select media")).toBeInTheDocument();
			expect(document.querySelector("img")).toBeNull();
		});
	});

	describe("broken image", () => {
		it("shows a broken-image placeholder when the img fails to load", async () => {
			const { screen } = await renderField({
				value: "/_emdash/api/media/file/missing.png",
			});

			// Image should render initially
			const img = await waitForImg();
			expect(img.getAttribute("src")).toBe("/_emdash/api/media/file/missing.png");

			// Simulate image load failure
			img.dispatchEvent(new Event("error"));

			// Broken-image placeholder should appear
			await expect.element(screen.getByText("Image not found")).toBeInTheDocument();
		});

		it("keeps Replace and Remove buttons accessible when the image is broken", async () => {
			const { screen } = await renderField({
				value: "/_emdash/api/media/file/missing.png",
			});

			const img = await waitForImg();
			img.dispatchEvent(new Event("error"));

			// Both action buttons must remain in the DOM and accessible
			await expect.element(screen.getByRole("button", { name: "Remove Hero" })).toBeVisible();
			await expect.element(screen.getByRole("button", { name: "Replace Hero" })).toBeVisible();
		});

		it("maintains a minimum height so the container does not collapse", async () => {
			const { screen } = await renderField({
				value: "/_emdash/api/media/file/missing.png",
			});

			const img = await waitForImg();
			img.dispatchEvent(new Event("error"));

			// The broken-image placeholder should be visible (its presence confirms
			// the container didn't collapse — a zero-height container can't show text)
			await expect.element(screen.getByText("Image not found")).toBeInTheDocument();

			// The remove button must remain accessible via label
			await expect.element(screen.getByRole("button", { name: "Remove Hero" })).toBeVisible();
		});
	});

	describe("remove", () => {
		it("clears the value when Remove is clicked", async () => {
			const onChange = vi.fn();
			const { screen } = await renderField({
				value: "/_emdash/api/media/file/abc.png",
				onChange,
			});
			const removeBtn = screen.getByRole("button", { name: "Remove Hero" });
			await expect.element(removeBtn).toBeInTheDocument();
			(removeBtn.element() as HTMLElement).click();
			expect(onChange).toHaveBeenCalledWith("hero", "");
		});
	});
});
