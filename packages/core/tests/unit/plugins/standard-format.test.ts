/**
 * Standard (sandboxed) plugin format tests.
 *
 * Covers the runtime + integration side of sandboxed plugins:
 *
 *   - `definePlugin` rejects sandboxed-shape input (missing `id`)
 *     with a helpful message pointing at the new `satisfies
 *     SandboxedPlugin` pattern. The type system catches this at
 *     compile time too; this is the bypass-the-type-system runtime
 *     check.
 *   - `generatePluginsModule` emits the right import + adapter call
 *     for sandboxed (`format: "standard"`) plugins vs the native
 *     `createPlugin` call for native plugins.
 *
 * Authoring-side tests for `SandboxedPlugin` live next to the
 * plugin-types module — strictness of the mapped type is verified
 * there.
 */

import { describe, it, expect, vi } from "vitest";

import type { PluginDescriptor } from "../../../src/astro/integration/runtime.js";
import { generatePluginsModule } from "../../../src/astro/integration/virtual-modules.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";

describe("definePlugin()", () => {
	it("returns a resolved native plugin for input with id + version", () => {
		const handler = vi.fn();
		const result = definePlugin({
			id: "native-plugin",
			version: "1.0.0",
			hooks: {
				"content:beforeSave": handler,
			},
		});

		expect(result.id).toBe("native-plugin");
		expect(result.version).toBe("1.0.0");
		expect(result.hooks["content:beforeSave"]).toBeDefined();
		expect(result.hooks["content:beforeSave"]!.pluginId).toBe("native-plugin");
	});

	it("throws when called without an id (sandboxed-shape input)", () => {
		// The type system rejects this at compile time. At runtime,
		// callers who bypass typechecking get a clear pointer at the
		// sandboxed authoring flow.
		expect(() =>
			// eslint-disable-next-line @typescript-eslint/no-explicit-any -- intentional type bypass for runtime check coverage
			definePlugin({ hooks: {} } as any),
		).toThrow(/SandboxedPlugin/);
	});

	it("throws when id is the empty string", () => {
		expect(() =>
			definePlugin({
				id: "",
				version: "1.0.0",
			}),
		).toThrow(/requires `id`/);
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
