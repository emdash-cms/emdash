import { afterEach, describe, expect, it, vi } from "vitest";

const { fakeEnv } = vi.hoisted(() => ({ fakeEnv: {} as Record<string, string | undefined> }));

vi.mock("cloudflare:workers", () => ({ env: fakeEnv }));

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

function thumbnailUrl(mediaProvider: ReturnType<typeof createMediaProvider>, id: string): string {
	const getThumbnailUrl = mediaProvider.getThumbnailUrl;
	if (!getThumbnailUrl) throw new Error("Stream provider does not implement getThumbnailUrl");
	return getThumbnailUrl(id);
}

describe("cloudflare stream credential resolution", () => {
	const originalAccountId = process.env.CF_ACCOUNT_ID;
	const originalApiToken = process.env.CF_STREAM_TOKEN;

	afterEach(() => {
		for (const key of Object.keys(fakeEnv)) delete fakeEnv[key];
		if (originalAccountId === undefined) delete process.env.CF_ACCOUNT_ID;
		else process.env.CF_ACCOUNT_ID = originalAccountId;
		if (originalApiToken === undefined) delete process.env.CF_STREAM_TOKEN;
		else process.env.CF_STREAM_TOKEN = originalApiToken;
	});

	it("falls back to process.env when no Workers binding is set", () => {
		process.env.CF_ACCOUNT_ID = "nodeacc1";
		process.env.CF_STREAM_TOKEN = "node-token";

		const nodeProvider = createMediaProvider({});
		expect(new URL(thumbnailUrl(nodeProvider, "video-id")).hostname).toBe(
			"customer-nodeacc1.cloudflarestream.com",
		);
	});

	it("prefers the Workers binding over process.env", () => {
		fakeEnv.CF_ACCOUNT_ID = "wrkracc1";
		process.env.CF_ACCOUNT_ID = "nodeacc1";
		process.env.CF_STREAM_TOKEN = "node-token";

		const workersProvider = createMediaProvider({});
		expect(new URL(thumbnailUrl(workersProvider, "video-id")).hostname).toBe(
			"customer-wrkracc1.cloudflarestream.com",
		);
	});

	it("prefers a direct config value over both the Workers binding and process.env", () => {
		fakeEnv.CF_ACCOUNT_ID = "wrkracc1";
		process.env.CF_ACCOUNT_ID = "nodeacc1";
		process.env.CF_STREAM_TOKEN = "node-token";

		const directProvider = createMediaProvider({ accountId: "directac" });
		expect(new URL(thumbnailUrl(directProvider, "video-id")).hostname).toBe(
			"customer-directac.cloudflarestream.com",
		);
	});

	it("throws the existing missing-variable error when neither source has the value", () => {
		expect(() => createMediaProvider({})).toThrow("Missing CF_ACCOUNT_ID");
	});
});
