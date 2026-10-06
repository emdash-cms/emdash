import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
	readPluginMediaBytes: vi.fn(async (_db, storage, _id, _options) => {
		if (!storage) throw new Error("Media storage is not configured");
		return {
			bytes: new Uint8Array([1]),
			filename: "fixture.bin",
			mimeType: "application/octet-stream",
			size: 1,
		};
	}),
}));

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
}));

vi.mock("../../src/sandbox/bridge-runtime.js", () => ({
	D1Dialect: vi.fn(),
	Kysely: vi.fn(),
	readPluginMediaBytes: runtimeMocks.readPluginMediaBytes,
}));

afterEach(async () => {
	const { setMediaStorageCallback } = await import("../../src/sandbox/bridge.js");
	setMediaStorageCallback("media-storage-key-1", null);
	runtimeMocks.readPluginMediaBytes.mockClear();
});

function makeEnv(bucket?: unknown) {
	return { DB: {}, ...(bucket !== undefined ? { MEDIA: bucket } : {}) } as never;
}

function makeProps(overrides?: Record<string, unknown>) {
	return {
		pluginId: "media-test",
		pluginVersion: "1.0.0",
		capabilities: ["media:bytes:read"],
		allowedHosts: [],
		storageCollections: [],
		...overrides,
	};
}

describe("PluginBridge media storage", () => {
	it("reads bytes using an env.MEDIA R2 binding", async () => {
		const { PluginBridge } = await import("../../src/sandbox/bridge.js");
		const body = new ReadableStream<Uint8Array>();
		const bucket = {
			get: vi.fn().mockResolvedValue({
				body,
				httpMetadata: { contentType: "image/jpeg" },
				size: 342_000,
			}),
		};

		const bridge = new PluginBridge(
			{
				props: makeProps(),
			} as never,
			makeEnv(bucket),
		);

		await bridge.mediaReadBytes("media-1");

		expect(runtimeMocks.readPluginMediaBytes).toHaveBeenCalledWith(
			expect.anything(),
			expect.anything(),
			"media-1",
			{ maxBytes: undefined },
		);

		const storage = runtimeMocks.readPluginMediaBytes.mock.calls[0]?.[1] as {
			download: (key: string) => Promise<unknown>;
		};
		const download = await storage.download("media-1");
		expect(bucket.get).toHaveBeenCalledWith("media-1");
		expect(download).toEqual({
			body,
			contentType: "image/jpeg",
			size: 342_000,
		});
	});

	it("falls back to the storage callback when env.MEDIA is absent", async () => {
		const { setMediaStorageCallback, PluginBridge } = await import("../../src/sandbox/bridge.js");
		const storage = { download: vi.fn() };
		setMediaStorageCallback("media-storage-key-1", storage as never);

		const bridge = new PluginBridge(
			{
				props: makeProps({ mediaStorageKey: "media-storage-key-1" }),
			} as never,
			makeEnv(),
		);

		await bridge.mediaReadBytes("media-1");

		expect(runtimeMocks.readPluginMediaBytes).toHaveBeenCalledWith(
			expect.anything(),
			storage,
			"media-1",
			{ maxBytes: undefined },
		);
	});

	it("prefers env.MEDIA over a registered storage callback", async () => {
		const { setMediaStorageCallback, PluginBridge } = await import("../../src/sandbox/bridge.js");
		const callbackStorage = { download: vi.fn() };
		setMediaStorageCallback("media-storage-key-1", callbackStorage as never);

		const bucket = {
			get: vi.fn().mockResolvedValue({
				body: new ReadableStream<Uint8Array>(),
				httpMetadata: { contentType: "image/png" },
				size: 1,
			}),
		};

		const bridge = new PluginBridge(
			{
				props: makeProps({ mediaStorageKey: "media-storage-key-1" }),
			} as never,
			makeEnv(bucket),
		);

		await bridge.mediaReadBytes("media-1");

		const passedStorage = runtimeMocks.readPluginMediaBytes.mock.calls[0]?.[1];
		expect(passedStorage).not.toBe(callbackStorage);
	});

	it("throws when neither env.MEDIA nor a storage callback is available", async () => {
		const { PluginBridge } = await import("../../src/sandbox/bridge.js");

		const bridge = new PluginBridge(
			{
				props: makeProps(),
			} as never,
			makeEnv(),
		);

		await expect(bridge.mediaReadBytes("media-1")).rejects.toThrow(
			"Media storage is not configured",
		);
		expect(runtimeMocks.readPluginMediaBytes).not.toHaveBeenCalled();
	});

	it("rejects reads after the fallback callback is removed", async () => {
		const { setMediaStorageCallback, PluginBridge } = await import("../../src/sandbox/bridge.js");
		const bridge = new PluginBridge(
			{ props: makeProps({ mediaStorageKey: "media-storage-key-1" }) } as never,
			makeEnv(),
		);
		setMediaStorageCallback("media-storage-key-1", { download: vi.fn() });
		await bridge.mediaReadBytes("media-1");

		setMediaStorageCallback("media-storage-key-1", null);

		await expect(bridge.mediaReadBytes("media-1")).rejects.toThrow(
			"Media storage is not configured",
		);
	});
});
