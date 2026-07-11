/**
 * Regression test for #1263: the audit-log plugin's manifest must keep
 * declaring every capability its registered hooks require. The hook
 * pipeline silently skips hooks whose capability is missing, so an
 * under-declaring manifest doesn't fail loudly — audit entries just
 * stop being written.
 *
 * Instead of hardcoding the hook → capability map, this test feeds the
 * real manifest capabilities and the real hook names from the plugin
 * source into HookPipeline and asserts nothing gets skipped.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it, vi } from "vitest";

import { HookPipeline } from "../../../src/plugins/hooks.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";

const PLUGIN_DIR = join(__dirname, "../../../../plugins/audit-log");

/**
 * Parse the JSONC manifest. Good enough for this manifest's shape
 * (comments and trailing commas, no `//` inside string values other
 * than after `:` as in URLs); the real loader in plugin-cli uses
 * jsonc-parser, which isn't a core dependency.
 */
function loadManifest(): { capabilities: string[] } {
	const raw = readFileSync(join(PLUGIN_DIR, "emdash-plugin.jsonc"), "utf8");
	const withoutComments = raw
		.replace(/\/\*[\s\S]*?\*\//g, "")
		.replace(/^\s*\/\/.*$/gm, "")
		.replace(/([^:"])\/\/.*$/gm, "$1")
		.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(withoutComments) as { capabilities: string[] };
}

/** Hook names the plugin actually registers, from its default export. */
async function loadHookNames(): Promise<string[]> {
	const mod = (await import(join(PLUGIN_DIR, "src/plugin.ts"))) as {
		default: { hooks: Record<string, unknown> };
	};
	return Object.keys(mod.default.hooks);
}

describe("audit-log manifest capabilities (#1263)", () => {
	it("declares every capability its registered hooks require", async () => {
		const manifest = loadManifest();
		const hookNames = await loadHookNames();

		// Sanity: the hooks this regression is about are actually registered.
		expect(hookNames).toContain("content:beforeSave");
		expect(hookNames).toContain("media:afterUpload");

		const plugin: ResolvedPlugin = {
			id: "audit-log",
			version: "0.0.0-test",
			capabilities: manifest.capabilities as ResolvedPlugin["capabilities"],
			allowedHosts: [],
			storage: {},
			admin: { pages: [], widgets: [] },
			hooks: Object.fromEntries(
				hookNames.map((name) => [
					name,
					{ pluginId: "audit-log", handler: vi.fn(), priority: 10, dependencies: [] },
				]),
			) as ResolvedPlugin["hooks"],
			routes: {},
		};

		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		try {
			const pipeline = new HookPipeline([plugin]);
			const registered = pipeline.getRegisteredHooks();

			// Every hook the plugin declares must survive registration —
			// a skipped hook means the manifest under-declares capabilities.
			for (const name of hookNames) {
				expect(registered, `hook "${name}" was skipped`).toContain(name);
			}
			const skips = warn.mock.calls.filter(([msg]) => String(msg).includes("without"));
			expect(skips).toEqual([]);
		} finally {
			warn.mockRestore();
		}
	});
});
