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
});
