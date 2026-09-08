import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import "../../dist/styles.css";
import {
	ImageFieldRenderer,
	type ImageFieldValue,
} from "../../src/components/ImageFieldRenderer.js";
import { SeoImageField } from "../../src/components/SeoImageField.js";
import { fetchMediaItem, uploadMedia, type LocalMediaItem } from "../../src/lib/api/media.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api/media.js", async (importOriginal) => ({
	...(await importOriginal<typeof import("../../src/lib/api/media.js")>()),
	fetchMediaItem: vi.fn(),
	uploadMedia: vi.fn(),
}));

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "editor-1", role: 40 } }),
}));

vi.mock("../../src/components/MediaPickerModal", () => ({
	MediaPickerModal: ({ open }: { open: boolean }) =>
		open ? (
			<div role="dialog" aria-label="Media picker">
				Choose an image
			</div>
		) : null,
}));

vi.mock("../../src/components/MediaDetailPanel.js", () => ({
	MediaDetailPanel: () => null,
}));

const uploaded: LocalMediaItem = {
	id: "uploaded-image",
	filename: "upload.png",
	mimeType: "image/png",
	url: "/_emdash/api/media/file/upload.png",
	storageKey: "upload.png",
	size: 1024,
	width: 640,
	height: 480,
	alt: "Uploaded image",
	createdAt: "2026-09-09T00:00:00Z",
	authorId: "editor-1",
	folderId: null,
};

type TargetKind = "featured" | "og";

function Target({
	kind,
	allowedMimeTypes,
	onSaved,
}: {
	kind: TargetKind;
	allowedMimeTypes?: string[];
	onSaved?: (value: unknown) => void;
}) {
	const [value, setValue] = React.useState<ImageFieldValue | null>(null);
	const [seoImage, setSeoImage] = React.useState<string | null>(null);
	return (
		<>
			{kind === "featured" ? (
				<ImageFieldRenderer
					label="Featured image"
					variant="featured"
					value={value ?? undefined}
					allowedMimeTypes={allowedMimeTypes}
					fieldId="featured-field"
					onChange={(next) => {
						setValue(next);
						onSaved?.(next);
					}}
				/>
			) : (
				<SeoImageField
					seo={{ image: seoImage, title: null, description: null, canonical: null, noIndex: false }}
					onChange={(next) => {
						setSeoImage(next.image ?? null);
						onSaved?.(next);
					}}
				/>
			)}
			<pre data-testid="stored-value">{JSON.stringify(kind === "featured" ? value : seoImage)}</pre>
		</>
	);
}

function dropFiles(element: Element, files: File[]) {
	const dataTransfer = new DataTransfer();
	for (const file of files) dataTransfer.items.add(file);
	for (const type of ["dragenter", "dragover", "drop"]) {
		element.dispatchEvent(new DragEvent(type, { dataTransfer, bubbles: true, cancelable: true }));
	}
}

function imageFile() {
	return new File(["image bytes"], "upload.png", { type: "image/png" });
}

beforeEach(() => {
	vi.clearAllMocks();
	vi.mocked(fetchMediaItem).mockResolvedValue(uploaded);
	vi.mocked(uploadMedia).mockResolvedValue(uploaded);
});

