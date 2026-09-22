import { describe, it, expect } from "vitest";

import { metaPlayback, providerItemToMediaItem } from "../../src/lib/media-utils";

const STREAM_HLS = "https://customer-abc123.cloudflarestream.com/UID/manifest/video.m3u8";
const STREAM_DASH = "https://customer-abc123.cloudflarestream.com/UID/manifest/video.mpd";
const STREAM_POSTER = "https://customer-abc123.cloudflarestream.com/UID/thumbnails/thumbnail.jpg";

describe("metaPlayback", () => {
	it("reads the streaming sources Cloudflare Stream reports", () => {
		expect(metaPlayback({ playback: { hls: STREAM_HLS, dash: STREAM_DASH } })).toEqual({
			hls: STREAM_HLS,
			dash: STREAM_DASH,
		});
	});

	it("returns undefined for a plain uploaded file, which is playable directly", () => {
		// This is what keeps locally stored video on the plain `src` path.
		expect(metaPlayback({ size: 1024 })).toBeUndefined();
		expect(metaPlayback(undefined)).toBeUndefined();
	});
});

describe("providerItemToMediaItem", () => {
	it("falls back to meta.size when the provider reports no top-level size", () => {
		// Regression: Stream items displayed "0 B" because only `item.size` was read.
		const result = providerItemToMediaItem("cloudflare-stream", {
			id: "6a4677c7694f6e2e4270540231dd47ff",
			filename: "webinar.mp4",
			mimeType: "video/mp4",
			previewUrl: STREAM_POSTER,
			meta: { size: 75431883, playback: { hls: STREAM_HLS } },
		} as never);

		expect(result.size).toBe(75431883);
		// `meta` must survive the mapping or the detail panel cannot find playback.
		expect(metaPlayback(result.meta)).toEqual({ hls: STREAM_HLS });
	});
});
