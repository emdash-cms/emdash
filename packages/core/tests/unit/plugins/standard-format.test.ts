/**
 * Standard Plugin Format Tests
 *
 * Tests the definePlugin() standard format overload, isStandardPluginDefinition(),
 * and the generatePluginsModule() standard format handling.
 *
 */

import { describe, it, expect, vi } from "vitest";

import type { PluginDescriptor } from "../../../src/astro/integration/runtime.js";
import { generatePluginsModule } from "../../../src/astro/integration/virtual-modules.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import { isStandardPluginDefinition } from "../../../src/plugins/types.js";

describe("definePlugin() standard format overload", () => {
	it("returns the same object (identity function)", () => {
		const def = {
			hooks: {
				"content:afterSave": {
					handler: async () => {},
				},
			},
			routes: {
				status: {
					handler: async () => ({ ok: true }),
				},
			},
		};

		const result = definePlugin(def);

		// Standard format: definePlugin is an identity function
		expect(result).toBe(def);
	});

	it("accepts hooks-only definition", () => {
		const def = {
			hooks: {
				"content:beforeSave": async () => {},
			},
		};

		const result = definePlugin(def);

		expect(result).toBe(def);
		expect(result.hooks).toBeDefined();
	});

	it("accepts routes-only definition", () => {
		const def = {
			routes: {
				ping: {
					handler: async () => ({ pong: true }),
				},
			},
		};

		const result = definePlugin(def);

		expect(result).toBe(def);
		expect(result.routes).toBeDefined();
	});

	it("throws on empty definition (no hooks or routes)", () => {
		// An empty object has no id/version, so it's treated as standard format,
		// but standard format requires at least hooks or routes
		expect(() => definePlugin({})).toThrow(
			"Standard plugin format requires at least `hooks` or `routes`",
		);
	});

	it("still works with native format (id + version)", () => {
		const handler = vi.fn();
		const result = definePlugin({
			id: "native-plugin",
			version: "1.0.0",
			hooks: {
				"content:beforeSave": handler,
			},
		});

		// Native format: returns a ResolvedPlugin
		expect(result.id).toBe("native-plugin");
		expect(result.version).toBe("1.0.0");
		expect(result.hooks["content:beforeSave"]).toBeDefined();
		expect(result.hooks["content:beforeSave"]!.pluginId).toBe("native-plugin");
	});
});

describe("isStandardPluginDefinition()", () => {
	it("returns true for { hooks: {} }", () => {
		expect(isStandardPluginDefinition({ hooks: {} })).toBe(true);
	});

	it("returns true for { routes: {} }", () => {
		expect(isStandardPluginDefinition({ routes: {} })).toBe(true);
	});

	it("returns true for { hooks: {}, routes: {} }", () => {
		expect(isStandardPluginDefinition({ hooks: {}, routes: {} })).toBe(true);
	});

	it("returns false for null", () => {
		expect(isStandardPluginDefinition(null)).toBe(false);
	});

	it("returns false for undefined", () => {
		expect(isStandardPluginDefinition(undefined)).toBe(false);
	});

	it("returns false for a string", () => {
		expect(isStandardPluginDefinition("hello")).toBe(false);
	});

	it("returns false for a native plugin definition (has id + version)", () => {
		expect(
			isStandardPluginDefinition({
				id: "test",
				version: "1.0.0",
				hooks: {},
			}),
		).toBe(false);
	});

	it("returns false for an empty object (no hooks or routes)", () => {
		// Empty object has neither hooks/routes NOR id/version
		// So hasPluginShape is false
		expect(isStandardPluginDefinition({})).toBe(false);
	});
});

describe("generatePluginsModule() standard format", () => {
	it("generates adapter import for standard-format plugins", () => {
		const descriptors: PluginDescriptor[] = [
			{
				id: "my-standard-plugin",
				version: "1.0.0",
				entrypoint: "@my/standard-plugin",
				format: "standard",
			},
		];

		const code = generatePluginsModule(descriptors);

		expect(code).toContain("adaptSandboxEntry");
		expect(code).toContain('from "emdash/plugins/adapt-sandbox-entry"');
		expect(code).toContain('import pluginDef0 from "@my/standard-plugin"');
		expect(code).toContain("adaptSandboxEntry(pluginDef0");
	});

	it("generates createPlugin import for native-format plugins", () => {
		const descriptors: PluginDescriptor[] = [
			{
				id: "my-native-plugin",
				version: "1.0.0",
				entrypoint: "@my/native-plugin",
				options: { debug: true },
			},
		];

		const code = generatePluginsModule(descriptors);

		expect(code).not.toContain("adaptSandboxEntry");
		expect(code).toContain('import { createPlugin as createPlugin0 } from "@my/native-plugin"');
		expect(code).toContain('createPlugin0({"debug":true})');
	});

	it("handles mixed standard and native plugins", () => {
		const descriptors: PluginDescriptor[] = [
			{
				id: "native-plugin",
				version: "1.0.0",
				entrypoint: "@my/native-plugin",
				options: {},
			},
			{
				id: "standard-plugin",
				version: "2.0.0",
				entrypoint: "@my/standard-plugin",
				format: "standard",
				capabilities: ["content:read"],
			},
		];

		const code = generatePluginsModule(descriptors);

		// Should have the adapter import (at least one standard plugin)
		expect(code).toContain("adaptSandboxEntry");

		// Native plugin uses createPlugin
		expect(code).toContain('import { createPlugin as createPlugin0 } from "@my/native-plugin"');
		expect(code).toContain("createPlugin0(");

		// Standard plugin uses default import + adapter
		expect(code).toContain('import pluginDef1 from "@my/standard-plugin"');
		expect(code).toContain("adaptSandboxEntry(pluginDef1");
	});

	it("does not import adapter when all plugins are native", () => {
		const descriptors: PluginDescriptor[] = [
			{
				id: "native-1",
				version: "1.0.0",
				entrypoint: "@my/native-1",
				options: {},
			},
			{
				id: "native-2",
				version: "1.0.0",
				entrypoint: "@my/native-2",
				options: {},
				format: "native",
			},
		];

		const code = generatePluginsModule(descriptors);

		expect(code).not.toContain("adaptSandboxEntry");
	});

	it("returns empty plugins array for no descriptors", () => {
		const code = generatePluginsModule([]);

		expect(code).toBe("export const plugins = [];");
	});

	it("serializes descriptor metadata for standard plugins", () => {
		const descriptors: PluginDescriptor[] = [
			{
				id: "my-plugin",
				version: "1.0.0",
				entrypoint: "@my/plugin",
				format: "standard",
				capabilities: ["content:read", "network:request"],
				allowedHosts: ["api.example.com"],
				storage: { events: { indexes: ["timestamp"] } },
				adminPages: [{ path: "/settings", label: "Settings" }],
			},
		];

		const code = generatePluginsModule(descriptors);

		// The descriptor metadata should be serialized into the adapter call
		expect(code).toContain('"id":"my-plugin"');
		expect(code).toContain('"version":"1.0.0"');
		expect(code).toContain('"capabilities":["content:read","network:request"]');
		expect(code).toContain('"allowedHosts":["api.example.com"]');
		expect(code).toContain('"storage":{"events":{"indexes":["timestamp"]}}');
	});
});
