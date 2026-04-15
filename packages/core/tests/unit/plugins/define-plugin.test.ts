/**
 * definePlugin() Tests
 *
 * Tests the plugin definition helper for:
 * - ID validation (simple and scoped formats)
 * - Version validation (semver)
 * - Capability validation and normalization
 * - Hook resolution (function vs config object)
 * - Default value handling
 */

import { describe, it, expect, vi } from "vitest";

import { definePlugin } from "../../../src/plugins/define-plugin.js";

// Error message patterns for test assertions
const INVALID_PLUGIN_ID_PATTERN = /Invalid plugin id/;
const INVALID_PLUGIN_VERSION_PATTERN = /Invalid plugin version/;
const INVALID_CAPABILITY_PATTERN = /Invalid capability/;

describe("definePlugin", () => {
	describe("ID validation", () => {
		it("accepts valid simple ID", () => {
			const plugin = definePlugin({
				id: "my-plugin",
				version: "1.0.0",
			});

			expect(plugin.id).toBe("my-plugin");
		});

		it("accepts valid simple ID with numbers", () => {
			const plugin = definePlugin({
				id: "plugin-v2",
				version: "1.0.0",
			});

			expect(plugin.id).toBe("plugin-v2");
		});

		it("accepts valid scoped ID", () => {
			const plugin = definePlugin({
				id: "@emdash-cms/seo-plugin",
				version: "1.0.0",
			});

			expect(plugin.id).toBe("@emdash-cms/seo-plugin");
		});

		it("accepts scoped ID with numbers", () => {
			const plugin = definePlugin({
				id: "@my-org/plugin-v2",
				version: "1.0.0",
			});

			expect(plugin.id).toBe("@my-org/plugin-v2");
		});

		it("rejects ID with uppercase letters", () => {
			expect(() =>
				definePlugin({
					id: "MyPlugin",
					version: "1.0.0",
				}),
			).toThrow(INVALID_PLUGIN_ID_PATTERN);
		});

		it("rejects ID with underscores", () => {
			expect(() =>
				definePlugin({
					id: "my_plugin",
					version: "1.0.0",
				}),
			).toThrow(INVALID_PLUGIN_ID_PATTERN);
		});

		it("rejects ID with spaces", () => {
			expect(() =>
				definePlugin({
					id: "my plugin",
					version: "1.0.0",
				}),
			).toThrow(INVALID_PLUGIN_ID_PATTERN);
		});

		it("rejects empty ID", () => {
			expect(() =>
				definePlugin({
					id: "",
					version: "1.0.0",
				}),
			).toThrow(INVALID_PLUGIN_ID_PATTERN);
		});

		it("rejects invalid scoped ID (missing name)", () => {
			expect(() =>
				definePlugin({
					id: "@my-org/",
					version: "1.0.0",
				}),
			).toThrow(INVALID_PLUGIN_ID_PATTERN);
		});

		it("rejects invalid scoped ID (missing scope)", () => {
			expect(() =>
				definePlugin({
					id: "@/my-plugin",
					version: "1.0.0",
				}),
			).toThrow(INVALID_PLUGIN_ID_PATTERN);
		});
	});

	describe("version validation", () => {
		it("accepts valid semver", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
			});

			expect(plugin.version).toBe("1.0.0");
		});

		it("accepts semver with prerelease", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0-beta.1",
			});

			expect(plugin.version).toBe("1.0.0-beta.1");
		});

		it("accepts semver with build metadata", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0+build.123",
			});

			expect(plugin.version).toBe("1.0.0+build.123");
		});

		it("rejects invalid version format", () => {
			expect(() =>
				definePlugin({
					id: "test",
					version: "1.0",
				}),
			).toThrow(INVALID_PLUGIN_VERSION_PATTERN);
		});

		it("rejects non-numeric version", () => {
			expect(() =>
				definePlugin({
					id: "test",
					version: "latest",
				}),
			).toThrow(INVALID_PLUGIN_VERSION_PATTERN);
		});
	});

	describe("capability validation", () => {
		it("accepts valid capabilities", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				capabilities: ["read:content", "write:content", "network:fetch"],
			});

			expect(plugin.capabilities).toContain("read:content");
			expect(plugin.capabilities).toContain("write:content");
			expect(plugin.capabilities).toContain("network:fetch");
		});

		it("accepts read:media and write:media", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				capabilities: ["read:media", "write:media"],
			});

			expect(plugin.capabilities).toContain("read:media");
			expect(plugin.capabilities).toContain("write:media");
		});

		it("rejects invalid capability", () => {
			expect(() =>
				definePlugin({
					id: "test",
					version: "1.0.0",
					capabilities: ["invalid:capability" as any],
				}),
			).toThrow(INVALID_CAPABILITY_PATTERN);
		});

		it("normalizes write:content to include read:content", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				capabilities: ["write:content"],
			});

			expect(plugin.capabilities).toContain("write:content");
			expect(plugin.capabilities).toContain("read:content");
		});

		it("normalizes write:media to include read:media", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				capabilities: ["write:media"],
			});

			expect(plugin.capabilities).toContain("write:media");
			expect(plugin.capabilities).toContain("read:media");
		});

		it("does not duplicate read when already present", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				capabilities: ["read:content", "write:content"],
			});

			const readCount = plugin.capabilities.filter((c) => c === "read:content").length;
			expect(readCount).toBe(1);
		});

		it("defaults to empty capabilities", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
			});

			expect(plugin.capabilities).toEqual([]);
		});
	});

	describe("hook resolution", () => {
		it("resolves function shorthand to full config", () => {
			const handler = vi.fn();
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				hooks: {
					"content:beforeSave": handler,
				},
			});

			const hook = plugin.hooks["content:beforeSave"];
			expect(hook).toBeDefined();
			expect(hook!.handler).toBe(handler);
			expect(hook!.priority).toBe(100);
			expect(hook!.timeout).toBe(5000);
			expect(hook!.dependencies).toEqual([]);
			expect(hook!.errorPolicy).toBe("abort");
			expect(hook!.pluginId).toBe("test");
		});

		it("resolves full config object", () => {
			const handler = vi.fn();
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				hooks: {
					"content:beforeSave": {
						handler,
						priority: 50,
						timeout: 10000,
						dependencies: ["other-plugin"],
						errorPolicy: "continue",
					},
				},
			});

			const hook = plugin.hooks["content:beforeSave"];
			expect(hook).toBeDefined();
			expect(hook!.handler).toBe(handler);
			expect(hook!.priority).toBe(50);
			expect(hook!.timeout).toBe(10000);
			expect(hook!.dependencies).toEqual(["other-plugin"]);
			expect(hook!.errorPolicy).toBe("continue");
		});

		it("applies defaults to partial config", () => {
			const handler = vi.fn();
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				hooks: {
					"content:afterSave": {
						handler,
						priority: 200,
						// timeout, dependencies, errorPolicy use defaults
					},
				},
			});

			const hook = plugin.hooks["content:afterSave"];
			expect(hook!.priority).toBe(200);
			expect(hook!.timeout).toBe(5000);
			expect(hook!.dependencies).toEqual([]);
			expect(hook!.errorPolicy).toBe("abort");
		});

		it("resolves multiple hooks", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				hooks: {
					"content:beforeSave": vi.fn(),
					"content:afterSave": vi.fn(),
					"plugin:install": vi.fn(),
					"email:status": vi.fn(async () => true),
				},
			});

			expect(plugin.hooks["content:beforeSave"]).toBeDefined();
			expect(plugin.hooks["content:afterSave"]).toBeDefined();
			expect(plugin.hooks["plugin:install"]).toBeDefined();
			expect(plugin.hooks["email:status"]).toBeDefined();
		});

		it("sets pluginId on all resolved hooks", () => {
			const plugin = definePlugin({
				id: "my-plugin",
				version: "1.0.0",
				hooks: {
					"content:beforeSave": vi.fn(),
					"media:afterUpload": { handler: vi.fn(), priority: 50 },
				},
			});

			expect(plugin.hooks["content:beforeSave"]!.pluginId).toBe("my-plugin");
			expect(plugin.hooks["media:afterUpload"]!.pluginId).toBe("my-plugin");
		});
	});

	describe("default values", () => {
		it("defaults allowedHosts to empty array", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
			});

			expect(plugin.allowedHosts).toEqual([]);
		});

		it("defaults storage to empty object", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
			});

			expect(plugin.storage).toEqual({});
		});

		it("defaults hooks to empty object", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
			});

			expect(plugin.hooks).toEqual({});
		});

		it("defaults routes to empty object", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
			});

			expect(plugin.routes).toEqual({});
		});

		it("preserves provided allowedHosts", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				allowedHosts: ["api.example.com", "*.cdn.com"],
			});

			expect(plugin.allowedHosts).toEqual(["api.example.com", "*.cdn.com"]);
		});

		it("preserves provided storage config", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				storage: {
					items: { indexes: ["type", "status"] },
					cache: { indexes: ["key"] },
				},
			});

			expect(plugin.storage).toEqual({
				items: { indexes: ["type", "status"] },
				cache: { indexes: ["key"] },
			});
		});
	});

	describe("routes passthrough", () => {
		it("preserves route definitions", () => {
			const handler = vi.fn();
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				routes: {
					sync: { handler },
					webhook: { handler, input: {} as any },
				},
			});

			expect(plugin.routes.sync).toBeDefined();
			expect(plugin.routes.sync.handler).toBe(handler);
			expect(plugin.routes.webhook).toBeDefined();
		});
	});

	describe("admin passthrough", () => {
		it("preserves admin config", () => {
			const plugin = definePlugin({
				id: "test",
				version: "1.0.0",
				admin: {
					entry: "@test/plugin/admin",
					pages: [{ id: "settings", title: "Settings" }],
					widgets: [{ id: "stats", title: "Stats", area: "dashboard" }],
				},
			});

			expect(plugin.admin.entry).toBe("@test/plugin/admin");
			expect(plugin.admin.pages).toHaveLength(1);
			expect(plugin.admin.widgets).toHaveLength(1);
		});
	});
});
