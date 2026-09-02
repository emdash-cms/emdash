import { describe, expect, it, vi } from "vitest";

// `stream-runtime` imports `env` from cloudflare:workers at module scope. This
// suite supplies credentials through config, so an empty env is sufficient.
vi.mock("cloudflare:workers", () => ({ env: {} }));

import type { MediaValue } from "emdash/media";

import { createMediaProvider } from "../../src/media/stream-runtime.js";

const ACCOUNT_ID = "abc12345def67890";
const HLS = "https://customer-abc12345.cloudflarestream.com/UID/manifest/video.m3u8";
const DASH = "https://customer-abc12345.cloudflarestream.com/UID/manifest/video.mpd";
const PREVIEW_URL = "https://customer-abc12345.cloudflarestream.com/UID/thumbnails/thumbnail.jpg";

const provider = createMediaProvider({ accountId: ACCOUNT_ID, apiToken: "test-token" });

/** Resolve an embed and narrow it to the video variant, which is the only one Stream returns. */
async function videoEmbed(value: MediaValue) {
	const getEmbed = provider.getEmbed;
	if (!getEmbed) throw new Error("Stream provider does not implement getEmbed");
	const result = await getEmbed(value);
	if (result.type !== "video") throw new Error(`expected a video embed, got "${result.type}"`);
	return result;
}

/**
 * A value shaped the way the media picker stores it: playback URLs under
 * `meta.playback`, poster in `previewUrl`, and no `meta.thumbnail`.
 */
function streamValue(overrides: Partial<MediaValue> = {}): MediaValue {
	return {
		id: "UID",
		provider: "cloudflare-stream",
		previewUrl: PREVIEW_URL,
		mimeType: "video/mp4",
		width: 1280,
		height: 720,
		meta: { playback: { hls: HLS, dash: DASH } },
		...overrides,
	};
}

describe("cloudflare stream getEmbed", () => {
	it("takes the poster from previewUrl, where list()/get() actually report it", async () => {
		// Regression: reading only `meta.thumbnail` dropped the poster for every
		// value the media picker produces, because neither list() nor get() set it.
		expect((await videoEmbed(streamValue())).poster).toBe(PREVIEW_URL);
	});

	it("still accepts a meta.thumbnail poster when previewUrl is absent", async () => {
		const legacy = streamValue({
			previewUrl: undefined,
			meta: { playback: { hls: HLS }, thumbnail: "https://legacy.example/thumb.jpg" },
		});
		expect((await videoEmbed(legacy)).poster).toBe("https://legacy.example/thumb.jpg");
	});
});
