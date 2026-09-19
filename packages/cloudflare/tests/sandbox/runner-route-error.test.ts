import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
	const invokeRoute = vi.fn();
	const invokeHook = vi.fn();
	const bridge = vi.fn(() => ({}));
	const loader = {
		get: vi.fn(() => ({
			getEntrypoint: () => ({ invokeHook, invokeRoute }),
		})),
	};
	return { bridge, invokeHook, invokeRoute, loader };
});

vi.mock("cloudflare:workers", () => ({
	WorkerEntrypoint: class {
		ctx: unknown;
		env: unknown;
		constructor(ctx: unknown, env: unknown) {
			this.ctx = ctx;
			this.env = env;
		}
	},
	env: { LOADER: mocks.loader },
	exports: { PluginBridge: mocks.bridge },
}));

import { CloudflareSandboxRunner } from "../../src/sandbox/runner.js";

describe("Cloudflare sandbox route errors", () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it("turns a structured worker result into a retryable host error", async () => {
		mocks.invokeRoute.mockResolvedValue({
			__emdashSandboxRouteError: true,
			error: {
				code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
				message: "Media usage activation is in progress",
				status: 503,
			},
		});
		const runner = new CloudflareSandboxRunner({ db: null as never });
		const plugin = await runner.load(
			{
				id: "content-writer",
				version: "1.0.0",
				capabilities: ["content:write"],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			},
			"export default {}",
		);

		await expect(
			plugin.invokeRoute(
				"write",
				{},
				{
					url: "https://example.com/_emdash/api/plugins/content-writer/write",
					method: "POST",
					headers: {},
					meta: { ip: null, userAgent: null, referer: null, geo: null },
				},
			),
		).rejects.toMatchObject({
			code: "MEDIA_USAGE_ACTIVATION_IN_PROGRESS",
			message: "Media usage activation is in progress",
			status: 503,
		});
	});

	it("preserves a versioned hook error result across Worker Loader RPC", async () => {
		const rejection = {
			__emdashSandboxHookResult: true,
			version: 1,
			error: { code: "SAVE_REJECTED", reason: "Add a summary" },
		};
		mocks.invokeHook.mockResolvedValue(rejection);
		const runner = new CloudflareSandboxRunner({ db: null as never });
		const plugin = await runner.load(
			{
				id: "content-writer",
				version: "1.0.0",
				capabilities: ["content:write"],
				allowedHosts: [],
				storage: {},
				hooks: ["content:beforeSave"],
				routes: [],
				admin: {},
			},
			"export default {}",
		);

		await expect(plugin.invokeHook("content:beforeSave", {})).resolves.toEqual(rejection);
	});

	it("preserves explicit raw responses and nested bytes across Worker Loader RPC", async () => {
		const bytes = new Uint8Array([0, 255, 195, 40]);
		const raw = {
			__emdashPluginResponse: true,
			status: 206,
			headers: [["content-type", "application/octet-stream"]],
			body: { kind: "bytes", value: bytes },
		};
		mocks.invokeRoute.mockResolvedValue(raw);
		const runner = new CloudflareSandboxRunner({ db: null as never });
		const plugin = await runner.load(
			{
				id: "raw-route",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			},
			"export default {}",
		);
		const input = {
			entries: [
				{
					name: "upload",
					kind: "file",
					filename: "invalid.bin",
					contentType: "application/octet-stream",
					bytes,
				},
			],
		};

		await expect(
			plugin.invokeRoute("upload", input, {
				url: "https://example.com/_emdash/api/plugins/raw-route/upload",
				method: "POST",
				headers: {},
				meta: { ip: null, userAgent: null, referer: null, geo: null },
			}),
		).resolves.toEqual(raw);
		expect(mocks.invokeRoute).toHaveBeenCalledWith("upload", input, expect.any(Object));
	});

	it("does not interpret response-shaped JSON as a raw response", async () => {
		const ordinary = {
			status: 201,
			headers: [["x-test", "ordinary"]],
			body: { kind: "text", value: "not raw" },
		};
		mocks.invokeRoute.mockResolvedValue(ordinary);
		const runner = new CloudflareSandboxRunner({ db: null as never });
		const plugin = await runner.load(
			{
				id: "ordinary-route",
				version: "1.0.0",
				capabilities: [],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			},
			"export default {}",
		);

		await expect(
			plugin.invokeRoute(
				"ordinary",
				{},
				{
					url: "https://example.com/_emdash/api/plugins/ordinary-route/ordinary",
					method: "GET",
					headers: {},
					meta: { ip: null, userAgent: null, referer: null, geo: null },
				},
			),
		).resolves.toEqual(ordinary);
	});
});
