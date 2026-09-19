import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

	afterEach(() => {
		vi.useRealTimers();
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

	it("releases queued action work when a plugin never settles", async () => {
		vi.useFakeTimers();
		mocks.invokeRoute.mockImplementation(() => new Promise(() => undefined));
		const contentActions = {
			begin: vi.fn(),
			flush: vi.fn().mockResolvedValue(undefined),
		};
		const runner = new CloudflareSandboxRunner({
			db: null as never,
			limits: { wallTimeMs: 10 },
			contentActions: contentActions as never,
		});
		const plugin = await runner.load(
			{
				id: "content-hanger",
				version: "1.0.0",
				capabilities: ["content:publish"],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: [],
				admin: {},
			},
			"export default {}",
		);
		const invalidateContentCache = vi.fn().mockResolvedValue(undefined);

		const invocation = plugin.invokeRoute(
			"hang",
			{},
			{
				url: "https://example.com/_emdash/api/plugins/content-hanger/hang",
				method: "POST",
				headers: {},
				meta: { ip: null, userAgent: null, referer: null, geo: null },
			},
			{ invalidateContentCache },
		);
		const timedOut = expect(invocation).rejects.toThrow(/exceeded wall-time limit/);
		await vi.advanceTimersByTimeAsync(10);

		await timedOut;
		expect(contentActions.begin).toHaveBeenCalledWith(
			"content-hanger",
			expect.any(String),
			invalidateContentCache,
		);
		const invocationId = contentActions.begin.mock.calls[0]?.[1];
		expect(contentActions.flush).toHaveBeenCalledWith("content-hanger", invocationId, false);
	});
});
