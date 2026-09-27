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

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, it, expect, vi } from "vitest";
import { z } from "zod";

import type { PluginDescriptor } from "../../../src/astro/integration/runtime.js";
import { generatePluginsModule } from "../../../src/astro/integration/virtual-modules.js";
import { definePlugin } from "../../../src/plugins/define-plugin.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";

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

	it("throws an actionable error when a descriptor has no entrypoint (issue #1416)", () => {
		// In-process plugins -- an inline `definePlugin({...})` result passed
		// directly to `plugins: []` -- have no file entrypoint. The generator
		// used to emit `import pluginDef0 from "undefined";`, which failed deep
		// in Rollup with `failed to resolve import "undefined"`. It must instead
		// fail fast with a message that names the offending plugin and explains
		// the constraint. (The type bypass mirrors the reporter's scenario: a
		// `PluginDescriptor` whose required `entrypoint` is missing at runtime.)
		const descriptors = [
			{
				id: "misarico-resend-email",
				version: "0.0.0",
				capabilities: ["hooks.email-transport:register"],
			},
		] as unknown as PluginDescriptor[];

		let error: Error | undefined;
		try {
			generatePluginsModule(descriptors);
		} catch (e) {
			error = e as Error;
		}

		expect(error).toBeDefined();
		expect(error!.message).toContain("misarico-resend-email");
		expect(error!.message).toMatch(/entrypoint/i);
		// The cryptic failure mode must be gone.
		expect(error!.message).not.toContain('"undefined"');
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

describe("generatePluginsModule() for a built standard plugin", () => {
	let dir: string;

	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), "emdash-plugins-module-"));
	});

	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it("registers the MCP tools its descriptor declares", async () => {
		// `emdash-plugin build` drops `mcp` from the runtime module and ships
		// the tools as JSON Schema in the descriptor instead.
		const entrypoint = join(dir, "plugin.mjs");
		await writeFile(
			entrypoint,
			`export default { routes: { "events/list": { permission: "content:read", handler: async () => ({ items: [] }) } } };`,
		);
		const code = generatePluginsModule([
			{
				id: "events",
				version: "1.0.0",
				entrypoint,
				format: "standard",
				mcp: {
					tools: [
						{
							name: "list_events",
							description: "List upcoming events.",
							route: "events/list",
							permission: "content:read",
							destructive: false,
							inputSchema: z.toJSONSchema(z.object({ limit: z.number().int().max(50) }), {
								target: "draft-7",
							}),
							outputSchema: z.toJSONSchema(z.object({ items: z.array(z.string()) }), {
								target: "draft-7",
							}),
						},
					],
				},
			},
		]);
		const adapter = fileURLToPath(
			new URL("../../../src/plugins/adapt-sandbox-entry.ts", import.meta.url),
		);
		const module = join(dir, "plugins.mjs");
		await writeFile(module, code.replace("emdash/plugins/adapt-sandbox-entry", adapter));

		const { plugins } = (await import(module)) as { plugins: ResolvedPlugin[] };
		const tool = plugins[0]!.mcp?.tools.list_events;

		expect(tool).toMatchObject({
			description: "List upcoming events.",
			route: "events/list",
			destructive: false,
		});
		expect(tool!.input.safeParse({ limit: 10 }).success).toBe(true);
		expect(tool!.input.safeParse({ limit: 500 }).success).toBe(false);
		expect(tool!.output?.safeParse({ items: [] }).success).toBe(true);
		expect(tool!.output?.safeParse({ items: [1] }).success).toBe(false);
	});
});
