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

	it("passes implied capabilities to the bridge binding", async () => {
		mocks.invokeRoute.mockResolvedValue(undefined);
		const runner = new CloudflareSandboxRunner({ db: null as never });
		const plugin = await runner.load(
			{
				id: "redirect-writer",
				version: "1.0.0",
				capabilities: ["redirects:write"],
				allowedHosts: [],
				storage: {},
				hooks: [],
				routes: ["redirects"],
				admin: {},
			},
			"export default {}",
		);

		await plugin.invokeRoute(
			"redirects",
			{},
			{
				url: "https://example.com/_emdash/api/plugins/redirect-writer/redirects",
				method: "POST",
				headers: {},
				meta: { ip: null, userAgent: null, referer: null, geo: null },
			},
		);

		expect(mocks.bridge).toHaveBeenCalledWith({
			props: expect.objectContaining({
				capabilities: expect.arrayContaining(["redirects:write", "redirects:read"]),
			}),
		});
	});

	it.each(["hook", "route"] as const)(
		"releases queued action work when %s setup throws",
		async (kind) => {
			mocks.loader.get.mockImplementationOnce(() => {
				throw new Error("loader setup failed");
			});
			const contentActions = {
				begin: vi.fn(),
				flush: vi.fn().mockResolvedValue(undefined),
			};
			const runner = new CloudflareSandboxRunner({
				db: null as never,
				contentActions: contentActions as never,
			});
			const plugin = await runner.load(
				{
					id: "setup-error",
					version: "1.0.0",
					capabilities: ["content:publish"],
					allowedHosts: [],
					storage: {},
					hooks: ["content:beforeSave"],
					routes: [],
					admin: {},
				},
				"export default {}",
			);

			const invocation =
				kind === "hook"
					? plugin.invokeHook("content:beforeSave", {})
					: plugin.invokeRoute(
							"publish",
							{},
							{
								url: "https://example.com/_emdash/api/plugins/setup-error/publish",
								method: "POST",
								headers: {},
								meta: { ip: null, userAgent: null, referer: null, geo: null },
							},
						);

			await expect(invocation).rejects.toThrow("loader setup failed");
			expect(contentActions.begin).toHaveBeenCalledOnce();
			expect(contentActions.flush).toHaveBeenCalledWith("setup-error", expect.any(String), true);
		},
	);

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
		expect(mocks.invokeRoute).toHaveBeenCalledWith(
			"upload",
			input,
			expect.any(Object),
			expect.any(String),
		);
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
