import * as React from "react";
import { describe, expect, it, vi } from "vitest";

import { ImageDetailPanel } from "../../src/components/editor/ImageDetailPanel.js";
import type { MediaItem } from "../../src/lib/api/media.js";
import { render } from "../utils/render.js";

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

		await screen.getByRole("button", { name: "Replace Image" }).click();
		await screen.getByRole("button", { name: action }).click();

		expect(onReplace).toHaveBeenCalledWith(expect.objectContaining({ provider: expectedProvider }));
	});
});
