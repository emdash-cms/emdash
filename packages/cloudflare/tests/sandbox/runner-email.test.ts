import type { SandboxEmailSendCallback } from "emdash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	bridge: vi.fn(),
	emailSend: vi.fn<SandboxEmailSendCallback>(),
	withEmDashRuntime: vi.fn<(run: () => Promise<void>) => Promise<void>>(),
	loader: {
		get: vi.fn(
			(
				_name: string,
				create: () => {
					env: {
						BRIDGE: {
							emailSend: (message: Parameters<SandboxEmailSendCallback>[0]) => Promise<void>;
						};
					};
				},
			) => {
				const worker = create();
				return {
					getEntrypoint: () => ({
						invokeRoute: (_route: string, message: Parameters<SandboxEmailSendCallback>[0]) =>
							worker.env.BRIDGE.emailSend(message),
					}),
				};
			},
		),
	},
}));

vi.mock("cloudflare:workers", () => ({
	// eslint-disable-next-line typescript/no-extraneous-class -- Cloudflare RPC base class stub
	RpcTarget: class {},
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

vi.mock("emdash/middleware", () => ({ withEmDashRuntime: mocks.withEmDashRuntime }));

import { PluginBridge, setEmailSendCallback } from "../../src/sandbox/bridge.js";
import { CloudflareSandboxRunner } from "../../src/sandbox/runner.js";

const message = { to: "reader@example.com", subject: "Confirm subscription", text: "Confirm here" };
const manifest = {
	id: "newsletter",
	version: "1.0.0",
	capabilities: ["email:send" as const],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: ["subscribe"],
	admin: {},
};
const request = {
	url: "https://example.com/subscribe",
	method: "POST",
	headers: {},
	meta: { ip: null, userAgent: null, referer: null, geo: null },
};

function createRunner(emailSend?: SandboxEmailSendCallback): CloudflareSandboxRunner {
	return new CloudflareSandboxRunner({ db: null as never, emailSend });
}

describe("Cloudflare sandbox email delivery", () => {
	const runners: CloudflareSandboxRunner[] = [];

	beforeEach(() => {
		vi.clearAllMocks();
		setEmailSendCallback(null);
		mocks.emailSend.mockResolvedValue(undefined);
		mocks.bridge.mockImplementation((ctx: unknown) => new PluginBridge(ctx as never, {} as never));
		mocks.withEmDashRuntime.mockImplementation(async (run) => {
			setEmailSendCallback(mocks.emailSend);
			await run();
		});
	});

	afterEach(async () => {
		await Promise.all(runners.splice(0).map((runner) => runner.terminateAll()));
		setEmailSendCallback(null);
	});

	it("delivers directly when the callback is already wired", async () => {
		const delivered: unknown[] = [];
		const runner = createRunner();
		runners.push(runner);
		runner.setEmailSend(async (email, pluginId) => {
			delivered.push({ email, pluginId });
		});
		const plugin = await runner.load(manifest, "export default {};");

		await plugin.invokeRoute("subscribe", message, request);

		expect(delivered).toEqual([{ email: message, pluginId: "newsletter" }]);
		expect(mocks.withEmDashRuntime).not.toHaveBeenCalled();
	});

	it("starts EmDash in a cold bridge isolate and delivers through its newly wired callback", async () => {
		const runner = createRunner();
		runners.push(runner);
		const plugin = await runner.load(manifest, "export default {};");

		await plugin.invokeRoute("subscribe", message, request);
		await plugin.invokeRoute("subscribe", message, request);

		expect(mocks.emailSend.mock.calls).toEqual([
			[message, "newsletter"],
			[message, "newsletter"],
		]);
		expect(mocks.withEmDashRuntime).toHaveBeenCalledOnce();
	});

	it("handles overlapping sends once startup wires the callback", async () => {
		let runtimeStarted!: () => void;
		const runtimeStartedPromise = new Promise<void>((resolve) => {
			runtimeStarted = resolve;
		});
		let releaseRuntime!: () => void;
		const runtimeReleasePromise = new Promise<void>((resolve) => {
			releaseRuntime = resolve;
		});
		mocks.withEmDashRuntime.mockImplementation(async (run) => {
			runtimeStarted();
			setEmailSendCallback(mocks.emailSend);
			await runtimeReleasePromise;
			await run();
		});
		const runner = createRunner();
		runners.push(runner);
		const plugin = await runner.load(manifest, "export default {};");
		const messages = Array.from({ length: 24 }, (_, index) => ({
			...message,
			subject: `Confirmation ${index}`,
		}));

		const firstSend = plugin.invokeRoute("subscribe", messages[0]!, request);
		await runtimeStartedPromise;
		const concurrentSends = messages
			.slice(1)
			.map((email) => plugin.invokeRoute("subscribe", email, request));
		releaseRuntime();
		await Promise.all([firstSend, ...concurrentSends]);

		expect(mocks.emailSend.mock.calls).toHaveLength(messages.length);
		expect(mocks.emailSend.mock.calls).toEqual(
			expect.arrayContaining(messages.map((email) => [email, "newsletter"])),
		);
	});

	it("rejects missing capabilities without starting EmDash or delivering", async () => {
		const runner = createRunner();
		runners.push(runner);
		const denied = await runner.load({ ...manifest, capabilities: [] }, "export default {};");
		await expect(denied.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Missing capability: email:send",
		);
		expect(mocks.emailSend).not.toHaveBeenCalled();
		expect(mocks.withEmDashRuntime).not.toHaveBeenCalled();
	});

	it("rejects when runtime initialization leaves the callback missing", async () => {
		mocks.withEmDashRuntime.mockImplementation(async (run) => {
			await run();
		});
		const runner = createRunner();
		runners.push(runner);
		const plugin = await runner.load(manifest, "export default {};");

		await expect(plugin.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Email is not configured. No email provider is available.",
		);
		expect(mocks.withEmDashRuntime).toHaveBeenCalledOnce();
		expect(mocks.emailSend).not.toHaveBeenCalled();
	});

	it("allows the public setter to replace and clear email for runner-created bridges", async () => {
		const delivered: string[] = [];
		const runner = createRunner(async () => {
			delivered.push("initial");
		});
		runners.push(runner);
		const plugin = await runner.load(manifest, "export default {};");
		await plugin.invokeRoute("subscribe", message, request);

		setEmailSendCallback(async () => {
			delivered.push("replacement");
		});
		await plugin.invokeRoute("subscribe", message, request);
		setEmailSendCallback(null);
		mocks.withEmDashRuntime.mockImplementation(async (run) => {
			await run();
		});
		await expect(plugin.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Email is not configured",
		);

		expect(delivered).toEqual(["initial", "replacement"]);
	});

	it("propagates delivery failures after initializing the runtime", async () => {
		mocks.emailSend.mockRejectedValue(new Error("Cold provider unavailable"));
		const runner = createRunner();
		runners.push(runner);
		const plugin = await runner.load(manifest, "export default {};");

		await expect(plugin.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Cold provider unavailable",
		);
	});

	it("propagates runtime initialization failures without attempting delivery", async () => {
		mocks.withEmDashRuntime.mockRejectedValue(new Error("Runtime startup failed"));
		const runner = createRunner();
		runners.push(runner);
		const plugin = await runner.load(manifest, "export default {};");

		await expect(plugin.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Runtime startup failed",
		);
		expect(mocks.emailSend).not.toHaveBeenCalled();
	});

	it("propagates host delivery failures to the plugin caller", async () => {
		const runner = createRunner(async () => {
			throw new Error("Provider unavailable");
		});
		runners.push(runner);
		const plugin = await runner.load(manifest, "export default {};");

		await expect(plugin.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Provider unavailable",
		);
	});
});
