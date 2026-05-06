import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MediaPickerModal } from "../../src/components/MediaPickerModal";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const UPLOAD_BUTTON_REGEX = /Upload/;

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchMediaList: vi.fn().mockResolvedValue({
			items: [
				{
					id: "m1",
					filename: "photo.jpg",
					mimeType: "image/jpeg",
					url: "/media/photo.jpg",
					size: 1024,
					width: 800,
					height: 600,
					createdAt: "2024-01-01",
				},
				{
					id: "m2",
					filename: "landscape.png",
					mimeType: "image/png",
					url: "/media/landscape.png",
					size: 2048,
					width: 1200,
					height: 800,
					createdAt: "2024-01-02",
				},
			],
		}),
		fetchMediaProviders: vi.fn().mockResolvedValue([]),
		fetchProviderMedia: vi.fn().mockResolvedValue({ items: [] }),
		uploadMedia: vi.fn().mockResolvedValue({ id: "m3", filename: "new.jpg" }),
		uploadToProvider: vi.fn().mockResolvedValue({}),
		updateMedia: vi.fn().mockResolvedValue({}),
	};
});

function QueryWrapper({ children }: { children: React.ReactNode }) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return <QueryClientProvider client={qc}>{children}</QueryClientProvider>;
}

function renderModal(props: Partial<React.ComponentProps<typeof MediaPickerModal>> = {}) {
	const defaultProps: React.ComponentProps<typeof MediaPickerModal> = {
		open: true,
		onOpenChange: vi.fn(),
		onSelect: vi.fn(),
		...props,
	};
	return render(
		<QueryWrapper>
			<MediaPickerModal {...defaultProps} />
		</QueryWrapper>,
	);
}

