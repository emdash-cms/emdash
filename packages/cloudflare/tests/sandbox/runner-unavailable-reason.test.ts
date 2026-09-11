import { beforeEach, describe, expect, it, vi } from "vitest";

const bindings = vi.hoisted(() => ({
	env: {} as Record<string, unknown>,
	exports: {} as Record<string, unknown>,
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
	env: bindings.env,
	exports: bindings.exports,
}));

import { CloudflareSandboxRunner } from "../../src/sandbox/runner.js";

describe("Cloudflare sandbox runner availability", () => {
	beforeEach(() => {
		bindings.env.LOADER = { get: vi.fn() };
		bindings.exports.PluginBridge = vi.fn();
	});

	it("names the Worker Loader binding when it is missing", () => {
		delete bindings.env.LOADER;
		const runner = new CloudflareSandboxRunner({ db: null as never });

		expect(runner.isAvailable()).toBe(false);
		expect(runner.unavailableReason()).toContain("worker_loaders");
		expect(runner.unavailableReason()).not.toContain("PluginBridge");
	});

	it("names the PluginBridge export when it is missing", () => {
		delete bindings.exports.PluginBridge;
		const runner = new CloudflareSandboxRunner({ db: null as never });

		expect(runner.isAvailable()).toBe(false);
		expect(runner.unavailableReason()).toContain("PluginBridge");
		expect(runner.unavailableReason()).not.toContain("worker_loaders");
	});

	it("names both when both are missing", () => {
		delete bindings.env.LOADER;
		delete bindings.exports.PluginBridge;
		const runner = new CloudflareSandboxRunner({ db: null as never });

		expect(runner.unavailableReason()).toContain("worker_loaders");
		expect(runner.unavailableReason()).toContain("PluginBridge");
	});
});
