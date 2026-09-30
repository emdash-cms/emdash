import { afterEach, describe, expect, it, vi } from "vitest";

const runtimeMocks = vi.hoisted(() => ({
	readPluginMediaBytes: vi.fn().mockResolvedValue({
		bytes: new Uint8Array([1]),
		filename: "fixture.bin",
		mimeType: "application/octet-stream",
		size: 1,
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
	setMediaStorageCallback(null);
	runtimeMocks.readPluginMediaBytes.mockClear();
});

describe("PluginBridge media storage", () => {
	it("keeps the configured storage callback across bridge module instances", async () => {
		const firstModule = await import("../../src/sandbox/bridge.js");
		const storage = { download: vi.fn() };
		firstModule.setMediaStorageCallback(storage as never);

		vi.resetModules();
		const { PluginBridge } = await import("../../src/sandbox/bridge.js");
		const bridge = new PluginBridge(
			{
				props: {
					pluginId: "media-test",
					pluginVersion: "1.0.0",
					capabilities: ["media:bytes:read"],
					allowedHosts: [],
					storageCollections: [],
				},
			} as never,
			{ DB: {} } as never,
		);

		await bridge.mediaReadBytes("media-1");

		expect(runtimeMocks.readPluginMediaBytes).toHaveBeenCalledWith(
			expect.anything(),
			storage,
			"media-1",
			{ maxBytes: undefined },
		);
	});
});