describe("MediaPickerModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	describe("displaying items", () => {
		it("shows media items when open", async () => {
			const screen = await renderModal({ open: true });
			await expect.element(screen.getByRole("option", { name: "photo.jpg" })).toBeInTheDocument();
			await expect
				.element(screen.getByRole("option", { name: "landscape.png" }))
				.toBeInTheDocument();
		});

		it("shows the modal title", async () => {
			const screen = await renderModal({ title: "Pick an Image" });
			await expect.element(screen.getByText("Pick an Image")).toBeInTheDocument();
		});
	});

	describe("selection", () => {
		it("single click selects item (highlighted)", async () => {
			const screen = await renderModal();
			const option = screen.getByRole("option", { name: "photo.jpg" });
			await expect.element(option).toBeInTheDocument();

			// Direct DOM click to bypass inert overlay
			const btn = option.element().querySelector("button")!;
			btn.click();

			// Should show selected state via aria-selected
			await expect.element(option).toHaveAttribute("aria-selected", "true");
			// Footer should show selected filename in a <strong> tag
			await expect.element(screen.getByRole("strong")).toBeInTheDocument();
		});

		it("double click selects and calls onSelect", async () => {
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });

			const option = screen.getByRole("option", { name: "photo.jpg" });
			await expect.element(option).toBeInTheDocument();

			// Use direct DOM dblclick to bypass inert overlay
			const btn = option.element().querySelector("button")!;
			btn.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({ id: "m1", filename: "photo.jpg" }),
			);
		});

		it("Insert button disabled when nothing selected", async () => {
			await renderModal();
			// There are two Insert buttons — URL section and footer.
			// The footer Insert is the last one and should be disabled.
			await vi.waitFor(() => {
				const allInsertBtns = document.querySelectorAll("button");
				const insertBtns = [...allInsertBtns].filter((b) => b.textContent?.trim() === "Insert");
				// The footer Insert (last one) should be disabled
				const lastInsert = insertBtns.at(-1);
				expect(lastInsert?.disabled).toBe(true);
			});
		});

		it("Insert button enabled when item selected, calls onSelect", async () => {
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });

			// Select an item via direct DOM click
			const option = screen.getByRole("option", { name: "photo.jpg" });
			await expect.element(option).toBeInTheDocument();
			const itemBtn = option.element().querySelector("button")!;
			itemBtn.click();

			// Wait for selection to register
			await expect.element(option).toHaveAttribute("aria-selected", "true");

			// Click the footer Insert button (last Insert button)
			await vi.waitFor(() => {
				const allInsertBtns = document.querySelectorAll("button");
				const insertBtns = [...allInsertBtns].filter((b) => b.textContent?.trim() === "Insert");
				const lastInsert = insertBtns.at(-1)!;
				expect(lastInsert.disabled).toBe(false);
				lastInsert.click();
			});

			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({ id: "m1", filename: "photo.jpg" }),
			);
		});
	});

	describe("URL input", () => {
		it("invalid URL shows error", async () => {
			const screen = await renderModal();

			// The URL input has aria-label "Image URL"
			const urlInput = screen.getByLabelText("Image URL");
			await expect.element(urlInput).toBeInTheDocument();

			// Type an invalid URL — use direct DOM since we're inside a dialog
			const inputEl = urlInput.element() as HTMLInputElement;
			// Manually set value and trigger change
			const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!;
			nativeInputValueSetter.call(inputEl, "not-a-url");
			inputEl.dispatchEvent(new Event("input", { bubbles: true }));
			inputEl.dispatchEvent(new Event("change", { bubbles: true }));

			// Click the URL Insert button (first Insert button)
			await vi.waitFor(() => {
				const urlInsert = [...document.querySelectorAll("button")].find(
					(b) => b.textContent?.trim() === "Insert",
				)!;
				expect(urlInsert.disabled).toBe(false);
				urlInsert.click();
			});

			await expect.element(screen.getByText("Please enter a valid URL")).toBeInTheDocument();
		});

		it("URL input: typing a URL and submitting triggers probe", async () => {
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });

			const urlInput = screen.getByLabelText("Image URL");
			const inputEl = urlInput.element() as HTMLInputElement;
			const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!;
			nativeInputValueSetter.call(inputEl, "https://example.com/test.jpg");
			inputEl.dispatchEvent(new Event("input", { bubbles: true }));
			inputEl.dispatchEvent(new Event("change", { bubbles: true }));

			// Click URL Insert button
			await vi.waitFor(() => {
				const urlInsert = [...document.querySelectorAll("button")].find(
					(b) => b.textContent?.trim() === "Insert",
				)!;
				urlInsert.click();
			});

			// Image probe will fail in test env, so either onSelect called or error shown
			await vi.waitFor(
				() => {
					const called = onSelect.mock.calls.length > 0;
					const hasError =
						document.body.textContent?.includes("Could not load image from URL") ?? false;
					expect(called || hasError).toBe(true);
				},
				{ timeout: 3000 },
			);
		});

		it("hideUrlInput hides the URL input section (for non-image pickers)", async () => {
			const screen = await renderModal({ hideUrlInput: true });

			// "Insert from URL" label should not appear when hidden
			await expect.element(screen.getByText("Select Image")).toBeInTheDocument();
			expect(document.body.textContent).not.toContain("Insert from URL");
			expect(document.body.textContent).not.toContain("or choose from library");

			// The URL input itself should not be in the DOM
			const urlInput = document.querySelector('input[aria-label="Image URL"]');
			expect(urlInput).toBeNull();
		});
	});

	describe("mediaKind", () => {
		it("uses file-specific copy when mediaKind is 'file'", async () => {
			// Use an empty media list so the empty state copy renders.
			const api = await import("../../src/lib/api");
			(api.fetchMediaList as any).mockResolvedValueOnce({ items: [] });

			const screen = await renderModal({ mediaKind: "file", hideUrlInput: true });

			// Default title should be "Select File", not "Select Image"
			await expect.element(screen.getByText("Select File")).toBeInTheDocument();
			expect(document.body.textContent).not.toContain("Select Image");

			// Empty-state hint and CTA should reference files, not images
			await expect.element(screen.getByText("Upload a file to get started")).toBeInTheDocument();
			await expect.element(screen.getByText("Upload File")).toBeInTheDocument();
			expect(document.body.textContent).not.toContain("Upload an image to get started");
			expect(document.body.textContent).not.toContain("Upload Image");
		});

		it("defaults to image-specific copy when mediaKind is unset", async () => {
			const api = await import("../../src/lib/api");
			(api.fetchMediaList as any).mockResolvedValueOnce({ items: [] });

			const screen = await renderModal();

			await expect.element(screen.getByText("Select Image")).toBeInTheDocument();
			await expect.element(screen.getByText("Upload an image to get started")).toBeInTheDocument();
		});
	});

	describe("cancel and close", () => {
		it("Cancel closes modal", async () => {
			const onOpenChange = vi.fn();
			const screen = await renderModal({ onOpenChange });

			await expect.element(screen.getByText("Select Image")).toBeInTheDocument();
			// Direct DOM click to bypass inert overlay
			const cancelEl = screen.getByText("Cancel").element();
			const cancelBtn = cancelEl.closest("button")!;
			cancelBtn.click();

			expect(onOpenChange).toHaveBeenCalledWith(false);
		});
	});

	describe("state reset", () => {
		it("state resets when modal reopens", async () => {
			const onSelect = vi.fn();
			const onOpenChange = vi.fn();
			const screen = await renderModal({ open: true, onSelect, onOpenChange });

			// Select an item
			const option = screen.getByRole("option", { name: "photo.jpg" });
			await expect.element(option).toBeInTheDocument();
			const btn = option.element().querySelector("button")!;
			btn.click();

			// Verify selection
			await expect.element(option).toHaveAttribute("aria-selected", "true");

			// Close modal
			await screen.rerender(
				<QueryWrapper>
					<MediaPickerModal open={false} onOpenChange={onOpenChange} onSelect={onSelect} />
				</QueryWrapper>,
			);

			// Reopen modal
			await screen.rerender(
				<QueryWrapper>
					<MediaPickerModal open={true} onOpenChange={onOpenChange} onSelect={onSelect} />
				</QueryWrapper>,
			);

			// Footer Insert should be disabled (no selection after reset)
			await vi.waitFor(() => {
				const allInsertBtns = document.querySelectorAll("button");
				const insertBtns = [...allInsertBtns].filter((b) => b.textContent?.trim() === "Insert");
				const lastInsert = insertBtns.at(-1);
				expect(lastInsert?.disabled).toBe(true);
			});
		});
	});

	describe("upload", () => {
		it("upload button and file input are present", async () => {
			const screen = await renderModal();
			await expect
				.element(screen.getByRole("button", { name: UPLOAD_BUTTON_REGEX }))
				.toBeInTheDocument();
			await expect.element(screen.getByLabelText("Upload file")).toBeInTheDocument();
		});
	});
});
