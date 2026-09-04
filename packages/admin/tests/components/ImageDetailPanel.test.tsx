import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
	ImageDetailPanel,
	type ImagePanelAttributes,
} from "../../src/components/editor/ImageDetailPanel.js";
import { ApiResponseError, fetchMediaItem } from "../../src/lib/api";
import type { LocalMediaItem, MediaItem } from "../../src/lib/api/media.js";
import { render } from "../utils/render.js";

vi.mock("../../src/lib/api", async () => {
	const actual = await vi.importActual("../../src/lib/api");
	return {
		...actual,
		fetchMediaItem: vi.fn().mockResolvedValue({
			id: "old-image",
			filename: "old.jpg",
			mimeType: "image/jpeg",
			url: "/_emdash/api/media/file/old.jpg",
			storageKey: "old.jpg",
			size: 100,
			status: "ready",
			authorId: "editor-1",
			folderId: null,
			createdAt: "2026-08-16T00:00:00.000Z",
		}),
	};
});

vi.mock("../../src/lib/api/current-user.js", () => ({
	useCurrentUser: () => ({ data: { id: "editor-1", role: 40 } }),
}));

vi.mock("../../src/components/MediaDetailPanel.js", () => ({
	MediaDetailPanel: ({
		open,
		item,
		onClose,
		onClosed,
		onCroppedCopyCreated,
	}: {
		open: boolean;
		item: LocalMediaItem;
		onClose: () => void;
		onClosed?: () => void;
		onCroppedCopyCreated?: (item: LocalMediaItem) => void;
	}) =>
		open ? (
			<button
				type="button"
				data-item-url={item.url}
				onClick={() => {
					onCroppedCopyCreated?.({
						id: "cropped-image",
						filename: "cropped.jpg",
						mimeType: "image/jpeg",
						url: "/_emdash/api/media/file/cropped.jpg",
						storageKey: "cropped.jpg",
						size: 100,
						width: 640,
						height: 480,
						blurhash: "new-hash",
						dominantColor: "#123456",
						status: "ready",
						authorId: "editor-1",
						folderId: null,
						createdAt: "2026-08-17T00:00:00.000Z",
					});
					onClose();
					onClosed?.();
				}}
			>
				Use cropped asset
			</button>
		) : null,
}));

const replacements: Record<string, MediaItem> = {
	"Choose local image": {
		id: "local-image",
		filename: "local.jpg",
		mimeType: "image/jpeg",
		url: "/_emdash/api/media/file/local.jpg",
		storageKey: "local.jpg",
		size: 100,
		createdAt: "2026-08-16T00:00:00.000Z",
	},
	"Choose provider image": {
		id: "provider-image",
		filename: "provider.jpg",
		mimeType: "image/jpeg",
		url: "https://media.example/provider.jpg",
		provider: "cloudflare-images",
		size: 100,
		createdAt: "2026-08-16T00:00:00.000Z",
	},
};

vi.mock("../../src/components/MediaPickerModal.js", () => ({
	MediaPickerModal: ({ open, onSelect }: { open: boolean; onSelect: (item: MediaItem) => void }) =>
		open ? (
			<>
				{Object.entries(replacements).map(([label, item]) => (
					<button key={label} type="button" onClick={() => onSelect(item)}>
						{label}
					</button>
				))}
			</>
		) : null,
}));

