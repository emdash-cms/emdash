import { expect, it, vi } from "vitest";

import { normalizeMediaValue } from "../../../src/media/normalize.js";
import type { MediaProvider, MediaProviderItem } from "../../../src/media/types.js";

function provider(item: MediaProviderItem | null): MediaProvider {
	return {
		list: vi.fn().mockResolvedValue({ items: [] }),
		get: vi.fn().mockResolvedValue(item),
		getEmbed: vi.fn().mockReturnValue({ type: "image", src: "/test" }),
	};
}

it("copies the focal point when resolving a bare local media ID", async () => {
	const local = provider({
		id: "01ABC",
		filename: "photo.jpg",
		mimeType: "image/jpeg",
		width: 1200,
		height: 800,
		focalX: 0.25,
		focalY: 0.75,
		meta: { storageKey: "01ABC.jpg" },
	});

	const result = await normalizeMediaValue("01ABC", (id) => (id === "local" ? local : undefined));

	expect(result).toMatchObject({ focalX: 0.25, focalY: 0.75 });
});

it("preserves a focal point in a complete content snapshot without a provider lookup", async () => {
	const local = provider(null);
	const result = await normalizeMediaValue(
		{
			provider: "local",
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			focalX: 0.2,
			focalY: 0.8,
			blurhash: "snapshot-hash",
			dominantColor: "#112233",
			meta: { storageKey: "01ABC.jpg" },
		},
		(id) => (id === "local" ? local : undefined),
	);

	expect(local.get).not.toHaveBeenCalled();
	expect(result).toMatchObject({ focalX: 0.2, focalY: 0.8 });
});
