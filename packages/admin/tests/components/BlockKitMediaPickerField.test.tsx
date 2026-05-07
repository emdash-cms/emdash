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
							filename: "photo.png",
							mimeType: "image/png",
							url: "/media/photo.png",
							storageKey: "photo.png",
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
		it("rewrites a local-provider item to the /_emdash/api/media/file/ URL", async () => {
			const onChange = vi.fn();
			const { screen } = await renderField({ placeholder: "open", onChange });
			(screen.getByText("open").element() as HTMLElement).closest("button")!.click();
			await expect.element(screen.getByTestId("media-picker-modal")).toBeInTheDocument();
			(screen.getByText("pick-local").element() as HTMLElement).click();
			expect(onChange).toHaveBeenCalledWith("hero", "/_emdash/api/media/file/photo.png");
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

	describe("remove", () => {
		it("clears the value when Remove is clicked", async () => {
			const onChange = vi.fn();
			const { screen } = await renderField({
				value: "/_emdash/api/media/file/abc.png",
				onChange,
			});
			const removeBtn = screen.getByLabelText("Remove");
			await expect.element(removeBtn).toBeInTheDocument();
			(removeBtn.element() as HTMLElement).click();
			expect(onChange).toHaveBeenCalledWith("hero", "");
		});
	});
});