describe("ImageDetailPanel replacement", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		vi.mocked(fetchMediaItem).mockResolvedValue({
			id: "old-image",
			filename: "old.jpg",
			mimeType: "image/jpeg",
			url: "/_emdash/api/media/file/old.jpg",
			storageKey: "old.jpg",
			size: 100,
			status: "ready",
			authorId: "editor-1",
			folderId: null,
			createdAt: "2026-08-16T00:00:00.000Z",
		});
	});

	it.each([
		{ action: "Choose local image", expectedProvider: "local" },
		{ action: "Choose provider image", expectedProvider: "cloudflare-images" },
	])("uses the replacement provider for $action", async ({ action, expectedProvider }) => {
		const onReplace = vi.fn();
		const screen = await render(
			<ImageDetailPanel
				attributes={{
					src: "https://media.example/old.jpg",
					provider: "old-provider",
					mediaId: "old-image",
				}}
				onUpdate={vi.fn()}
				onReplace={onReplace}
				onDelete={vi.fn()}
				onClose={vi.fn()}
				inline
			/>,
		);

		await screen.getByRole("button", { name: "Replace" }).click();
		await screen.getByRole("button", { name: action }).click();

		expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ provider: expectedProvider }));
	});

	it("preserves per-use image settings when a cropped copy replaces the asset", async () => {
		const onUpdate = vi.fn();
		const screen = await render(
			<ImageDetailPanel
				attributes={{
					src: "/_emdash/api/media/file/old.jpg",
					provider: "local",
					mediaId: "old-image",
					alt: "Usage alt",
					caption: "Usage caption",
					title: "Usage title",
					displayWidth: 320,
					displayHeight: 240,
					alignment: "wide",
				}}
				onUpdate={onUpdate}
				onReplace={vi.fn()}
				onDelete={vi.fn()}
				onClose={vi.fn()}
				inline
			/>,
		);

		await expect.element(screen.getByRole("button", { name: "Replace" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Edit asset" })).toBeVisible();
		await expect.element(screen.getByRole("button", { name: "Remove" })).toBeVisible();
		expect(fetchMediaItem).not.toHaveBeenCalled();
		await screen.getByRole("button", { name: "Edit asset" }).click();
		await vi.waitFor(() =>
			expect(fetchMediaItem).toHaveBeenCalledWith("old-image", {
				signal: expect.any(AbortSignal),
			}),
		);
		await screen.getByRole("button", { name: "Use cropped asset" }).click();

		expect(onUpdate).toHaveBeenCalledWith({
			src: "/_emdash/api/media/file/cropped.jpg",
			mediaId: "cropped-image",
			provider: "local",
			width: 640,
			height: 480,
			blurhash: "new-hash",
			dominantColor: "#123456",
		});
	});

	it("keeps the usage unchanged when the current asset no longer exists", async () => {
		vi.mocked(fetchMediaItem).mockRejectedValueOnce(
			new ApiResponseError(404, "NOT_FOUND", "Missing"),
		);
		const onUpdate = vi.fn();
		const screen = await render(
			<ImageDetailPanel
				attributes={{
					src: "/_emdash/api/media/file/old.jpg",
					provider: "local",
					mediaId: "old-image",
					alt: "Usage alt",
				}}
				onUpdate={onUpdate}
				onReplace={vi.fn()}
				onDelete={vi.fn()}
				onClose={vi.fn()}
				inline
			/>,
		);

		await screen.getByRole("button", { name: "Edit asset" }).click();

		await expect
			.element(screen.getByRole("alert"))
			.toHaveTextContent("This media item no longer exists.");
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it("builds a local preview URL when the item response omits one", async () => {
		vi.mocked(fetchMediaItem).mockResolvedValueOnce({
			id: "old-image",
			filename: "old.jpg",
			mimeType: "image/jpeg",
			storageKey: "folder/old image.jpg",
			size: 100,
			status: "ready",
			authorId: "editor-1",
			folderId: null,
			createdAt: "2026-08-16T00:00:00.000Z",
		} as LocalMediaItem);
		const screen = await render(
			<ImageDetailPanel
				attributes={{
					src: "/_emdash/api/media/file/old.jpg",
					provider: "local",
					mediaId: "old-image",
				}}
				onUpdate={vi.fn()}
				onReplace={vi.fn()}
				onDelete={vi.fn()}
				onClose={vi.fn()}
				inline
			/>,
		);

		await screen.getByRole("button", { name: "Edit asset" }).click();

		await expect
			.element(screen.getByRole("button", { name: "Use cropped asset" }))
			.toHaveAttribute("data-item-url", "/_emdash/api/media/file/folder%2Fold%20image.jpg");
	});

	it("does not close or save the usage behind an open asset dialog", async () => {
		const onUpdate = vi.fn();
		const onClose = vi.fn();
		const screen = await render(
			<ImageDetailPanel
				attributes={{
					src: "/_emdash/api/media/file/old.jpg",
					provider: "local",
					mediaId: "old-image",
					alt: "Usage alt",
				}}
				onUpdate={onUpdate}
				onReplace={vi.fn()}
				onDelete={vi.fn()}
				onClose={onClose}
				inline
			/>,
		);

		await screen.getByRole("button", { name: "Edit asset" }).click();
		await expect.element(screen.getByRole("button", { name: "Use cropped asset" })).toBeVisible();
		window.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape" }));
		const saveEvent = new KeyboardEvent("keydown", { key: "s", ctrlKey: true, cancelable: true });
		window.dispatchEvent(saveEvent);

		expect(onClose).not.toHaveBeenCalled();
		expect(onUpdate).not.toHaveBeenCalled();
		expect(saveEvent.defaultPrevented).toBe(true);
	});

	it("blocks a second media action while the current asset is loading", async () => {
		let resolveItem!: (item: LocalMediaItem) => void;
		vi.mocked(fetchMediaItem).mockImplementationOnce(
			() => new Promise<LocalMediaItem>((resolve) => (resolveItem = resolve)),
		);
		const screen = await render(
			<ImageDetailPanel
				attributes={{
					src: "/_emdash/api/media/file/old.jpg",
					provider: "local",
					mediaId: "old-image",
				}}
				onUpdate={vi.fn()}
				onReplace={vi.fn()}
				onDelete={vi.fn()}
				onClose={vi.fn()}
				inline
			/>,
		);

		await screen.getByRole("button", { name: "Edit asset" }).click();

		await expect.element(screen.getByRole("button", { name: "Replace" })).toBeDisabled();
		await expect.element(screen.getByRole("button", { name: "Remove" })).toBeDisabled();
		resolveItem({
			id: "old-image",
			filename: "old.jpg",
			mimeType: "image/jpeg",
			url: "/_emdash/api/media/file/old.jpg",
			storageKey: "old.jpg",
			size: 100,
			status: "ready",
			authorId: "editor-1",
			folderId: null,
			createdAt: "2026-08-16T00:00:00.000Z",
		});
	});

	it("keeps implicit display dimensions aligned with the cropped asset", async () => {
		const screen = await render(
			<ImageDetailPanel
				attributes={{
					src: "/_emdash/api/media/file/old.jpg",
					provider: "local",
					mediaId: "old-image",
					width: 1200,
					height: 800,
				}}
				onUpdate={vi.fn()}
				onReplace={vi.fn()}
				onDelete={vi.fn()}
				onClose={vi.fn()}
				inline
			/>,
		);

		await screen.getByRole("button", { name: "Edit asset" }).click();
		await screen.getByRole("button", { name: "Use cropped asset" }).click();

		await expect.element(screen.getByLabelText("Width")).toHaveValue(640);
		await expect.element(screen.getByLabelText("Height")).toHaveValue(480);
		await expect.element(screen.getByRole("button", { name: "Save" })).toBeDisabled();

		await screen.getByRole("button", { name: "Edit asset" }).click();
		await vi.waitFor(() =>
			expect(fetchMediaItem).toHaveBeenLastCalledWith("cropped-image", {
				signal: expect.any(AbortSignal),
			}),
		);
	});

	it("resyncs the complete form when the sidebar switches image nodes", async () => {
		const firstNode = {};
		const secondNode = {};
		const thirdNode = {};
		const onSecondUpdate = vi.fn();
		const onThirdUpdate = vi.fn();
		const panel = (attributes: ImagePanelAttributes, onUpdate = vi.fn()) => (
			<ImageDetailPanel
				attributes={attributes}
				onUpdate={onUpdate}
				onReplace={vi.fn()}
				onDelete={vi.fn()}
				onClose={vi.fn()}
				inline
			/>
		);
		const screen = await render(
			panel({
				nodeKey: firstNode,
				src: "/_emdash/api/media/file/first.jpg",
				mediaId: "first-image",
				provider: "local",
				width: 1200,
				height: 800,
				alt: "First alt",
				caption: "First caption",
				title: "First title",
				displayWidth: 600,
				displayHeight: 400,
				alignment: "wide",
			}),
		);

		await screen.rerender(
			panel(
				{
					nodeKey: secondNode,
					src: "/_emdash/api/media/file/second.jpg",
					mediaId: "second-image",
					provider: "local",
					width: 900,
					height: 600,
					alt: "Second alt",
					caption: "Second caption",
					title: "Second title",
					displayWidth: 450,
					displayHeight: 300,
					alignment: "center",
				},
				onSecondUpdate,
			),
		);

		await expect
			.element(screen.getByRole("img", { name: "Second alt" }))
			.toHaveAttribute("src", "/_emdash/api/media/file/second.jpg");
		await expect.element(screen.getByLabelText("Alt Text")).toHaveValue("Second alt");
		await expect.element(screen.getByLabelText("Caption")).toHaveValue("Second caption");
		await expect.element(screen.getByLabelText("Title (Tooltip)")).toHaveValue("Second title");
		await expect.element(screen.getByLabelText("Width")).toHaveValue(450);
		await expect.element(screen.getByLabelText("Height")).toHaveValue(300);

		await screen.rerender(
			panel(
				{
					nodeKey: thirdNode,
					src: "/_emdash/api/media/file/second.jpg",
					mediaId: "second-image",
					provider: "local",
					width: 900,
					height: 600,
					alt: "Third alt",
					caption: "Third caption",
					title: "Third title",
					displayWidth: 300,
					displayHeight: 200,
					alignment: "full",
				},
				onThirdUpdate,
			),
		);

		await expect.element(screen.getByLabelText("Alt Text")).toHaveValue("Third alt");
		await screen.getByLabelText("Alt Text").fill("Updated third alt");
		await screen.getByRole("button", { name: "Save" }).click();

		expect(onSecondUpdate).not.toHaveBeenCalled();
		expect(onThirdUpdate).toHaveBeenCalledWith({
			alt: "Updated third alt",
			caption: "Third caption",
			title: "Third title",
			displayWidth: 300,
			displayHeight: 200,
			alignment: "full",
		});
	});
});
