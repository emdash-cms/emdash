import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MediaPickerModal } from "../../src/components/MediaPickerModal";
import { render } from "../utils/render.tsx";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

// Anchored to the button's exact accessible name. Without anchors this also
// matches the hidden file `<input aria-label="Upload file">` and trips
// playwright's strict-mode "resolved to N elements" guard.
const UPLOAD_BUTTON_REGEX = /^Upload files$/;

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
					focalX: 0.2,
					focalY: 0.8,
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
			totalCount: 2,
		}),
		fetchMediaFolders: vi.fn().mockResolvedValue({
			items: [{ id: "folder-1", name: "Photography" }],
		}),
		fetchMediaFolder: vi.fn().mockResolvedValue({ id: "folder-1", name: "Photography" }),
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

async function openUrlSource(screen: Awaited<ReturnType<typeof renderModal>>) {
	screen.getByRole("tab", { name: "From URL" }).element().click();
}

describe("MediaPickerModal", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});
	afterEach(() => vi.unstubAllGlobals());

	describe("displaying items", () => {
		it("shows media items when open", async () => {
			const screen = await renderModal({ open: true });
			await expect.element(screen.getByRole("button", { name: "photo.jpg" })).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: "landscape.png" }))
				.toBeInTheDocument();
			const image = screen
				.getByRole("button", { name: "photo.jpg" })
				.element()
				.querySelector("img");
			expect(image?.style.objectPosition).toBe("20% 80%");
		});

		it("shows the modal title", async () => {
			const screen = await renderModal({ title: "Pick an Image" });
			await expect.element(screen.getByText("Pick an Image")).toBeInTheDocument();
		});
	});

	describe("selection", () => {
		it("single click selects item (highlighted)", async () => {
			const screen = await renderModal();
			const item = screen.getByRole("button", { name: "photo.jpg" });
			await expect.element(item).toBeInTheDocument();
			item.element().click();

			await expect.element(item).toHaveAttribute("aria-pressed", "true");
		});

		it("keeps the footer free of redundant selection copy", async () => {
			const screen = await renderModal();
			expect(document.body.textContent).not.toContain("No media selected");

			const item = screen.getByRole("button", { name: "photo.jpg" });
			await expect.element(item).toBeInTheDocument();
			item.element().click();

			expect(document.body.textContent).not.toContain("Selected: photo.jpg");
		});

		it("double click does not bypass confirmation", async () => {
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });

			const item = screen.getByRole("button", { name: "photo.jpg" });
			await expect.element(item).toBeInTheDocument();
			item.element().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 1 }));
			item.element().dispatchEvent(new MouseEvent("click", { bubbles: true, detail: 2 }));
			item.element().dispatchEvent(new MouseEvent("dblclick", { bubbles: true, detail: 2 }));

			expect(onSelect).not.toHaveBeenCalled();
			await expect.element(item).toHaveAttribute("aria-pressed", "true");
		});

		it("Select button is disabled when nothing is selected", async () => {
			const screen = await renderModal();
			await expect.element(screen.getByRole("button", { name: "Select" })).toBeDisabled();
		});

		it("Select button confirms the selected item", async () => {
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });

			const item = screen.getByRole("button", { name: "photo.jpg" });
			await expect.element(item).toBeInTheDocument();
			item.element().click();
			await expect.element(item).toHaveAttribute("aria-pressed", "true");
			screen.getByRole("button", { name: "Select" }).element().click();

			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({ id: "m1", filename: "photo.jpg" }),
			);
		});
	});

	describe("URL input", () => {
		it("invalid URL shows error", async () => {
			const screen = await renderModal();
			await openUrlSource(screen);

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

			screen.getByRole("button", { name: "Use URL" }).element().click();

			await expect.element(screen.getByText("Please enter a valid URL")).toBeInTheDocument();
		});

		it("URL input: typing a URL and submitting triggers probe", async () => {
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });
			await openUrlSource(screen);

			const urlInput = screen.getByLabelText("Image URL");
			const inputEl = urlInput.element() as HTMLInputElement;
			const nativeInputValueSetter = Object.getOwnPropertyDescriptor(
				HTMLInputElement.prototype,
				"value",
			)!.set!;
			nativeInputValueSetter.call(inputEl, "https://example.com/test.jpg");
			inputEl.dispatchEvent(new Event("input", { bubbles: true }));
			inputEl.dispatchEvent(new Event("change", { bubbles: true }));

			screen.getByRole("button", { name: "Use URL" }).element().click();

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
			await expect.element(screen.getByText("Select image")).toBeInTheDocument();
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

			await expect.element(screen.getByText("Select image")).toBeInTheDocument();
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
			(api.fetchMediaProviders as any).mockResolvedValueOnce([
				{
					id: "cloudflare-images",
					name: "Cloudflare Images",
					capabilities: { upload: true, search: false },
				},
				{
					id: "unsplash",
					name: "Unsplash",
					capabilities: { upload: false, search: true },
				},
			]);

			const screen = await renderModal({ localOnly: true });

			await expect.element(screen.getByText("Select image")).toBeInTheDocument();
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

			await expect.element(screen.getByText("Select file")).toBeInTheDocument();
			expect(document.body.textContent).not.toContain("Select image");

			await expect.element(screen.getByText("Upload a file to get started")).toBeInTheDocument();
			await expect
				.element(screen.getByRole("button", { name: UPLOAD_BUTTON_REGEX }))
				.toBeInTheDocument();
			expect(document.body.textContent).not.toContain("Upload an image to get started");
		});

		it("defaults to image-specific copy when mediaKind is unset", async () => {
			const api = await import("../../src/lib/api");
			(api.fetchMediaList as any).mockResolvedValueOnce({ items: [] });

			const screen = await renderModal();

			await expect.element(screen.getByText("Select image")).toBeInTheDocument();
			await expect.element(screen.getByText("Upload an image to get started")).toBeInTheDocument();
		});
	});

	describe("cancel and close", () => {
		it("Cancel closes modal", async () => {
			const onOpenChange = vi.fn();
			const screen = await renderModal({ onOpenChange });

			await expect.element(screen.getByText("Select image")).toBeInTheDocument();
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
			const item = screen.getByRole("button", { name: "photo.jpg" });
			await expect.element(item).toBeInTheDocument();
			item.element().click();

			await expect.element(item).toHaveAttribute("aria-pressed", "true");

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

			await expect.element(screen.getByRole("button", { name: "Select" })).toBeDisabled();
		});
	});

	describe("upload", () => {
		it("upload button and file input are present", async () => {
			const screen = await renderModal();
			await expect
				.element(screen.getByRole("button", { name: UPLOAD_BUTTON_REGEX }))
				.toBeInTheDocument();
			await expect.element(screen.getByLabelText("Choose files to upload")).toBeInTheDocument();
		});
	});

	describe("library browsing", () => {
		it("uses fixed twelve-item pages without a page-size control", async () => {
			const api = await import("../../src/lib/api");
			const mock = api.fetchMediaList as any;
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
					totalCount: 36,
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
					totalCount: 36,
				});

			const screen = await renderModal();
			await expect.element(screen.getByRole("button", { name: "page1.jpg" })).toBeInTheDocument();
			expect(screen.getByRole("combobox", { name: "Page size" }).query()).toBeNull();
			await expect
				.element(screen.getByRole("textbox", { name: "Page number" }))
				.toBeInTheDocument();
			expect(screen.getByRole("combobox", { name: "Page number" }).query()).toBeNull();
			screen.getByRole("button", { name: "Next page" }).element().click();
			await expect.element(screen.getByRole("button", { name: "page2.jpg" })).toBeInTheDocument();
			expect(mock).toHaveBeenCalledTimes(2);
			expect(mock.mock.calls[1][0]).toEqual(expect.objectContaining({ page: 2, limit: 12 }));
		});

		it("opens a folder and filters the media query", async () => {
			const api = await import("../../src/lib/api");
			const screen = await renderModal();

			await expect
				.element(screen.getByRole("button", { name: "Open folder Photography" }))
				.toBeInTheDocument();
			screen.getByRole("button", { name: "Open folder Photography" }).element().click();

			await vi.waitFor(() => {
				expect(api.fetchMediaList).toHaveBeenLastCalledWith(
					expect.objectContaining({ folderId: "folder-1", page: 1, limit: 12 }),
				);
			});
		});

		it("keeps uploads in the main library by hiding upload inside a folder", async () => {
			const screen = await renderModal();
			await expect
				.element(screen.getByRole("button", { name: "Open folder Photography" }))
				.toBeInTheDocument();
			screen.getByRole("button", { name: "Open folder Photography" }).element().click();

			await expect.element(screen.getByText("Photography", { exact: true })).toBeInTheDocument();
			expect(screen.getByRole("button", { name: UPLOAD_BUTTON_REGEX }).query()).toBeNull();
		});

		it("offers grid and list views", async () => {
			const screen = await renderModal();

			await expect.element(screen.getByRole("tab", { name: "Grid view" })).toBeInTheDocument();
			screen.getByRole("tab", { name: "List view" }).element().click();
			await expect
				.element(screen.getByRole("button", { name: "photo.jpg" }))
				.toHaveAttribute("data-media-layout", "list");
		});

		it("keeps detected image dimensions when selecting from list view", async () => {
			const api = await import("../../src/lib/api");
			(api.fetchMediaList as any).mockResolvedValueOnce({
				items: [
					{
						id: "missing-size",
						filename: "missing-size.jpg",
						mimeType: "image/jpeg",
						url: "/media/missing-size.jpg",
						size: 1024,
						createdAt: "2024-01-01",
					},
				],
				totalCount: 1,
			});
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });
			screen.getByRole("tab", { name: "List view" }).element().click();
			const item = screen.getByRole("button", { name: "missing-size.jpg" });
			await expect.element(item).toHaveAttribute("data-media-layout", "list");
			const image = item.element().querySelector("img")!;
			Object.defineProperties(image, {
				naturalWidth: { configurable: true, value: 1280 },
				naturalHeight: { configurable: true, value: 720 },
			});
			image.dispatchEvent(new Event("load", { bubbles: true }));
			await vi.waitFor(() => {
				expect(api.updateMedia).toHaveBeenCalledWith("missing-size", {
					width: 1280,
					height: 720,
				});
			});

			item.element().click();
			await expect.element(item).toHaveAttribute("aria-pressed", "true");
			screen.getByRole("button", { name: "Select" }).element().click();
			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({ id: "missing-size", width: 1280, height: 720 }),
			);
		});

		it("shows direct URLs as a source", async () => {
			const screen = await renderModal();

			await expect.element(screen.getByRole("tab", { name: "From URL" })).toBeInTheDocument();
			screen.getByRole("tab", { name: "From URL" }).element().click();
			await expect.element(screen.getByLabelText("Image URL")).toBeInTheDocument();
		});

		it("combines the caller allowlist with the selected type", async () => {
			const api = await import("../../src/lib/api");
			const screen = await renderModal({ mimeTypeFilters: [] });

			screen.getByRole("combobox", { name: "Filter by type" }).element().click();
			await expect.element(screen.getByRole("option", { name: "Video" })).toBeInTheDocument();
			screen.getByRole("option", { name: "Video" }).element().click();

			await vi.waitFor(() => {
				expect(api.fetchMediaList).toHaveBeenLastCalledWith(
					expect.objectContaining({ mimeType: ["video/"], page: 1 }),
				);
			});
		});

		it("selects a direct URL only after confirmation", async () => {
			class LoadedImage {
				naturalWidth = 640;
				naturalHeight = 480;
				onload: (() => void) | null = null;
				onerror: (() => void) | null = null;
				set src(_value: string) {
					queueMicrotask(() => this.onload?.());
				}
			}
			vi.stubGlobal("Image", LoadedImage);
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });
			await openUrlSource(screen);
			const input = screen.getByLabelText("Image URL").element() as HTMLInputElement;
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			setValue.call(input, "https://example.com/cover.png");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			screen.getByRole("button", { name: "Use URL" }).element().click();

			await expect
				.element(screen.getByRole("button", { name: "cover.png" }))
				.toHaveAttribute("aria-pressed", "true");
			expect(onSelect).not.toHaveBeenCalled();
			screen.getByRole("button", { name: "Select" }).element().click();

			expect(onSelect).toHaveBeenCalledWith(
				expect.objectContaining({
					url: "https://example.com/cover.png",
					provider: "external",
					width: 640,
					height: 480,
				}),
			);
		});

		it("keeps the previous page visible but inert while the next page loads", async () => {
			const api = await import("../../src/lib/api");
			let resolveNextPage!: (value: {
				items: Array<Record<string, unknown>>;
				totalCount: number;
			}) => void;
			const nextPage = new Promise<{
				items: Array<Record<string, unknown>>;
				totalCount: number;
			}>((resolve) => {
				resolveNextPage = resolve;
			});
			(api.fetchMediaList as any)
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
					totalCount: 36,
				})
				.mockReturnValueOnce(nextPage);
			const screen = await renderModal();
			await expect.element(screen.getByRole("button", { name: "page1.jpg" })).toBeInTheDocument();

			screen.getByRole("button", { name: "Next page" }).element().click();
			await vi.waitFor(() => expect(api.fetchMediaList).toHaveBeenCalledTimes(2));
			const results = screen.getByRole("region", { name: "Media results" });
			const itemSurface = document.querySelector<HTMLElement>("[data-media-items]")!;
			await expect.element(results).toHaveAttribute("aria-busy", "true");
			expect(itemSurface).toHaveAttribute("inert");
			await expect.element(screen.getByRole("button", { name: "page1.jpg" })).toBeInTheDocument();

			resolveNextPage({
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
				totalCount: 36,
			});
			await expect.element(screen.getByRole("button", { name: "page2.jpg" })).toBeInTheDocument();
			expect(itemSurface).not.toHaveAttribute("inert");
		});

		it("ignores a URL probe that finishes after a newer request", async () => {
			class ControlledImage {
				static instances: ControlledImage[] = [];
				naturalWidth = 640;
				naturalHeight = 480;
				onload: (() => void) | null = null;
				onerror: (() => void) | null = null;
				constructor() {
					ControlledImage.instances.push(this);
				}
				set src(_value: string) {}
			}
			vi.stubGlobal("Image", ControlledImage);
			const screen = await renderModal();
			await openUrlSource(screen);
			const input = screen.getByLabelText("Image URL").element() as HTMLInputElement;
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;

			setValue.call(input, "https://example.com/first.png");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			screen.getByRole("button", { name: "Use URL" }).element().click();
			await vi.waitFor(() => expect(ControlledImage.instances).toHaveLength(1));

			setValue.call(input, "https://example.com/second.png");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			input.dispatchEvent(new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }));
			await vi.waitFor(() => expect(ControlledImage.instances).toHaveLength(2));

			ControlledImage.instances[1]!.onload?.();
			await expect
				.element(screen.getByRole("button", { name: "second.png" }))
				.toHaveAttribute("aria-pressed", "true");
			ControlledImage.instances[0]!.onload?.();
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

			await expect
				.element(screen.getByRole("button", { name: "second.png" }))
				.toHaveAttribute("aria-pressed", "true");
			expect(screen.getByRole("button", { name: "first.png" }).query()).toBeNull();
		});

		it("ignores a URL probe after selecting from the library", async () => {
			class ControlledImage {
				static instance: ControlledImage;
				naturalWidth = 640;
				naturalHeight = 480;
				onload: (() => void) | null = null;
				onerror: (() => void) | null = null;
				constructor() {
					ControlledImage.instance = this;
				}
				set src(_value: string) {}
			}
			vi.stubGlobal("Image", ControlledImage);
			const onSelect = vi.fn();
			const screen = await renderModal({ onSelect });
			await openUrlSource(screen);
			const input = screen.getByLabelText("Image URL").element() as HTMLInputElement;
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			setValue.call(input, "https://example.com/slow.png");
			input.dispatchEvent(new Event("input", { bubbles: true }));
			input.dispatchEvent(new Event("change", { bubbles: true }));
			screen.getByRole("button", { name: "Use URL" }).element().click();
			await vi.waitFor(() => expect(ControlledImage.instance).toBeDefined());

			screen.getByRole("tab", { name: "Library" }).element().click();
			await expect.element(screen.getByRole("button", { name: "photo.jpg" })).toBeInTheDocument();
			screen.getByRole("button", { name: "photo.jpg" }).element().click();
			await expect
				.element(screen.getByRole("button", { name: "photo.jpg" }))
				.toHaveAttribute("aria-pressed", "true");
			ControlledImage.instance.onload?.();
			await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));

			screen.getByRole("button", { name: "Select" }).element().click();
			expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ filename: "photo.jpg" }));
		});

		it("clears a global search before opening one of its folder results", async () => {
			const api = await import("../../src/lib/api");
			const screen = await renderModal();
			const search = screen.getByRole("searchbox", { name: "Search media" }).element();
			const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
			setValue.call(search, "report");
			search.dispatchEvent(new Event("input", { bubbles: true }));
			search.dispatchEvent(new Event("change", { bubbles: true }));
			await vi.waitFor(() => {
				expect(api.fetchMediaList).toHaveBeenLastCalledWith(
					expect.objectContaining({ search: "report", folderId: undefined }),
				);
			});

			await expect
				.element(screen.getByRole("button", { name: "Open folder Photography" }))
				.toBeInTheDocument();
			screen.getByRole("button", { name: "Open folder Photography" }).element().click();

			await vi.waitFor(() => {
				expect(api.fetchMediaList).toHaveBeenLastCalledWith(
					expect.objectContaining({ search: undefined, folderId: "folder-1", page: 1 }),
				);
			});
		});
	});
});
