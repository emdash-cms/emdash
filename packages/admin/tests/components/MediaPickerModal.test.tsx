import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { describe, it, expect, vi, beforeEach } from "vitest";

import { MediaPickerModal } from "../../src/components/MediaPickerModal";
import type { MediaItem } from "../../src/lib/api";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Anchored to the button's exact accessible name. Without anchors this also
// matches the hidden file `<input aria-label="Upload file">` and trips
// playwright's strict-mode "resolved to N elements" guard.
const UPLOAD_BUTTON_REGEX = /^Upload$/;

function makeMediaItem(overrides: Record<string, unknown> = {}) {
	return {
		id: "m1",
		filename: "photo.jpg",
		mimeType: "image/jpeg",
		url: "/media/photo.jpg",
		size: 1024,
		width: 800,
		height: 600,
		createdAt: "2024-01-01",
		...overrides,
	};
}

function dispatchFileDrop(target: Element, files: File[]) {
	const dataTransfer = new DataTransfer();
	for (const file of files) {
		dataTransfer.items.add(file);
	}

	target.dispatchEvent(
		new DragEvent("drop", {
			bubbles: true,
			cancelable: true,
			dataTransfer,
		}),
	);
}

function dispatchFileDrag(target: Element, type: "dragenter" | "dragover" | "dragleave") {
	const dataTransfer = new DataTransfer();
	dataTransfer.items.add(new File(["x"], "dragged.jpg", { type: "image/jpeg" }));

	target.dispatchEvent(
		new DragEvent(type, {
			bubbles: true,
			cancelable: true,
			dataTransfer,
		}),
	);
}

