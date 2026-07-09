import { describe, it, expect } from "vitest";

import { createMediaProvider } from "../../../src/media/local-runtime.js";
import { mediaItemToValue } from "../../../src/media/types.js";
import type { MediaProviderItem, MediaValue } from "../../../src/media/types.js";

describe("mediaItemToValue", () => {
	it("copies blurhash and dominantColor onto the MediaValue", () => {
		const item: MediaProviderItem = {
			id: "01ABC",
			filename: "photo.jpg",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
		};

		const value = mediaItemToValue("local", item);

		expect(value).toMatchObject({
			provider: "local",
			id: "01ABC",
			width: 1200,
			height: 800,
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
		});
	});
});

describe("local provider getEmbed", () => {
	// getEmbed never touches the database, so a stub db is enough to construct
	// the provider.
	const provider = createMediaProvider({ db: {} as never });

	it("surfaces top-level blurhash and dominantColor on the image embed", () => {
		const value: MediaValue = {
			provider: "local",
			id: "01ABC",
			mimeType: "image/jpeg",
			width: 1200,
			height: 800,
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
			meta: { storageKey: "01ABC.jpg" },
		};

		const embed = provider.getEmbed(value);

		expect(embed).toMatchObject({
			type: "image",
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
		});
	});

	it("falls back to meta.blurhash for legacy MediaValue snapshots", () => {
		const value: MediaValue = {
			provider: "local",
			id: "01ABC",
			mimeType: "image/jpeg",
			meta: {
				storageKey: "01ABC.jpg",
				blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
				dominantColor: "#aabbcc",
			},
		};

		const embed = provider.getEmbed(value);

		expect(embed).toMatchObject({
			type: "image",
			blurhash: "LEHV6nWB2yk8pyo0adR*.7kCMdnj",
			dominantColor: "#aabbcc",
		});
	});
});
