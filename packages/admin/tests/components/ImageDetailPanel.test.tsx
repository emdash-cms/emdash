import * as React from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";

import {
	ImageDetailPanel,
	type ImageAttributes,
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
	MediaPickerModal: ({
		open,
		onOpenChange,
		onSelect,
	}: {
		open: boolean;
		onOpenChange: (open: boolean) => void;
		onSelect: (item: MediaItem) => void;
	}) =>
		open ? (
			<div role="dialog" aria-label="Replace image">
				{Object.entries(replacements).map(([label, item]) => (
					<button key={label} type="button" onClick={() => onSelect(item)}>
						{label}
					</button>
				))}
				<button type="button" onClick={() => onOpenChange(false)}>
					Close image picker
				</button>
			</div>
		) : null,
}));

const baseAttributes: ImageAttributes = {
	src: "https://media.example/image.jpg",
	alt: "Current description",
	width: 1200,
	height: 800,
};

async function renderPanel(attributes: ImagePanelAttributes = baseAttributes, inline = true) {
	const onUpdate = vi.fn();
	const onReplace = vi.fn();
	const onDelete = vi.fn();
	const onClose = vi.fn();
	const screen = await render(
		<ImageDetailPanel
			attributes={attributes}
			onUpdate={onUpdate}
			onReplace={onReplace}
			onDelete={onDelete}
			onClose={onClose}
			inline={inline}
		/>,
	);

	return { screen, onUpdate, onReplace, onDelete, onClose };
}