function changeFileInput(input: Element, files: File[]) {
	const dataTransfer = new DataTransfer();
	for (const file of files) {
		dataTransfer.items.add(file);
	}

	Object.defineProperty(input, "files", {
		configurable: true,
		value: dataTransfer.files,
	});
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

function getLastButtonByText(text: string) {
	const buttons = document.querySelectorAll("button");
	for (let index = buttons.length - 1; index >= 0; index -= 1) {
		const button = buttons.item(index);
		if (button.textContent?.trim() === text) {
			return button;
		}
	}
	throw new Error(`Button not found: ${text}`);
}

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchMediaList: vi.fn().mockResolvedValue({
			items: [
				makeMediaItem(),
				makeMediaItem({
					id: "m2",
					filename: "landscape.png",
					mimeType: "image/png",
					url: "/media/landscape.png",
					size: 2048,
					width: 1200,
					height: 800,
					createdAt: "2024-01-02",
				}),
			],
		}),
		fetchMediaProviders: vi.fn().mockResolvedValue([]),
		fetchProviderMedia: vi.fn().mockResolvedValue({ items: [] }),
		uploadMedia: vi.fn().mockResolvedValue(
			makeMediaItem({
				id: "m3",
				filename: "new.jpg",
				url: "/media/new.jpg",
			}),
		),
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

function ControlledModalForTest({ onSelect }: { onSelect: (item: MediaItem) => void }) {
	const [open, setOpen] = React.useState(true);
	return (
		<>
			<button type="button" onClick={() => setOpen(true)}>
				Reopen picker
			</button>
			<MediaPickerModal open={open} onOpenChange={setOpen} onSelect={onSelect} />
		</>
	);
}

describe("MediaPickerModal", () => {
	beforeEach(async () => {
		vi.clearAllMocks();
		const api = await import("../../src/lib/api");
		(api.fetchMediaList as any).mockReset().mockResolvedValue({
			items: [
				makeMediaItem(),
				makeMediaItem({
					id: "m2",
					filename: "landscape.png",
					mimeType: "image/png",
					url: "/media/landscape.png",
					size: 2048,
					width: 1200,
					height: 800,
					createdAt: "2024-01-02",
					alt: "Mountain landscape",
				}),
			],
		});
		(api.fetchMediaProviders as any).mockReset().mockResolvedValue([]);
		(api.fetchProviderMedia as any).mockReset().mockResolvedValue({ items: [] });
		(api.uploadMedia as any).mockReset().mockResolvedValue(
			makeMediaItem({
				id: "m3",
				filename: "new.jpg",
				url: "/media/new.jpg",
			}),
		);
		(api.uploadToProvider as any).mockReset().mockResolvedValue({});
		(api.updateMedia as any).mockReset().mockResolvedValue({});
	});

	describe("displaying items", () => {
		it("shows media items when open", async () => {
			const screen = await renderModal({ open: true });
			await expect.element(screen.getByRole("option", { name: /photo\.jpg/ })).toBeInTheDocument();
			await expect
				.element(screen.getByRole("option", { name: /landscape\.png/ }))
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
			const option = screen.getByRole("option", { name: /photo\.jpg/ });
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

			const option = screen.getByRole("option", { name: /photo\.jpg/ });
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
			const option = screen.getByRole("option", { name: /photo\.jpg/ });
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

		it("localOnly hides the URL input section", async () => {
			// `localOnly` is for fields whose storage model only persists a local
			// mediaId (e.g. site `logo`, `favicon`, `seo.defaultOgImage`). Selecting
			// an external URL would return an item the server cannot resolve later.
			const screen = await renderModal({ localOnly: true });

			await expect.element(screen.getByText("Select Image")).toBeInTheDocument();
			expect(document.body.textContent).not.toContain("Insert from URL");

			const urlInput = document.querySelector('input[aria-label="Image URL"]');
			expect(urlInput).toBeNull();
		});

		it("renders external provider tabs by default (control for localOnly)", async () => {
			// Establishes that providers DO appear without `localOnly`. Without
			// this control assertion, the suppression test below could pass
			// purely because the providers query hadn't resolved yet.
			const api = await import("../../src/lib/api");
			(api.fetchMediaProviders as any).mockResolvedValueOnce([
				{
					id: "cloudflare-images",
					name: "Cloudflare Images",
					capabilities: { upload: true, search: false },
				},
			]);

			const screen = await renderModal();
			await expect.element(screen.getByText("Cloudflare Images")).toBeInTheDocument();
		});

		it("localOnly suppresses external provider tabs and skips the providers fetch", async () => {
			const api = await import("../../src/lib/api");
			const screen = await renderModal({ localOnly: true });

			await expect.element(screen.getByText("Select Image")).toBeInTheDocument();
			// External providers must not be reachable through any tab when
			// localOnly is set, even if the API would report them.
			expect(document.body.textContent).not.toContain("Cloudflare Images");
			expect(document.body.textContent).not.toContain("Unsplash");
			// `enabled: open && !localOnly` short-circuits the query, so the
			// fetch should never have been issued. This proves the assertion
			// above isn't just racing the resolve.
			expect(api.fetchMediaProviders).not.toHaveBeenCalled();
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
			const option = screen.getByRole("option", { name: /photo\.jpg/ });
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
			await expect.element(screen.getByLabelText("Upload files")).toBeInTheDocument();
		});

		it("uploads every file selected through the picker input", async () => {
			const api = await import("../../src/lib/api");
			const screen = await renderModal();
			const input = screen.getByLabelText("Upload files").element();
			const files = [
				new File(["one"], "one.jpg", { type: "image/jpeg" }),
				new File(["two"], "two.jpg", { type: "image/jpeg" }),
			];

			changeFileInput(input, files);

			await vi.waitFor(() => {
				expect(api.uploadMedia).toHaveBeenCalledTimes(2);
			});
			expect(api.uploadMedia).toHaveBeenNthCalledWith(1, files[0], { fieldId: undefined });
			expect(api.uploadMedia).toHaveBeenNthCalledWith(2, files[1], { fieldId: undefined });
			await expect.element(screen.getByText("2 files uploaded")).toBeInTheDocument();
		});

		it("uploads every dropped file through the local picker upload path", async () => {
			const api = await import("../../src/lib/api");
			const screen = await renderModal();
			const dropZone = screen.getByText("Drag files here to upload").element();
			const files = [
				new File(["one"], "one.jpg", { type: "image/jpeg" }),
				new File(["two"], "two.jpg", { type: "image/jpeg" }),
			];

			dispatchFileDrop(dropZone, files);

			await vi.waitFor(() => {
				expect(api.uploadMedia).toHaveBeenCalledTimes(2);
			});
		});

		it("rejects dropped files that do not match the picker MIME filters", async () => {
			const api = await import("../../src/lib/api");
			const screen = await renderModal();
			const dropTarget = screen.getByText("Cancel").element();

			dispatchFileDrop(dropTarget, [new File(["pdf"], "notes.pdf", { type: "application/pdf" })]);

			await expect
				.element(screen.getByText("This picker does not accept that file"))
				.toBeInTheDocument();
			expect(api.uploadMedia).not.toHaveBeenCalled();
		});

		it("uploads accepted dropped files and reports rejected files", async () => {
			const api = await import("../../src/lib/api");
			const screen = await renderModal();
			const dropZone = screen.getByText("Drag files here to upload").element();

			dispatchFileDrop(dropZone, [
				new File(["image"], "accepted.jpg", { type: "image/jpeg" }),
				new File(["pdf"], "rejected.pdf", { type: "application/pdf" }),
			]);

			await vi.waitFor(() => {
				expect(api.uploadMedia).toHaveBeenCalledTimes(1);
			});
			await expect.element(screen.getByText("1 file uploaded, 1 file failed")).toBeInTheDocument();
		});

		it("accepts dropped files with generic MIME metadata when the extension matches the picker filters", async () => {
			const api = await import("../../src/lib/api");
			const screen = await renderModal();
			const dropZone = screen.getByText("Drag files here to upload").element();
			const file = new File(["image"], "generic.jpg", { type: "application/octet-stream" });

			dispatchFileDrop(dropZone, [file]);

			await vi.waitFor(() => {
				expect(api.uploadMedia).toHaveBeenCalledTimes(1);
			});
			expect(api.uploadMedia).toHaveBeenCalledWith(file, { fieldId: undefined });
		});

		it("shows batch progress while a dropped picker upload is pending", async () => {
			const api = await import("../../src/lib/api");
			(api.uploadMedia as any).mockImplementationOnce(
				() =>
					new Promise(() => {
						// Keep the first upload pending so progress remains visible.
					}),
			);
			const screen = await renderModal();
			const dropZone = screen.getByText("Drag files here to upload").element();

			dispatchFileDrop(dropZone, [
				new File(["one"], "one.jpg", { type: "image/jpeg" }),
				new File(["two"], "two.jpg", { type: "image/jpeg" }),
			]);

			await expect.element(screen.getByText("Uploading 0/2...")).toBeInTheDocument();
		});

		it("shows a reject drop state while a picker upload is pending", async () => {
			const api = await import("../../src/lib/api");
			(api.uploadMedia as any).mockImplementationOnce(
				() =>
					new Promise(() => {
						// Keep the first upload pending so dragover should reject new drops.
					}),
			);
			const screen = await renderModal();
			const dropZone = screen.getByText("Drag files here to upload").element();

			dispatchFileDrop(dropZone, [
				new File(["one"], "one.jpg", { type: "image/jpeg" }),
				new File(["two"], "two.jpg", { type: "image/jpeg" }),
			]);
			await expect.element(screen.getByText("Uploading 0/2...")).toBeInTheDocument();

			dispatchFileDrag(dropZone, "dragenter");

			await expect.element(screen.getByText("Uploads are not available here")).toBeInTheDocument();
			expect(dropZone.closest('[aria-live="polite"]')?.className).toContain("border-kumo-danger");
		});

		it("does not start another picker upload batch while a dropped upload is pending", async () => {
			const api = await import("../../src/lib/api");
			(api.uploadMedia as any).mockImplementation(
				() =>
					new Promise(() => {
						// Keep the first upload pending so a second drop exercises the in-flight guard.
					}),
			);
			const screen = await renderModal();
			const dropZone = screen.getByText("Drag files here to upload").element();
			const firstFile = new File(["one"], "one.jpg", { type: "image/jpeg" });

			dispatchFileDrop(dropZone, [
				firstFile,
				new File(["queued"], "queued.jpg", { type: "image/jpeg" }),
			]);
			await expect.element(screen.getByText("Uploading 0/2...")).toBeInTheDocument();

			dispatchFileDrop(dropZone, [new File(["two"], "two.jpg", { type: "image/jpeg" })]);

			await vi.waitFor(() => {
				expect(api.uploadMedia).toHaveBeenCalledTimes(1);
			});
			expect(api.uploadMedia).toHaveBeenCalledWith(firstFile, { fieldId: undefined });
			await expect.element(screen.getByText("Uploading 0/2...")).toBeInTheDocument();
			expect(document.body.textContent).not.toContain("Upload already in progress");
		});

		it("does not apply a pending upload result after the picker closes and reopens", async () => {
			const api = await import("../../src/lib/api");
			let resolveUpload: (item: MediaItem) => void = () => {};
			let uploadSettled = false;
			(api.uploadMedia as any).mockImplementationOnce(() =>
				new Promise<MediaItem>((resolve) => {
					resolveUpload = resolve;
				}).then((item) => {
					uploadSettled = true;
					return item;
				}),
			);
			const onSelect = vi.fn();
			const screen = await render(
				<QueryWrapper>
					<ControlledModalForTest onSelect={onSelect} />
				</QueryWrapper>,
			);
			const input = screen.getByLabelText("Upload files").element();

			changeFileInput(input, [new File(["stale"], "stale.jpg", { type: "image/jpeg" })]);
			await expect
				.element(screen.getByRole("button", { name: "Uploading..." }))
				.toBeInTheDocument();
			[...document.querySelectorAll("button")]
				.find((button) => button.textContent?.trim() === "Cancel")!
				.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			[...document.querySelectorAll("button")]
				.find((button) => button.textContent?.trim() === "Reopen picker")!
				.click();
			await expect.element(screen.getByText("Select Image")).toBeInTheDocument();
			const uploadButtonAfterReopen = screen.getByRole("button", { name: UPLOAD_BUTTON_REGEX });
			await expect.element(uploadButtonAfterReopen).toBeInTheDocument();
			expect((uploadButtonAfterReopen.element() as HTMLButtonElement).disabled).toBe(false);
			expect(document.body.textContent).not.toContain("Uploading...");

			resolveUpload(makeMediaItem({ id: "stale-upload", filename: "stale.jpg" }));
			await vi.waitFor(() => {
				expect(uploadSettled).toBe(true);
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			expect(document.body.textContent).not.toContain("File uploaded");
			expect(document.body.textContent).not.toContain("stale.jpg");
			expect(onSelect).not.toHaveBeenCalled();
			const insertBtns = [...document.querySelectorAll("button")].filter(
				(b) => b.textContent?.trim() === "Insert",
			);
			expect(insertBtns.at(-1)?.disabled).toBe(true);
		});

		it("selects the last successfully uploaded local item", async () => {
			const api = await import("../../src/lib/api");
			(api.uploadMedia as any)
				.mockResolvedValueOnce(makeMediaItem({ id: "uploaded-1", filename: "first.jpg" }))
				.mockResolvedValueOnce(makeMediaItem({ id: "uploaded-2", filename: "second.jpg" }));
			const screen = await renderModal();
			const input = screen.getByLabelText("Upload files").element();

			changeFileInput(input, [
				new File(["one"], "first.jpg", { type: "image/jpeg" }),
				new File(["two"], "second.jpg", { type: "image/jpeg" }),
			]);

			await expect.element(screen.getByText("second.jpg")).toBeInTheDocument();
		});

		it("selects uploaded provider media and inserts the converted provider item", async () => {
			const api = await import("../../src/lib/api");
			const providerItem = {
				id: "provider-uploaded",
				filename: "provider.jpg",
				mimeType: "image/jpeg",
				size: 4096,
				width: 1600,
				height: 900,
				alt: "Provider image",
				previewUrl: "https://cdn.example.com/provider.jpg",
				meta: { source: "cloudflare" },
			};
			(api.fetchMediaProviders as any).mockResolvedValueOnce([
				{
					id: "cloudflare-images",
					name: "Cloudflare Images",
					capabilities: { browse: true, search: false, upload: true, delete: true },
				},
			]);
			(api.fetchProviderMedia as any).mockResolvedValue({ items: [] });
			(api.uploadToProvider as any).mockResolvedValueOnce(providerItem);
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });
			const providerTab = screen.getByRole("button", { name: "Cloudflare Images" });
			await expect.element(providerTab).toBeInTheDocument();
			providerTab.element().click();
			await vi.waitFor(() => {
				expect(api.fetchProviderMedia).toHaveBeenCalledWith(
					"cloudflare-images",
					expect.objectContaining({ limit: 50 }),
				);
			});
			const input = screen.getByLabelText("Upload files").element();
			const file = new File(["provider"], "provider.jpg", { type: "image/jpeg" });

			changeFileInput(input, [file]);

			await vi.waitFor(() => {
				expect(api.uploadToProvider).toHaveBeenCalledWith("cloudflare-images", file);
			});
			await expect.element(screen.getByText("provider.jpg")).toBeInTheDocument();
			const insertBtns = [...document.querySelectorAll("button")].filter(
				(b) => b.textContent?.trim() === "Insert",
			);
			insertBtns.at(-1)!.click();
			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "provider-uploaded",
					filename: "provider.jpg",
					provider: "cloudflare-images",
					url: "https://cdn.example.com/provider.jpg",
					meta: { source: "cloudflare" },
				}),
			);
		});
	});

	describe("inline metadata editing", () => {
		it("shows missing-alt indicators for local images without alt text", async () => {
			await renderModal();
			await vi.waitFor(() => {
				expect(document.body.textContent).toContain("Missing alt");
			});
		});

		it("opens a quick inline editor for selected local image metadata", async () => {
			const screen = await renderModal();
			const option = screen.getByRole("option", { name: /photo\.jpg/ });
			await expect.element(option).toBeInTheDocument();
			option.element().querySelector("button")!.click();

			const editButton = screen.getByRole("button", { name: "Add alt text" });
			await expect.element(editButton).toBeInTheDocument();
			editButton.element().click();

			await expect.element(screen.getByText("Edit media metadata")).toBeInTheDocument();
			await expect.element(screen.getByRole("textbox", { name: "Alt text" })).toBeInTheDocument();
			await expect.element(screen.getByRole("textbox", { name: "Caption" })).toBeInTheDocument();
		});

		it("closes the inline metadata editor when selection changes", async () => {
			const screen = await renderModal();
			const firstOption = screen.getByRole("option", { name: /photo\.jpg/ });
			const secondOption = screen.getByRole("option", { name: /landscape\.png/ });
			await expect.element(firstOption).toBeInTheDocument();
			await expect.element(secondOption).toBeInTheDocument();
			firstOption.element().querySelector("button")!.click();

			const editButton = screen.getByRole("button", { name: "Add alt text" });
			await expect.element(editButton).toBeInTheDocument();
			editButton.element().click();
			await expect.element(screen.getByText("Edit media metadata")).toBeInTheDocument();

			secondOption.element().querySelector("button")!.click();

			await vi.waitFor(() => {
				expect(document.body.textContent).not.toContain("Edit media metadata");
			});
		});

		it("disables Insert while metadata save is pending", async () => {
			const api = await import("../../src/lib/api");
			(api.updateMedia as any).mockImplementationOnce(
				() =>
					new Promise(() => {
						// Keep save pending so the footer Insert state can be asserted.
					}),
			);
			const screen = await renderModal();
			const option = screen.getByRole("option", { name: /photo\.jpg/ });
			await expect.element(option).toBeInTheDocument();
			option.element().querySelector("button")!.click();
			const editButton = screen.getByRole("button", { name: "Add alt text" });
			await expect.element(editButton).toBeInTheDocument();
			editButton.element().click();
			await screen.getByRole("textbox", { name: "Alt text" }).fill("Pending description");
			screen.getByRole("button", { name: "Save" }).element().click();

			await vi.waitFor(() => {
				const insertBtns = [...document.querySelectorAll("button")].filter(
					(b) => b.textContent?.trim() === "Insert",
				);
				expect(insertBtns.at(-1)?.disabled).toBe(true);
			});
		});

		it("does not double-click insert while metadata save is pending", async () => {
			const api = await import("../../src/lib/api");
			(api.updateMedia as any).mockImplementationOnce(
				() =>
					new Promise(() => {
						// Keep save pending so double-click insertion should be gated.
					}),
			);
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });
			const option = screen.getByRole("option", { name: /photo\.jpg/ });
			await expect.element(option).toBeInTheDocument();
			const optionButton = option.element().querySelector("button")!;
			optionButton.click();
			const editButton = screen.getByRole("button", { name: "Add alt text" });
			await expect.element(editButton).toBeInTheDocument();
			editButton.element().click();
			await screen.getByRole("textbox", { name: "Alt text" }).fill("Pending description");
			screen.getByRole("button", { name: "Save" }).element().click();

			await vi.waitFor(() => {
				expect(api.updateMedia).toHaveBeenCalled();
			});
			optionButton.dispatchEvent(new MouseEvent("dblclick", { bubbles: true }));

			expect(onSelect).not.toHaveBeenCalled();
		});

		it("does not apply a pending metadata save after the picker closes and reopens", async () => {
			const api = await import("../../src/lib/api");
			let resolveUpdate: (item: MediaItem) => void = () => {};
			let updateSettled = false;
			(api.updateMedia as any).mockImplementationOnce(() =>
				new Promise<MediaItem>((resolve) => {
					resolveUpdate = resolve;
				}).then((item) => {
					updateSettled = true;
					return item;
				}),
			);
			const onSelect = vi.fn();
			const screen = await render(
				<QueryWrapper>
					<ControlledModalForTest onSelect={onSelect} />
				</QueryWrapper>,
			);
			const option = screen.getByRole("option", { name: /photo\.jpg/ });
			await expect.element(option).toBeInTheDocument();
			option.element().querySelector("button")!.click();
			const editButton = screen.getByRole("button", { name: "Add alt text" });
			await expect.element(editButton).toBeInTheDocument();
			editButton.element().click();
			await screen.getByRole("textbox", { name: "Alt text" }).fill("Stale description");
			await screen.getByRole("textbox", { name: "Caption" }).fill("Stale caption");
			screen.getByRole("button", { name: "Save" }).element().click();

			await vi.waitFor(() => {
				expect(api.updateMedia).toHaveBeenCalled();
			});
			[...document.querySelectorAll("button")]
				.find((button) => button.textContent?.trim() === "Cancel")!
				.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			[...document.querySelectorAll("button")]
				.find((button) => button.textContent?.trim() === "Reopen picker")!
				.click();
			await expect.element(screen.getByText("Select Image")).toBeInTheDocument();

			const reopenedOption = screen.getByRole("option", { name: /photo\.jpg/ });
			await expect.element(reopenedOption).toBeInTheDocument();
			reopenedOption.element().querySelector("button")!.click();
			const reopenedEditButton = screen.getByRole("button", { name: "Add alt text" });
			await expect.element(reopenedEditButton).toBeInTheDocument();
			reopenedEditButton.element().click();
			const saveButton = screen.getByRole("button", { name: "Save" });
			await expect.element(saveButton).toBeInTheDocument();
			expect((saveButton.element() as HTMLButtonElement).disabled).toBe(false);
			expect(document.body.textContent).not.toContain("Saving...");
			await vi.waitFor(() => {
				expect(getLastButtonByText("Insert").disabled).toBe(false);
			});

			resolveUpdate(
				makeMediaItem({
					alt: "Stale description",
					caption: "Stale caption",
				}),
			);
			await vi.waitFor(() => {
				expect(updateSettled).toBe(true);
			});
			await new Promise((resolve) => setTimeout(resolve, 0));

			getLastButtonByText("Insert").click();
			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({
					id: "m1",
					filename: "photo.jpg",
				}),
			);
			expect(onSelect.mock.calls[0][0]).not.toMatchObject({
				alt: "Stale description",
				caption: "Stale caption",
			});
		});

		it("saves alt text and caption through updateMedia", async () => {
			const api = await import("../../src/lib/api");
			const onSelect = vi.fn();
			const updatedItem = makeMediaItem({
				alt: "A useful description",
				caption: "A short caption",
			});
			(api.fetchMediaList as any)
				.mockResolvedValueOnce({ items: [makeMediaItem()] })
				.mockResolvedValue({ items: [updatedItem] });
			(api.updateMedia as any).mockResolvedValueOnce(updatedItem);
			const screen = await renderModal({ onSelect });
			const option = screen.getByRole("option", { name: /photo\.jpg/ });
			await expect.element(option).toBeInTheDocument();
			option.element().querySelector("button")!.click();
			const editButton = screen.getByRole("button", { name: "Add alt text" });
			await expect.element(editButton).toBeInTheDocument();
			editButton.element().click();

			await screen.getByRole("textbox", { name: "Alt text" }).fill(" A useful description ");
			await screen.getByRole("textbox", { name: "Caption" }).fill(" A short caption ");
			screen.getByRole("button", { name: "Save" }).element().click();

			await vi.waitFor(() => {
				expect(api.updateMedia).toHaveBeenCalledWith("m1", {
					alt: "A useful description",
					caption: "A short caption",
				});
			});
			await expect.element(screen.getByText("Alt set")).toBeInTheDocument();
			const insertBtns = [...document.querySelectorAll("button")].filter(
				(b) => b.textContent?.trim() === "Insert",
			);
			insertBtns.at(-1)!.click();
			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({
					alt: "A useful description",
					caption: "A short caption",
				}),
			);
		});

		it("clears existing alt text and caption through updateMedia", async () => {
			const api = await import("../../src/lib/api");
			const onSelect = vi.fn();
			const itemWithMetadata = makeMediaItem({
				alt: "Existing description",
				caption: "Existing caption",
			});
			const clearedItem = makeMediaItem({ alt: "", caption: "" });
			(api.fetchMediaList as any)
				.mockResolvedValueOnce({ items: [itemWithMetadata] })
				.mockResolvedValue({ items: [clearedItem] });
			(api.updateMedia as any).mockResolvedValueOnce(clearedItem);
			const screen = await renderModal({ onSelect });
			const option = screen.getByRole("option", { name: /photo\.jpg/ });
			await expect.element(option).toBeInTheDocument();
			option.element().querySelector("button")!.click();
			const editButton = screen.getByRole("button", { name: "Edit alt and caption" });
			await expect.element(editButton).toBeInTheDocument();
			editButton.element().click();

			await screen.getByRole("textbox", { name: "Alt text" }).fill("   ");
			await screen.getByRole("textbox", { name: "Caption" }).fill("   ");
			screen.getByRole("button", { name: "Save" }).element().click();

			await vi.waitFor(() => {
				expect(api.updateMedia).toHaveBeenCalledWith("m1", {
					alt: "",
					caption: "",
				});
			});
			await expect.element(screen.getByText("Missing alt")).toBeInTheDocument();
			expect(document.body.textContent).not.toContain("Caption set");
			const insertBtns = [...document.querySelectorAll("button")].filter(
				(b) => b.textContent?.trim() === "Insert",
			);
			insertBtns.at(-1)!.click();
			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({
					alt: "",
					caption: "",
				}),
			);
		});
	});

	describe("load more pagination", () => {
		it("renders Load More button when first page returns nextCursor", async () => {
			const api = await import("../../src/lib/api");
			(api.fetchMediaList as any).mockResolvedValueOnce({
				items: [
					{
						id: "p1",
						filename: "page1.jpg",
						mimeType: "image/jpeg",
						url: "/media/page1.jpg",
						size: 1024,
						width: 800,
						height: 600,
						createdAt: "2024-01-01",
					},
				],
				nextCursor: "cursor-2",
			});

			const screen = await renderModal();
			await expect.element(screen.getByRole("option", { name: "page1.jpg" })).toBeInTheDocument();
			await expect.element(screen.getByRole("button", { name: "Load More" })).toBeInTheDocument();
		});

		it("does not render Load More button when no nextCursor", async () => {
			const screen = await renderModal();
			// Default mock returns 2 items with no nextCursor → button should be absent
			await expect.element(screen.getByRole("option", { name: "photo.jpg" })).toBeInTheDocument();
			expect(screen.getByRole("button", { name: "Load More" }).query()).toBeNull();
		});

		it("keeps already-loaded items visible while fetching the next page", async () => {
			// Reproduces the Copilot review concern: when the next-page fetch is
			// in flight, the picker grid must not blank out into a centered
			// loader — the user's prior selection / scroll context would be lost.
			const api = await import("../../src/lib/api");
			const mock = api.fetchMediaList as any;
			mock.mockReset();
			let resolveSecond: (value: unknown) => void = () => {};
			const secondPagePromise = new Promise((resolve) => {
				resolveSecond = resolve;
			});
			mock
				.mockResolvedValueOnce({
					items: [
						{
							id: "p1",
							filename: "page1.jpg",
							mimeType: "image/jpeg",
							url: "/media/page1.jpg",
							size: 1024,
							width: 800,
							height: 600,
							createdAt: "2024-01-01",
						},
					],
					nextCursor: "cursor-2",
				})
				.mockReturnValueOnce(secondPagePromise);

			const screen = await renderModal();
			await expect.element(screen.getByRole("option", { name: "page1.jpg" })).toBeInTheDocument();

			const loadMoreBtn = [...document.querySelectorAll("button")].find(
				(b) => b.textContent?.trim() === "Load More",
			)!;
			loadMoreBtn.click();

			// While the second page is still pending, the first-page item must
			// stay in the DOM (not be replaced by a centered loader).
			await expect.element(screen.getByRole("option", { name: "page1.jpg" })).toBeInTheDocument();

			resolveSecond({ items: [] });
		});

		it("Load More click fetches the next page with the previous cursor", async () => {
			const api = await import("../../src/lib/api");
			const mock = api.fetchMediaList as any;
			mock.mockReset();
			mock
				.mockResolvedValueOnce({
					items: [
						{
							id: "p1",
							filename: "page1.jpg",
							mimeType: "image/jpeg",
							url: "/media/page1.jpg",
							size: 1024,
							width: 800,
							height: 600,
							createdAt: "2024-01-01",
						},
					],
					nextCursor: "cursor-2",
				})
				.mockResolvedValueOnce({
					items: [
						{
							id: "p2",
							filename: "page2.jpg",
							mimeType: "image/jpeg",
							url: "/media/page2.jpg",
							size: 1024,
							width: 800,
							height: 600,
							createdAt: "2024-01-02",
						},
					],
				});

			const screen = await renderModal();
			await expect.element(screen.getByRole("option", { name: "page1.jpg" })).toBeInTheDocument();

			// Direct DOM click to bypass the dialog's inert overlay
			const loadMoreBtn = [...document.querySelectorAll("button")].find(
				(b) => b.textContent?.trim() === "Load More",
			)!;
			loadMoreBtn.click();

			await expect.element(screen.getByRole("option", { name: "page2.jpg" })).toBeInTheDocument();

			// Second call should have been made with the previous response's cursor.
			expect(mock).toHaveBeenCalledTimes(2);
			expect(mock.mock.calls[1][0]).toEqual(
				expect.objectContaining({ cursor: "cursor-2", limit: 100 }),
			);
		});
	});
});
