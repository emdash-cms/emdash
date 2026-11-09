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

function streamVideo(preview?: string) {
	return {
		uid: "UID",
		thumbnail: PREVIEW_URL,
		readyToStream: true,
		status: { state: "ready" },
		meta: { name: "video.mp4" },
		created: "2024-01-01T00:00:00Z",
		modified: "2024-01-01T00:00:00Z",
		size: 1234,
		preview,
		requireSignedURLs: false,
		duration: 41,
		input: { width: 1280, height: 720 },
		playback: { hls: HLS, dash: DASH },
	};
}

function apiResponse(result: unknown) {
	return new Response(JSON.stringify({ success: true, result }), {
		headers: { "Content-Type": "application/json" },
	});
}

function mockFetch(...responses: Response[]) {
	const fetchMock = vi.fn();
	for (const response of responses) fetchMock.mockResolvedValueOnce(response);
	vi.stubGlobal("fetch", fetchMock);
	return fetchMock;
}

afterEach(() => {
	vi.useRealTimers();
	vi.unstubAllGlobals();
});

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

describe("cloudflare stream hosted player mapping", () => {
	it.each([
		[
			"rewrites a watch preview and preserves its query",
			"https://customer-abc12345.cloudflarestream.com/UID/watch?autoplay=true&foo=bar",
			"https://customer-abc12345.cloudflarestream.com/UID/iframe?autoplay=true&foo=bar",
		],
		[
			"keeps an iframe preview unchanged",
			"https://customer-abc12345.cloudflarestream.com/UID/iframe?autoplay=true",
			"https://customer-abc12345.cloudflarestream.com/UID/iframe?autoplay=true",
		],
		[
			"rewrites a watch preview with a trailing slash",
			"https://customer-abc12345.cloudflarestream.com/UID/watch/",
			"https://customer-abc12345.cloudflarestream.com/UID/iframe",
		],
		[
			"omits an unrecognized preview path",
			"https://customer-abc12345.cloudflarestream.com/UID/other",
			undefined,
		],
		["omits a missing preview", undefined, undefined],
		["omits a malformed preview", "not a URL", undefined],
		[
			"omits a non-HTTPS preview",
			"http://customer-abc12345.cloudflarestream.com/UID/watch",
			undefined,
		],
	] as const)("list %s", async (_label, preview, playerUrl) => {
		mockFetch(apiResponse([streamVideo(preview)]));

		const result = await provider.list({});
		expect(result.items[0]).toMatchObject({ playerUrl });
	});

	it("maps get()'s watch preview to the hosted iframe player", async () => {
		mockFetch(
			apiResponse(
				streamVideo("https://customer-abc12345.cloudflarestream.com/UID/watch?token=abc"),
			),
		);

		const get = provider.get?.bind(provider);
		if (!get) throw new Error("Stream provider does not implement get");
		const result = await get("UID");
		expect(result).toMatchObject({
			playerUrl: "https://customer-abc12345.cloudflarestream.com/UID/iframe?token=abc",
		});
	});

	it("returns a pending upload without inventing a hosted player URL", async () => {
		vi.useFakeTimers();
		mockFetch(
			apiResponse({ uploadURL: "https://upload.example.com", uid: "UID" }),
			new Response("uploaded"),
			...Array.from({ length: 10 }, () =>
				apiResponse({
					...streamVideo("https://customer-abc12345.cloudflarestream.com/UID/watch"),
					status: { state: "queued" },
				}),
			),
		);

		const upload = provider.upload?.bind(provider);
		if (!upload) throw new Error("Stream provider does not implement upload");
		const resultPromise = upload({
			file: new File(["video"], "video.mp4", { type: "video/mp4" }),
			filename: "video.mp4",
		});
		await vi.advanceTimersByTimeAsync(10000);
		const result = await resultPromise;
		expect(result.meta?.status).toEqual({ state: "processing" });
		expect(result.playerUrl).toBeUndefined();
	});

	it("maps a completed upload's watch preview to the hosted iframe player", async () => {
		vi.useFakeTimers();
		mockFetch(
			apiResponse({ uploadURL: "https://upload.example.com", uid: "UID" }),
			new Response("uploaded"),
			apiResponse(
				streamVideo("https://customer-abc12345.cloudflarestream.com/UID/watch?token=abc"),
			),
		);

		const upload = provider.upload?.bind(provider);
		if (!upload) throw new Error("Stream provider does not implement upload");
		const resultPromise = upload({
			file: new File(["video"], "video.mp4", { type: "video/mp4" }),
			filename: "video.mp4",
		});
		await vi.advanceTimersByTimeAsync(1000);

		expect(await resultPromise).toMatchObject({
			playerUrl: "https://customer-abc12345.cloudflarestream.com/UID/iframe?token=abc",
		});
	});
});

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
