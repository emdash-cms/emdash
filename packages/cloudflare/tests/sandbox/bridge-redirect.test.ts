import { describe, expect, it, vi } from "vitest";

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

import { PluginBridge } from "../../src/sandbox/bridge.js";

function bridge(capabilities: string[]) {
	const ctx = {
		props: {
			pluginId: "redirect-plugin",
			pluginVersion: "1.0.0",
			capabilities,
			allowedHosts: [],
			storageCollections: [],
		},
	};
	const env = { DB: {} };
	return new PluginBridge(ctx as never, env as never);
}

describe("PluginBridge redirect capability enforcement", () => {
	it("does not grant redirect reads from unrelated content authority", async () => {
		await expect(bridge(["content:write"]).redirectList()).rejects.toThrow(
			"Missing capability: redirects:read",
		);
	});

	it("does not grant redirect writes from redirects:read", async () => {
		await expect(
			bridge(["redirects:read"]).redirectCreate({ source: "/old", destination: "/new" }),
		).rejects.toThrow("Missing capability: redirects:write");
	});
});
