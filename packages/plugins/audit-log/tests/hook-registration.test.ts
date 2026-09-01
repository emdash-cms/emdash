/**
 * Registers the real plugin definition with the real manifest's trust
 * contract, the same way a scaffolded site loads it in-process. Catches
 * the manifest and the code drifting apart: a hook declared in plugin.ts
 * whose required capability is missing from emdash-plugin.jsonc gets
 * silently skipped at registration with only a console warning.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { adaptSandboxEntry, HookPipeline, type PluginDescriptor } from "emdash";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it, vi } from "vitest";

import plugin from "../src/plugin.js";

interface Manifest {
	slug: string;
	capabilities: string[];
	allowedHosts?: string[];
	storage?: Record<string, { indexes?: string[] }>;
}

const manifest = parse(
	readFileSync(join(import.meta.dirname, "..", "emdash-plugin.jsonc"), "utf-8"),
) as Manifest;

const descriptor: PluginDescriptor = {
	id: manifest.slug,
	version: "0.0.0",
	entrypoint: "@emdash-cms/plugin-audit-log/sandbox",
	format: "standard",
	capabilities: manifest.capabilities,
	allowedHosts: manifest.allowedHosts ?? [],
	storage: manifest.storage,
};

afterEach(() => {
	vi.restoreAllMocks();
});

describe("hook registration", () => {
	it("registers every declared hook under the manifest's capabilities", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		const resolved = adaptSandboxEntry(plugin, descriptor);
		const pipeline = new HookPipeline([resolved]);

		for (const hookName of Object.keys(plugin.hooks)) {
			expect
				.soft(pipeline.getHookCount(hookName as never), `${hookName} should be registered`)
				.toBe(1);
		}
		expect(warn).not.toHaveBeenCalled();
	});
});
