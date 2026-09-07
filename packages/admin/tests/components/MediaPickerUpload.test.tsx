import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MediaPickerModal } from "../../src/components/MediaPickerModal.js";
import type { MediaItem } from "../../src/lib/api/media.js";
import { render } from "../utils/render.js";

const apiMocks = vi.hoisted(() => ({
	uploadMedia: vi.fn<(file: File, options?: unknown) => Promise<MediaItem>>(),
}));

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual<typeof import("../../src/lib/api")>("../../src/lib/api");
	return {
		...actual,
		fetchMediaList: vi.fn().mockResolvedValue({ items: [], totalCount: 0 }),
		fetchMediaFolders: vi.fn().mockResolvedValue({ items: [] }),
		fetchMediaFolder: vi.fn().mockResolvedValue({ id: "folder-1", name: "Photography" }),
		fetchMediaProviders: vi.fn().mockResolvedValue([]),
		fetchProviderMedia: vi.fn().mockResolvedValue({ items: [] }),
		uploadMedia: apiMocks.uploadMedia,
	};
});

function deferred<T>() {
	let resolve!: (value: T) => void;
	let reject!: (reason?: unknown) => void;
	const promise = new Promise<T>((resolvePromise, rejectPromise) => {
		resolve = resolvePromise;
		reject = rejectPromise;
	});
	return { promise, resolve, reject };
}

function mediaItem(id: string, filename: string): MediaItem {
	return {
		id,
		filename,
		mimeType: "image/jpeg",
		url: `/_emdash/api/media/file/${filename}`,
		storageKey: filename,
		size: 1024,
		width: 800,
		height: 600,
		createdAt: "2026-09-03T00:00:00.000Z",
	};
}

function setInputFiles(input: HTMLInputElement, files: File[]) {
	const transfer = new DataTransfer();
	for (const file of files) transfer.items.add(file);
	input.files = transfer.files;
	input.dispatchEvent(new Event("change", { bubbles: true }));
}

async function renderPicker(props: Partial<React.ComponentProps<typeof MediaPickerModal>> = {}) {
	const queryClient = new QueryClient({
		defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
	});
	return render(
		<QueryClientProvider client={queryClient}>
			<MediaPickerModal open onOpenChange={vi.fn()} onSelect={vi.fn()} {...props} />
		</QueryClientProvider>,
	);
}

