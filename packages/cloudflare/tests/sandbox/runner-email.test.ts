import type { SandboxEmailSendCallback } from "emdash";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	bridge: vi.fn(),
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

type Runner = InstanceType<typeof import("../../src/sandbox/runner.js").CloudflareSandboxRunner>;

async function createRunner(emailSend?: SandboxEmailSendCallback): Promise<Runner> {
	const { CloudflareSandboxRunner } = await import("../../src/sandbox/runner.js");
	// The worker entrypoint and the runtime runner can be in separate SSR chunks.
	vi.resetModules();
	const { PluginBridge } = await import("../../src/sandbox/bridge.js");
	mocks.bridge.mockImplementation((ctx: unknown) => new PluginBridge(ctx as never, {} as never));
	return new CloudflareSandboxRunner({ db: null as never, emailSend });
}

describe("Cloudflare sandbox email delivery", () => {
	const runners: Runner[] = [];

	beforeEach(() => {
		vi.resetModules();
		vi.clearAllMocks();
	});

	afterEach(async () => {
		await Promise.all(runners.splice(0).map((runner) => runner.terminateAll()));
		const { setEmailSendCallback } = await import("../../src/sandbox/bridge.js");
		setEmailSendCallback(null);
	});

	it("delivers from a plugin loaded after email wiring across separate bridge modules", async () => {
		const delivered: unknown[] = [];
		const runner = await createRunner();
		runners.push(runner);
		runner.setEmailSend(async (email, pluginId) => {
			delivered.push({ email, pluginId });
		});
		const plugin = await runner.load(manifest, "export default {};");

		await plugin.invokeRoute("subscribe", message, request);

		expect(delivered).toEqual([{ email: message, pluginId: "newsletter" }]);
	});

	it("rejects missing capabilities and missing callbacks without delivering", async () => {
		const deliver = vi.fn(async () => undefined);
		const runner = await createRunner(deliver);
		runners.push(runner);
		const denied = await runner.load({ ...manifest, capabilities: [] }, "export default {};");
		await expect(denied.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Missing capability: email:send",
		);
		expect(deliver).not.toHaveBeenCalled();

		runner.setEmailSend(null);
		const allowed = await runner.load({ ...manifest, version: "2.0.0" }, "export default {};");
		await expect(allowed.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Email is not configured",
		);
	});

	it("allows the public setter to replace and clear email for runner-created bridges", async () => {
		const delivered: string[] = [];
		const runner = await createRunner(async () => {
			delivered.push("initial");
		});
		runners.push(runner);
		const plugin = await runner.load(manifest, "export default {};");
		await plugin.invokeRoute("subscribe", message, request);

		vi.resetModules();
		const { setEmailSendCallback } = await import("../../src/sandbox/bridge.js");
		setEmailSendCallback(async () => {
			delivered.push("replacement");
		});
		await plugin.invokeRoute("subscribe", message, request);
		setEmailSendCallback(null);
		await expect(plugin.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Email is not configured",
		);

		expect(delivered).toEqual(["initial", "replacement"]);
	});

	it("propagates host delivery failures to the plugin caller", async () => {
		const runner = await createRunner(async () => {
			throw new Error("Provider unavailable");
		});
		runners.push(runner);
		const plugin = await runner.load(manifest, "export default {};");

		await expect(plugin.invokeRoute("subscribe", message, request)).rejects.toThrow(
			"Provider unavailable",
		);
	});
});