describe("ImageDetailPanel", () => {
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

	it("reveals field help by pointer and keyboard focus", async () => {
		const { screen } = await renderPanel();
		const altHelp = screen.getByText(
			"Describe the image's purpose and relevant details for people who cannot see it.",
		);
		const altTrigger = screen.getByRole("button", { name: "More information about Alt text" });

		await userEvent.hover(altTrigger.element());
		await expect.element(altHelp).toBeVisible();
		await userEvent.hover(document.body);
		await vi.waitFor(() => expect(altHelp.query()).toBeNull());

		const sizeHelp = screen.getByText(
			"Set a custom width and height for this image in the document. Reset uses the original media dimensions. The original media file is unchanged.",
		);
		screen.getByRole("button", { name: "More information about Display size" }).element().focus();
		await expect.element(sizeHelp).toBeVisible();
	});

	it("applies the selected alignment", async () => {
		const { screen, onUpdate } = await renderPanel();

		await screen.getByRole("combobox", { name: "Alignment" }).click();
		await screen.getByRole("option", { name: "Left" }).click();
		await screen.getByRole("button", { name: "Apply" }).click();

		expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ alignment: "left" }));
	});

	it.each(["wide", "full"] as const)(
		"preserves imported %s without showing unsupported authoring choices",
		async (alignment) => {
			const { screen, onUpdate } = await renderPanel({ ...baseAttributes, alignment });
			const select = screen.getByRole("combobox", { name: "Alignment" });
			await expect.element(select).toHaveTextContent(alignment === "wide" ? "Wide" : "Full");
			await screen.getByRole("textbox", { name: "Alt text" }).fill("Updated description");
			await screen.getByRole("button", { name: "Apply" }).click();
			expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ alignment }));
			await select.click();
			await expect.element(screen.getByRole("option", { name: "None" })).toBeVisible();
			expect(screen.getByRole("option", { name: "Wide" }).query()).toBeNull();
			expect(screen.getByRole("option", { name: "Full" }).query()).toBeNull();
			await screen.getByRole("option", { name: "Right" }).click();
			await expect.element(select).toHaveTextContent("Right");
			await screen.getByRole("button", { name: "Apply" }).click();
			expect(onUpdate).toHaveBeenLastCalledWith(expect.objectContaining({ alignment: "right" }));
		},
	);

	it("omits unsupported alignment buttons from the fixed panel", async () => {
		const { screen } = await renderPanel({ ...baseAttributes, mediaId: "image-1" }, false);
		await expect.element(screen.getByRole("button", { name: "Right", exact: true })).toBeVisible();
		expect(screen.getByRole("button", { name: "Wide", exact: true }).query()).toBeNull();
		expect(screen.getByRole("button", { name: "Full", exact: true }).query()).toBeNull();
	});

	it.each([undefined, null])(
		"preserves %s display overrides on alignment-only Apply",
		async (absent) => {
			const { screen, onUpdate } = await renderPanel({
				...baseAttributes,
				displayWidth: absent,
				displayHeight: absent,
			} as ImageAttributes);
			await screen.getByRole("combobox", { name: "Alignment" }).click();
			await screen.getByRole("option", { name: "Left" }).click();
			await screen.getByRole("button", { name: "Apply" }).click();
			expect(onUpdate).toHaveBeenCalledWith(
				expect.objectContaining({
					alignment: "left",
					displayWidth: undefined,
					displayHeight: undefined,
				}),
			);
		},
	);

	it.each([
		{ displayWidth: undefined, displayHeight: undefined },
		{ displayWidth: 600, displayHeight: undefined },
		{ displayWidth: undefined, displayHeight: 300 },
	])(
		"preserves existing overrides $displayWidth × $displayHeight on text-only Apply",
		async (size) => {
			const { screen, onUpdate } = await renderPanel({ ...baseAttributes, ...size });
			await screen.getByRole("textbox", { name: "Alt text" }).fill("New description");
			await screen.getByRole("button", { name: "Apply" }).click();
			expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining(size));
		},
	);

	it("clears custom overrides with Reset, even when they match the original size", async () => {
		const { screen, onUpdate } = await renderPanel({
			...baseAttributes,
			displayWidth: 1200,
			displayHeight: 800,
		});
		await screen.getByRole("button", { name: "Reset", exact: true }).click();
		await expect.element(screen.getByRole("button", { name: "Apply" })).toBeEnabled();
		await screen.getByRole("button", { name: "Apply" }).click();
		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				displayWidth: undefined,
				displayHeight: undefined,
			}),
		);
	});

	it("saves edited dimensions and allows either dimension to be cleared", async () => {
		const { screen, onUpdate } = await renderPanel();
		await screen.getByLabelText("Width").fill("600");
		await expect.element(screen.getByLabelText("Height")).toHaveValue(400);
		await screen.getByLabelText("Height").fill("");
		await screen.getByRole("button", { name: "Apply" }).click();
		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({
				displayWidth: 600,
				displayHeight: undefined,
			}),
		);
	});

	it("retains the other original dimension when the first resize is unlocked", async () => {
		const { screen, onUpdate } = await renderPanel();
		await screen.getByRole("button", { name: "Keep aspect ratio" }).click();
		await screen.getByLabelText("Width").fill("600");
		await screen.getByRole("button", { name: "Apply" }).click();
		expect(onUpdate).toHaveBeenCalledWith(
			expect.objectContaining({ displayWidth: 600, displayHeight: 800 }),
		);
	});

	it("maps the None alignment option back to an omitted attribute", async () => {
		const { screen, onUpdate } = await renderPanel({ ...baseAttributes, alignment: "center" });

		await screen.getByRole("combobox", { name: "Alignment" }).click();
		await screen.getByRole("option", { name: "None" }).click();
		await screen.getByRole("button", { name: "Apply" }).click();

		expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ alignment: undefined }));
	});

	it.each(["text", "dimension", "alignment"])(
		"enables Apply after a meaningful %s change",
		async (change) => {
			const { screen } = await renderPanel();
			const apply = screen.getByRole("button", { name: "Apply" });
			await expect.element(apply).toBeDisabled();

			if (change === "text") await screen.getByRole("textbox", { name: "Alt text" }).fill("New");
			if (change === "dimension")
				await screen.getByRole("spinbutton", { name: "Width" }).fill("600");
			if (change === "alignment") {
				await screen.getByRole("combobox", { name: "Alignment" }).click();
				await screen.getByRole("option", { name: "Right" }).click();
			}

			await expect.element(apply).toBeEnabled();
		},
	);

	it.each(["Cancel", "Close image settings"])(
		"closes with %s without applying staged fields",
		async (action) => {
			const { screen, onUpdate, onClose } = await renderPanel();
			await screen.getByRole("textbox", { name: "Alt text" }).fill("Staged only");
			await screen.getByRole("button", { name: action }).click();

			expect(onClose).toHaveBeenCalledOnce();
			expect(onUpdate).not.toHaveBeenCalled();
		},
	);

	it("groups display-size controls and preserves aspect-ratio behavior", async () => {
		const { screen } = await renderPanel();
		const group = screen.getByRole("group", { name: "Display size" });
		const width = group.getByRole("spinbutton", { name: "Width" });
		const height = group.getByRole("spinbutton", { name: "Height" });
		const aspectRatio = group.getByRole("button", { name: "Keep aspect ratio" });

		await expect.element(aspectRatio).toHaveAttribute("aria-pressed", "true");
		await width.fill("600");
		await expect.element(height).toHaveValue(400);
		await aspectRatio.click();
		await expect.element(aspectRatio).toHaveAttribute("aria-pressed", "false");
		await width.fill("300");
		await expect.element(height).toHaveValue(400);
	});

	it("requires confirmation before removing the image", async () => {
		const { screen, onDelete } = await renderPanel();

		await screen.getByRole("button", { name: "Remove image" }).click();
		expect(onDelete).not.toHaveBeenCalled();
		screen.getByRole("button", { name: "Remove", exact: true }).element().click();
		expect(onDelete).toHaveBeenCalledOnce();
	});

	it("applies changed fields with the platform save shortcut", async () => {
		const { screen, onUpdate, onClose } = await renderPanel();
		await screen.getByRole("textbox", { name: "Alt text" }).fill("Shortcut change");
		const mod = navigator.platform.includes("Mac") ? "{Meta>}" : "{Control>}";
		const modUp = navigator.platform.includes("Mac") ? "{/Meta}" : "{/Control}";

		await userEvent.keyboard(`${mod}s${modUp}`);

		expect(onUpdate).toHaveBeenCalledWith(expect.objectContaining({ alt: "Shortcut change" }));
		expect(onClose).toHaveBeenCalledOnce();
	});

	it("keeps an unchanged panel open when the save shortcut is pressed", async () => {
		const { onUpdate, onClose } = await renderPanel();
		const event = new KeyboardEvent("keydown", {
			key: "s",
			metaKey: true,
			bubbles: true,
			cancelable: true,
		});

		window.dispatchEvent(event);

		expect(event.defaultPrevented).toBe(true);
		expect(onUpdate).not.toHaveBeenCalled();
		expect(onClose).not.toHaveBeenCalled();
	});

	it("cancels staged fields with Escape", async () => {
		const { screen, onUpdate, onClose } = await renderPanel();
		await screen.getByRole("textbox", { name: "Alt text" }).fill("Staged only");

		await userEvent.keyboard("{Escape}");

		expect(onClose).toHaveBeenCalledOnce();
		expect(onUpdate).not.toHaveBeenCalled();
	});

	it.each(["picker", "confirmation"])(
		"leaves the parent panel open while the %s overlay handles Escape",
		async (overlay) => {
			const { screen, onUpdate, onClose } = await renderPanel();
			await screen
				.getByRole("button", { name: overlay === "picker" ? "Replace" : "Remove image" })
				.click();

			await userEvent.keyboard("{Escape}");

			expect(onClose).not.toHaveBeenCalled();
			expect(onUpdate).not.toHaveBeenCalled();
		},
	);

	it.each([
		{ action: "Choose local image", expectedProvider: "local" },
		{ action: "Choose provider image", expectedProvider: "cloudflare-images" },
	])("uses the replacement provider for $action", async ({ action, expectedProvider }) => {
		const { screen, onReplace } = await renderPanel({
			src: "https://media.example/old.jpg",
			provider: "old-provider",
			mediaId: "old-image",
		});

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
		await expect.element(screen.getByRole("button", { name: "Remove image" })).toBeVisible();
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
		await expect.element(screen.getByRole("button", { name: "Remove image" })).toBeDisabled();
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

	it.each([undefined, null])(
		"keeps %s implicit display dimensions aligned with the cropped asset",
		async (absent) => {
			const screen = await render(
				<ImageDetailPanel
					attributes={{
						src: "/_emdash/api/media/file/old.jpg",
						provider: "local",
						mediaId: "old-image",
						width: 1200,
						height: 800,
						displayWidth: absent as number | undefined,
						displayHeight: absent as number | undefined,
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
			await expect.element(screen.getByRole("button", { name: "Apply" })).toBeDisabled();

			await screen.getByRole("button", { name: "Edit asset" }).click();
			await vi.waitFor(() =>
				expect(fetchMediaItem).toHaveBeenLastCalledWith("cropped-image", {
					signal: expect.any(AbortSignal),
				}),
			);
		},
	);

	it.each(["custom", "reset"])(
		"retains the %s sizing choice after editing the asset",
		async (choice) => {
			const { screen, onUpdate } = await renderPanel({
				...baseAttributes,
				provider: "local",
				mediaId: "old-image",
				displayWidth: 600,
				displayHeight: 400,
			});
			if (choice === "reset")
				await screen.getByRole("button", { name: "Reset", exact: true }).click();
			await screen.getByRole("button", { name: "Edit asset" }).click();
			await screen.getByRole("button", { name: "Use cropped asset" }).click();
			await expect
				.element(screen.getByLabelText("Width"))
				.toHaveValue(choice === "reset" ? 640 : 600);
			await expect
				.element(screen.getByLabelText("Height"))
				.toHaveValue(choice === "reset" ? 480 : 400);
			await screen.getByRole("textbox", { name: "Alt text" }).fill("Edited asset");
			await screen.getByRole("button", { name: "Apply" }).click();
			expect(onUpdate).toHaveBeenLastCalledWith(
				expect.objectContaining({
					displayWidth: choice === "reset" ? undefined : 600,
					displayHeight: choice === "reset" ? undefined : 400,
				}),
			);
		},
	);

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
		await expect
			.element(screen.getByRole("textbox", { name: "Alt text", exact: true }))
			.toHaveValue("Second alt");
		await expect.element(screen.getByLabelText("Caption")).toHaveValue("Second caption");
		await expect.element(screen.getByLabelText("Tooltip text")).toHaveValue("Second title");
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
					alignment: "full",
				},
				onThirdUpdate,
			),
		);

		await expect
			.element(screen.getByRole("textbox", { name: "Alt text", exact: true }))
			.toHaveValue("Third alt");
		await screen.getByRole("textbox", { name: "Alt text", exact: true }).fill("Updated third alt");
		await screen.getByRole("button", { name: "Apply" }).click();

		expect(onSecondUpdate).not.toHaveBeenCalled();
		expect(onThirdUpdate).toHaveBeenCalledWith({
			alt: "Updated third alt",
			caption: "Third caption",
			title: "Third title",
			displayWidth: undefined,
			displayHeight: undefined,
			alignment: "full",
		});
	});
});
