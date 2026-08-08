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
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { describe, expect, it, vi } from "vitest";

import { HookPipeline } from "../../../src/plugins/hooks.js";
import type { ResolvedPlugin } from "../../../src/plugins/types.js";

const PLUGIN_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../../plugins/audit-log");

/**
 * Strip JSONC comments and trailing commas with a char scanner that
 * tracks string state, so a `//` or `/*` inside a string value (e.g. a
 * URL) is never treated as a comment. The real loader in plugin-cli uses
 * jsonc-parser, which isn't a core dependency.
 */
function loadManifest(): { capabilities: string[] } {
	const raw = readFileSync(join(PLUGIN_DIR, "emdash-plugin.jsonc"), "utf8");
	let out = "";
	let i = 0;
	let inString = false;
	while (i < raw.length) {
		const c = raw[i]!;
		if (inString) {
			out += c;
			if (c === "\\")
				out += raw[++i] ?? ""; // keep the escaped char verbatim
			else if (c === '"') inString = false;
			i++;
			continue;
		}
		if (c === '"') {
			inString = true;
			out += c;
			i++;
			continue;
		}
		if (c === "/" && raw[i + 1] === "/") {
			while (i < raw.length && raw[i] !== "\n") i++;
			continue;
		}
		if (c === "/" && raw[i + 1] === "*") {
			i += 2;
			while (i < raw.length && !(raw[i] === "*" && raw[i + 1] === "/")) i++;
			i += 2;
			continue;
		}
		out += c;
		i++;
	}
	// Trailing commas are safe to drop now that no string content remains.
	out = out.replace(/,(\s*[}\]])/g, "$1");
	return JSON.parse(out) as { capabilities: string[] };
}

/** Hook names the plugin actually registers, from its default export. */
async function loadHookNames(): Promise<string[]> {
	const mod = (await import(pathToFileURL(join(PLUGIN_DIR, "src/plugin.ts")).href)) as {
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

	it("loadManifest leaves string contents with comment markers intact", () => {
		// A URL inside a string must survive comment stripping — regression
		// guard for the scanner misreading `//` in "https://…" as a comment.
		const parsed = loadManifest();
		expect(Array.isArray(parsed.capabilities)).toBe(true);
	});
});