describe("Editor image drop targets", () => {
	it.each(["featured", "og"] as const)(
		"renders a dashed %s target and keeps keyboard selection",
		async (kind) => {
			const screen = await render(<Target kind={kind} />);
			const button = screen.getByRole("button", {
				name:
					kind === "featured"
						? "Drop an image here or browse for Featured image"
						: "Drop an image here or browse for OG Image",
				exact: true,
			});
			expect(getComputedStyle(button.element().parentElement!).borderTopStyle).toBe("dashed");
			const buttonBounds = button.element().getBoundingClientRect();
			const iconBounds = button.element().querySelector("svg")!.getBoundingClientRect();
			const hint = screen.getByText("Drop an image here or browse", { exact: true }).element();
			expect(iconBounds.top - buttonBounds.top).toBeCloseTo(
				buttonBounds.bottom - hint.getBoundingClientRect().bottom,
				0,
			);
			button.element().focus();
			await userEvent.keyboard("{Enter}");
			await expect.element(screen.getByRole("dialog", { name: "Media picker" })).toBeVisible();
		},
	);

	it.each(["featured", "og"] as const)(
		"uploads one file into %s and ignores another drop while busy",
		async (kind) => {
			let complete!: (item: LocalMediaItem) => void;
			vi.mocked(uploadMedia).mockImplementation(
				() =>
					new Promise((resolve) => {
						complete = resolve;
					}),
			);
			const screen = await render(<Target kind={kind} />);
			const button = screen.getByRole("button", {
				name:
					kind === "featured"
						? "Drop an image here or browse for Featured image"
						: "Drop an image here or browse for OG Image",
				exact: true,
			});
			dropFiles(button.element(), [imageFile()]);
			await expect.element(button).toBeDisabled();
			dropFiles(button.element(), [imageFile()]);
			expect(uploadMedia).toHaveBeenCalledTimes(1);
			if (kind === "featured")
				expect(vi.mocked(uploadMedia).mock.calls[0]?.[1]?.fieldId).toBe("featured-field");

			await React.act(async () => {
				complete(uploaded);
			});
			await vi.waitFor(() => {
				const stored = JSON.parse(screen.getByTestId("stored-value").element().textContent!);
				if (kind === "featured") {
					expect(stored).toMatchObject({
						id: uploaded.id,
						provider: "local",
						width: 640,
						height: 480,
						meta: { storageKey: "upload.png" },
					});
				} else {
					expect(stored).toBe(uploaded.url);
				}
			});
			if (kind === "featured")
				await expect.element(screen.getByText("upload.png", { exact: true })).toBeVisible();
			else await expect.element(screen.getByRole("button", { name: "Remove image" })).toBeVisible();
		},
	);

	it.each([
		{
			files: [new File(["text"], "note.txt", { type: "text/plain" })],
			allowed: undefined,
			message: "Only image files can be dropped here.",
		},
		{ files: [imageFile(), imageFile()], allowed: undefined, message: "Drop one image at a time." },
		{
			files: [imageFile()],
			allowed: ["image/jpeg"],
			message: "This field does not accept image/png files.",
		},
	])("rejects incompatible drops: $message", async ({ files, allowed, message }) => {
		const screen = await render(<Target kind="featured" allowedMimeTypes={allowed} />);
		dropFiles(
			screen
				.getByRole("button", {
					name: "Drop an image here or browse for Featured image",
					exact: true,
				})
				.element(),
			files,
		);
		await expect.element(screen.getByRole("alert")).toHaveTextContent(message);
		expect(uploadMedia).not.toHaveBeenCalled();
		expect(screen.getByTestId("stored-value").element().textContent).toBe("null");
	});

	it("keeps the empty target usable after an upload fails", async () => {
		vi.mocked(uploadMedia).mockRejectedValueOnce(new Error("Storage is unavailable"));
		const screen = await render(<Target kind="og" />);
		const button = screen.getByRole("button", {
			name: "Drop an image here or browse for OG Image",
			exact: true,
		});
		dropFiles(button.element(), [imageFile()]);
		await expect.element(screen.getByRole("alert")).toHaveTextContent("Storage is unavailable");
		await expect.element(button).toBeEnabled();
		dropFiles(button.element(), [imageFile()]);
		await vi.waitFor(() =>
			expect(screen.getByTestId("stored-value").element().textContent).toBe(
				JSON.stringify(uploaded.url),
			),
		);
	});

	it("aborts an unmounted target and ignores its late completion", async () => {
		let complete!: (item: LocalMediaItem) => void;
		vi.mocked(uploadMedia).mockImplementation(
			() =>
				new Promise((resolve) => {
					complete = resolve;
				}),
		);
		const onSaved = vi.fn();
		const screen = await render(<Target kind="og" onSaved={onSaved} />);
		dropFiles(
			screen
				.getByRole("button", { name: "Drop an image here or browse for OG Image", exact: true })
				.element(),
			[imageFile()],
		);
		await vi.waitFor(() => expect(uploadMedia).toHaveBeenCalledOnce());
		const signal = vi.mocked(uploadMedia).mock.calls[0]?.[1]?.signal;
		await screen.unmount();
		expect(signal?.aborted).toBe(true);
		await React.act(async () => {
			complete(uploaded);
		});
		expect(onSaved).not.toHaveBeenCalled();
	});
});