describe("MediaPickerModal inline uploads", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("uploads one file inline and turns it into the selected card", async () => {
		const pending = deferred<MediaItem>();
		apiMocks.uploadMedia.mockReturnValueOnce(pending.promise);
		const screen = await renderPicker();
		const files = [
			new File(["first"], "first.jpg", { type: "image/jpeg" }),
			new File(["ignored"], "ignored.jpg", { type: "image/jpeg" }),
		];

		setInputFiles(
			screen.getByLabelText("Choose files to upload").element() as HTMLInputElement,
			files,
		);

		await vi.waitFor(() => expect(apiMocks.uploadMedia).toHaveBeenCalledTimes(1));
		await expect.element(screen.getByText("Uploading", { exact: true })).toBeInTheDocument();
		const placeholder = screen
			.getByText("first.jpg", { exact: true })
			.element()
			.closest("[data-upload-status]")!;
		expect(placeholder).toHaveAttribute("data-upload-status", "uploading");
		expect(placeholder.querySelector("img")).toBeNull();
		expect(screen.getByRole("dialog").all()).toHaveLength(1);
		await expect.element(screen.getByRole("tab", { name: "From URL" })).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Select" })).toBeDisabled();

		pending.resolve(mediaItem("uploaded-1", "first.jpg"));
		await expect
			.element(screen.getByRole("button", { name: "first.jpg" }))
			.toHaveAttribute("aria-pressed", "true");
		await expect.element(screen.getByRole("button", { name: "Select" })).toBeEnabled();
		await expect.element(screen.getByRole("tab", { name: "From URL" })).toBeEnabled();
		expect(apiMocks.uploadMedia.mock.calls[0]?.[0].name).toBe("first.jpg");
	});

	it("accepts files dropped onto the picker results", async () => {
		apiMocks.uploadMedia.mockImplementation(() => new Promise<MediaItem>(() => undefined));
		const screen = await renderPicker();
		const transfer = new DataTransfer();
		transfer.items.add(new File(["drop"], "dropped.jpg", { type: "image/jpeg" }));
		const results = screen.getByRole("region", { name: "Media results" }).element();
		results.dispatchEvent(new DragEvent("dragover", { bubbles: true, dataTransfer: transfer }));
		results.dispatchEvent(new DragEvent("drop", { bubbles: true, dataTransfer: transfer }));

		await vi.waitFor(() => expect(apiMocks.uploadMedia).toHaveBeenCalledTimes(1));
		await expect.element(screen.getByText("dropped.jpg", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("Uploading", { exact: true })).toBeInTheDocument();
	});

	it("derives the local URL when a deduplicated upload omits it", async () => {
		const uploaded = mediaItem("existing-1", "existing.jpg");
		apiMocks.uploadMedia.mockResolvedValueOnce({
			...uploaded,
			url: undefined as unknown as string,
		});
		const screen = await renderPicker();
		setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
			new File(["existing"], "existing.jpg", { type: "image/jpeg" }),
		]);

		const card = screen.getByRole("button", { name: "existing.jpg", exact: true });
		await expect.element(card).toHaveAttribute("aria-pressed", "true");
		expect(
			decodeURIComponent(card.element().querySelector("img")?.getAttribute("src") ?? ""),
		).toContain("/_emdash/api/media/file/existing.jpg");
	});

	it("does not show a Main-library upload inside a folder", async () => {
		const api = await import("../../src/lib/api");
		(api.fetchMediaFolders as any).mockResolvedValueOnce({
			items: [{ id: "folder-1", name: "Photography" }],
		});
		apiMocks.uploadMedia.mockResolvedValueOnce(mediaItem("uploaded-1", "main-only.jpg"));
		const screen = await renderPicker();
		setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
			new File(["main"], "main-only.jpg", { type: "image/jpeg" }),
		]);
		await expect
			.element(screen.getByRole("button", { name: "main-only.jpg", exact: true }))
			.toBeInTheDocument();

		screen.getByRole("button", { name: "Open folder Photography" }).element().click();
		await expect.element(screen.getByText("Photography", { exact: true })).toBeInTheDocument();
		expect(screen.getByRole("button", { name: "main-only.jpg", exact: true }).query()).toBeNull();
	});

	it("prevents a disabled-source file drop from leaving the editor", async () => {
		const api = await import("../../src/lib/api");
		(api.fetchMediaFolders as any).mockResolvedValueOnce({
			items: [{ id: "folder-1", name: "Photography" }],
		});
		const screen = await renderPicker();
		await expect
			.element(screen.getByRole("button", { name: "Open folder Photography" }))
			.toBeInTheDocument();
		screen.getByRole("button", { name: "Open folder Photography" }).element().click();
		await expect.element(screen.getByText("Photography", { exact: true })).toBeInTheDocument();

		const transfer = new DataTransfer();
		transfer.items.add(new File(["blocked"], "blocked.jpg", { type: "image/jpeg" }));
		const results = screen.getByRole("region", { name: "Media results" }).element();
		const dragOver = new DragEvent("dragover", {
			bubbles: true,
			cancelable: true,
			dataTransfer: transfer,
		});
		const drop = new DragEvent("drop", {
			bubbles: true,
			cancelable: true,
			dataTransfer: transfer,
		});
		results.dispatchEvent(dragOver);
		results.dispatchEvent(drop);

		expect(dragOver.defaultPrevented).toBe(true);
		expect(drop.defaultPrevented).toBe(true);
		expect(apiMocks.uploadMedia).not.toHaveBeenCalled();
	});

	it("keeps an uploaded selection while hiding it from a nonmatching search", async () => {
		apiMocks.uploadMedia.mockResolvedValueOnce(mediaItem("uploaded-1", "new.jpg"));
		const screen = await renderPicker({ multiple: true });
		setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
			new File(["new"], "new.jpg", { type: "image/jpeg" }),
		]);

		await expect
			.element(screen.getByRole("button", { name: "new.jpg", exact: true }))
			.toHaveAttribute("aria-pressed", "true");
		await screen.getByRole("searchbox", { name: "Search media" }).fill("report");

		await vi.waitFor(() => {
			expect(screen.getByRole("button", { name: "new.jpg", exact: true }).query()).toBeNull();
		});
		await expect
			.element(screen.getByRole("button", { name: "Remove new.jpg from selection" }))
			.toBeInTheDocument();
		await expect.element(screen.getByRole("button", { name: "Add 1 image" })).toBeEnabled();
	});

	it("shows failed files inline and retries only that file", async () => {
		apiMocks.uploadMedia
			.mockRejectedValueOnce(new Error("network"))
			.mockResolvedValueOnce(mediaItem("uploaded-2", "retry.jpg"));
		const screen = await renderPicker();
		setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
			new File(["retry"], "retry.jpg", { type: "image/jpeg" }),
		]);

		await expect.element(screen.getByText("Upload failed", { exact: true })).toBeInTheDocument();
		await expect
			.element(screen.getByRole("button", { name: "Remove retry.jpg" }))
			.toBeInTheDocument();
		screen.getByRole("button", { name: "Retry retry.jpg" }).element().click();

		await vi.waitFor(() => expect(apiMocks.uploadMedia).toHaveBeenCalledTimes(2));
		await expect
			.element(screen.getByRole("button", { name: "retry.jpg" }))
			.toHaveAttribute("aria-pressed", "true");
	});

	it("aborts an unfinished upload when the picker is cancelled", async () => {
		let signal: AbortSignal | undefined;
		apiMocks.uploadMedia.mockImplementation((_file, options) => {
			signal = (options as { signal?: AbortSignal } | undefined)?.signal;
			return new Promise<MediaItem>(() => undefined);
		});
		const onOpenChange = vi.fn();
		const screen = await renderPicker({ onOpenChange });
		setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
			new File(["cancel"], "cancel.jpg", { type: "image/jpeg" }),
		]);
		await vi.waitFor(() => expect(signal).toBeDefined());

		screen.getByRole("button", { name: "Cancel" }).element().click();

		expect(signal?.aborted).toBe(true);
		expect(onOpenChange).toHaveBeenCalledWith(false);
	});

	it("selects uploads in file order and returns the reordered tray", async () => {
		const first = deferred<MediaItem>();
		const second = deferred<MediaItem>();
		apiMocks.uploadMedia.mockImplementation((file) =>
			file.name === "first.jpg" ? first.promise : second.promise,
		);
		const onSelectMany = vi.fn();
		const screen = await renderPicker({ multiple: true, onSelectMany });
		setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
			new File(["first"], "first.jpg", { type: "image/jpeg" }),
			new File(["second"], "second.jpg", { type: "image/jpeg" }),
		]);
		await vi.waitFor(() => expect(apiMocks.uploadMedia).toHaveBeenCalledTimes(2));

		second.resolve(mediaItem("uploaded-2", "second.jpg"));
		first.resolve(mediaItem("uploaded-1", "first.jpg"));
		await expect.element(screen.getByText("1 of 2", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("2 of 2", { exact: true })).toBeInTheDocument();
		screen.getByRole("button", { name: "Move first.jpg later" }).element().click();
		await expect
			.element(screen.getByText("second.jpg", { exact: true }).first())
			.toBeInTheDocument();
		apiMocks.uploadMedia.mockResolvedValueOnce(mediaItem("uploaded-3", "third.jpg"));
		setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
			new File(["third"], "third.jpg", { type: "image/jpeg" }),
		]);
		await expect.element(screen.getByText("3 of 3", { exact: true })).toBeInTheDocument();
		screen.getByRole("button", { name: "Add 3 images" }).element().click();

		const selected = onSelectMany.mock.calls[0]![0] as MediaItem[];
		expect(selected.map((item) => item.filename)).toEqual(["second.jpg", "first.jpg", "third.jpg"]);
	});

	it("restores file order when an earlier upload succeeds on retry", async () => {
		let firstAttempt = true;
		apiMocks.uploadMedia.mockImplementation((file) => {
			if (file.name === "first.jpg" && firstAttempt) {
				firstAttempt = false;
				return Promise.reject(new Error("network"));
			}
			return Promise.resolve(
				mediaItem(file.name === "first.jpg" ? "uploaded-1" : "uploaded-2", file.name),
			);
		});
		const onSelectMany = vi.fn();
		const screen = await renderPicker({ multiple: true, onSelectMany });
		setInputFiles(screen.getByLabelText("Choose files to upload").element() as HTMLInputElement, [
			new File(["first"], "first.jpg", { type: "image/jpeg" }),
			new File(["second"], "second.jpg", { type: "image/jpeg" }),
		]);

		await expect.element(screen.getByText("Upload failed", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("1 of 1", { exact: true })).toBeInTheDocument();
		screen.getByRole("button", { name: "Retry first.jpg" }).element().click();
		await expect.element(screen.getByText("1 of 2", { exact: true })).toBeInTheDocument();
		await expect.element(screen.getByText("2 of 2", { exact: true })).toBeInTheDocument();
		screen.getByRole("button", { name: "Add 2 images" }).element().click();

		const selected = onSelectMany.mock.calls[0]![0] as MediaItem[];
		expect(selected.map((item) => item.filename)).toEqual(["first.jpg", "second.jpg"]);
	});
});
