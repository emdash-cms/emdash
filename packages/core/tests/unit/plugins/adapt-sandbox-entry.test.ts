/**
 * adaptSandboxEntry() Tests
 *
 * Tests the in-process adapter that converts standard-format plugins
 * ({ hooks, routes }) into ResolvedPlugin instances compatible with HookPipeline.
 *
 */

import { describe, it, expect, vi } from "vitest";

import type { PluginDescriptor } from "../../../src/astro/integration/runtime.js";
import { adaptSandboxEntry } from "../../../src/plugins/adapt-sandbox-entry.js";
import type { StandardPluginDefinition, StandardHookHandler } from "../../../src/plugins/types.js";

/** Create a properly typed mock hook handler */
function mockHandler(): StandardHookHandler {
	return vi.fn(async () => {}) as unknown as StandardHookHandler;
}

function createDescriptor(overrides?: Partial<PluginDescriptor>): PluginDescriptor {
	return {
		id: "test-plugin",
		version: "1.0.0",
		entrypoint: "@test/plugin",
		format: "standard",
		...overrides,
	};
}

describe("adaptSandboxEntry", () => {
	describe("basic adaptation", () => {
		it("produces a ResolvedPlugin with correct id and version", () => {
			const def: StandardPluginDefinition = {
				hooks: {},
				routes: {},
			};
			const descriptor = createDescriptor({ id: "my-plugin", version: "2.1.0" });

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.id).toBe("my-plugin");
			expect(result.version).toBe("2.1.0");
		});

		it("adapts an empty definition", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.hooks).toEqual({});
			expect(result.routes).toEqual({});
			expect(result.capabilities).toEqual([]);
			expect(result.allowedHosts).toEqual([]);
			expect(result.storage).toEqual({});
		});

		it("carries capabilities from descriptor", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({
				capabilities: ["content:read", "network:request"],
			});

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.capabilities).toEqual(["content:read", "network:request"]);
		});

		it("carries allowedHosts from descriptor", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({
				allowedHosts: ["api.example.com", "*.cdn.com"],
			});

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.allowedHosts).toEqual(["api.example.com", "*.cdn.com"]);
		});

		it("carries storage config from descriptor", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({
				storage: {
					events: { indexes: ["timestamp", "type"] },
					logs: { indexes: ["level"] },
				},
			});

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.storage).toEqual({
				events: { indexes: ["timestamp", "type"] },
				logs: { indexes: ["level"] },
			});
		});

		it("carries admin pages from descriptor", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({
				adminPages: [{ path: "/settings", label: "Settings", icon: "gear" }],
			});

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.admin.pages).toEqual([{ path: "/settings", label: "Settings", icon: "gear" }]);
		});

		it("carries admin widgets from descriptor", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({
				adminWidgets: [{ id: "status", title: "Status", size: "half" }],
			});

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.admin.widgets).toEqual([{ id: "status", title: "Status", size: "half" }]);
		});
	});

	describe("hook adaptation", () => {
		it("resolves a bare function hook with defaults", () => {
			const handler = vi.fn();
			const def: StandardPluginDefinition = {
				hooks: {
					"content:afterSave": handler,
				},
			};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			const hook = result.hooks["content:afterSave"];
			expect(hook).toBeDefined();
			expect(hook!.handler).toBe(handler);
			expect(hook!.priority).toBe(100);
			expect(hook!.timeout).toBe(5000);
			expect(hook!.dependencies).toEqual([]);
			expect(hook!.errorPolicy).toBe("abort");
			expect(hook!.exclusive).toBe(false);
			expect(hook!.pluginId).toBe("test-plugin");
		});

		it("resolves a config object hook with custom settings", () => {
			const handler = vi.fn();
			const def: StandardPluginDefinition = {
				hooks: {
					"content:beforeSave": {
						handler,
						priority: 1,
						timeout: 10000,
						dependencies: ["other-plugin"],
						errorPolicy: "continue",
						exclusive: false,
					},
				},
			};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			const hook = result.hooks["content:beforeSave"];
			expect(hook).toBeDefined();
			expect(hook!.handler).toBe(handler);
			expect(hook!.priority).toBe(1);
			expect(hook!.timeout).toBe(10000);
			expect(hook!.dependencies).toEqual(["other-plugin"]);
			expect(hook!.errorPolicy).toBe("continue");
		});

		it("resolves multiple hooks", () => {
			const def: StandardPluginDefinition = {
				hooks: {
					"content:beforeSave": mockHandler(),
					"content:afterSave": { handler: mockHandler(), priority: 200 },
					"content:afterDelete": mockHandler(),
					"media:afterUpload": mockHandler(),
					"plugin:install": mockHandler(),
				},
			};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.hooks["content:beforeSave"]).toBeDefined();
			expect(result.hooks["content:afterSave"]).toBeDefined();
			expect(result.hooks["content:afterDelete"]).toBeDefined();
			expect(result.hooks["media:afterUpload"]).toBeDefined();
			expect(result.hooks["plugin:install"]).toBeDefined();
		});

		it("sets pluginId on all hooks from descriptor", () => {
			const def: StandardPluginDefinition = {
				hooks: {
					"content:beforeSave": mockHandler(),
					"content:afterSave": { handler: mockHandler() },
				},
			};
			const descriptor = createDescriptor({ id: "my-plugin" });

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.hooks["content:beforeSave"]!.pluginId).toBe("my-plugin");
			expect(result.hooks["content:afterSave"]!.pluginId).toBe("my-plugin");
		});

		it("resolves exclusive hooks", () => {
			const handler = vi.fn();
			const def: StandardPluginDefinition = {
				hooks: {
					"email:deliver": {
						handler,
						exclusive: true,
					},
				},
			};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.hooks["email:deliver"]!.exclusive).toBe(true);
		});

		it("throws on unknown hook names", () => {
			const def: StandardPluginDefinition = {
				hooks: {
					"unknown:hook": mockHandler(),
				},
			};
			const descriptor = createDescriptor();

			expect(() => adaptSandboxEntry(def, descriptor)).toThrow("unknown hook");
		});

		it("applies default config for partial config objects", () => {
			const handler = vi.fn();
			const def: StandardPluginDefinition = {
				hooks: {
					"content:afterSave": {
						handler,
						priority: 200,
						// timeout, dependencies, errorPolicy, exclusive use defaults
					},
				},
			};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			const hook = result.hooks["content:afterSave"];
			expect(hook!.priority).toBe(200);
			expect(hook!.timeout).toBe(5000);
			expect(hook!.dependencies).toEqual([]);
			expect(hook!.errorPolicy).toBe("abort");
			expect(hook!.exclusive).toBe(false);
		});
	});

	describe("route adaptation", () => {
		it("wraps standard two-arg route handler into single-arg RouteContext handler", async () => {
			const standardHandler = vi.fn().mockResolvedValue({ ok: true });

			const def: StandardPluginDefinition = {
				routes: {
					status: {
						handler: standardHandler,
					},
				},
			};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.routes.status).toBeDefined();

			// Simulate calling the adapted handler with a RouteContext-like object
			const mockCtx = {
				input: { foo: "bar" },
				request: new Request("http://localhost/test"),
				requestMeta: { ip: null, userAgent: null, referer: null, geo: null },
				plugin: { id: "test-plugin", version: "1.0.0" },
				kv: {} as any,
				storage: {} as any,
				log: {} as any,
				site: { name: "", url: "", locale: "en" },
				url: (p: string) => p,
			};

			await result.routes.status.handler(mockCtx as any);

			// Verify the standard handler was called with (routeCtx, pluginCtx)
			expect(standardHandler).toHaveBeenCalledTimes(1);
			const [routeCtx, pluginCtx] = standardHandler.mock.calls[0];
			expect(routeCtx.input).toEqual({ foo: "bar" });
			expect(routeCtx.request).toBeDefined();
			expect(routeCtx.requestMeta).toBeDefined();
			// pluginCtx should be the stripped PluginContext (without route-specific fields)
			expect(pluginCtx.plugin.id).toBe("test-plugin");
			expect(pluginCtx.kv).toBeDefined();
			expect(pluginCtx.log).toBeDefined();
			// Route-specific fields should NOT leak into pluginCtx
			expect(pluginCtx).not.toHaveProperty("input");
			expect(pluginCtx).not.toHaveProperty("request");
			expect(pluginCtx).not.toHaveProperty("requestMeta");
		});

		it("preserves public flag on routes", () => {
			const def: StandardPluginDefinition = {
				routes: {
					webhook: {
						handler: vi.fn(),
						public: true,
					},
				},
			};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.routes.webhook.public).toBe(true);
		});

		it("adapts multiple routes", () => {
			const def: StandardPluginDefinition = {
				routes: {
					status: { handler: vi.fn() },
					sync: { handler: vi.fn() },
					"admin/settings": { handler: vi.fn() },
				},
			};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			expect(Object.keys(result.routes)).toEqual(["status", "sync", "admin/settings"]);
		});
	});

	describe("capability normalization", () => {
		it("normalizes content:write to include content:read", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({ capabilities: ["content:write"] });

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.capabilities).toContain("content:write");
			expect(result.capabilities).toContain("content:read");
		});

		it("normalizes media:write to include media:read", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({ capabilities: ["media:write"] });

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.capabilities).toContain("media:write");
			expect(result.capabilities).toContain("media:read");
		});

		it("normalizes network:request:unrestricted to include network:request", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({ capabilities: ["network:request:unrestricted"] });

			const result = adaptSandboxEntry(def, descriptor);

			expect(result.capabilities).toContain("network:request:unrestricted");
			expect(result.capabilities).toContain("network:request");
		});

		it("does not duplicate implied capabilities", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({
				capabilities: ["content:read", "content:write"],
			});

			const result = adaptSandboxEntry(def, descriptor);

			const readCount = result.capabilities.filter((c) => c === "content:read").length;
			expect(readCount).toBe(1);
		});

		it("throws on invalid capability", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({
				capabilities: ["invalid:capability"],
			});

			expect(() => adaptSandboxEntry(def, descriptor)).toThrow("Invalid capability");
		});

		// ── Deprecation alias layer ────────────────────────────────
		// Sandboxed plugins arrive via descriptors generated by older
		// builds (or older bundle versions). The adapter must accept
		// deprecated names and silently rewrite to canonical names so
		// the runtime only sees the new shape.

		it("rewrites all deprecated capability names to current names", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({
				capabilities: [
					"read:content",
					"write:content",
					"read:media",
					"write:media",
					"read:users",
					"network:fetch",
					"network:fetch:any",
					"email:provide",
					"email:intercept",
					"page:inject",
				],
			});

			const result = adaptSandboxEntry(def, descriptor);

			// Canonical names present
			expect(result.capabilities).toContain("content:read");
			expect(result.capabilities).toContain("content:write");
			expect(result.capabilities).toContain("media:read");
			expect(result.capabilities).toContain("media:write");
			expect(result.capabilities).toContain("users:read");
			expect(result.capabilities).toContain("network:request");
			expect(result.capabilities).toContain("network:request:unrestricted");
			expect(result.capabilities).toContain("hooks.email-transport:register");
			expect(result.capabilities).toContain("hooks.email-events:register");
			expect(result.capabilities).toContain("hooks.page-fragments:register");

			// Deprecated names absent
			for (const old of [
				"read:content",
				"write:content",
				"read:media",
				"write:media",
				"read:users",
				"network:fetch",
				"network:fetch:any",
				"email:provide",
				"email:intercept",
				"page:inject",
			]) {
				expect(result.capabilities).not.toContain(old);
			}
		});

		it("deduplicates when both deprecated and current names are present", () => {
			const def: StandardPluginDefinition = {};
			const descriptor = createDescriptor({
				capabilities: ["read:content", "content:read"],
			});

			const result = adaptSandboxEntry(def, descriptor);

			const readCount = result.capabilities.filter((c) => c === "content:read").length;
			expect(readCount).toBe(1);
		});
	});

	describe("integration with HookPipeline", () => {
		it("produces hooks compatible with HookPipeline registration", () => {
			// HookPipeline stores hooks as ResolvedHook<unknown> internally.
			// The adapted hooks must have the expected shape.
			const handler = vi.fn().mockResolvedValue(undefined);
			const def: StandardPluginDefinition = {
				hooks: {
					"content:afterSave": {
						handler,
						priority: 50,
					},
				},
			};
			const descriptor = createDescriptor();

			const result = adaptSandboxEntry(def, descriptor);

			// Verify the hook shape matches what HookPipeline expects
			const hook = result.hooks["content:afterSave"]!;
			expect(typeof hook.handler).toBe("function");
			expect(typeof hook.priority).toBe("number");
			expect(typeof hook.timeout).toBe("number");
			expect(Array.isArray(hook.dependencies)).toBe(true);
			expect(typeof hook.errorPolicy).toBe("string");
			expect(typeof hook.exclusive).toBe("boolean");
			expect(typeof hook.pluginId).toBe("string");
		});
	});
});
