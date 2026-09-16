import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { buildPlugin } from "@emdash-cms/plugin-cli";
import type { Plugin } from "vite";

export interface EmDashPluginTestOptions {
	/** Plugin source directory. Defaults to the current working directory. */
	dir?: string;
}

/**
 * Configure Vitest to build a sandboxed plugin and run tests inside workerd.
 */
export function emdashPluginTest(options: EmDashPluginTestOptions = {}): Plugin {
	const pluginDir = resolve(options.dir ?? process.cwd());
	const workerEntry = fileURLToPath(
		new URL(import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.mjs", import.meta.url),
	);

	return cloudflareTest(async () => {
		const build = await buildPlugin({ dir: pluginDir });
		const [code, manifest] = await Promise.all([
			readFile(build.files.runtime, "utf8"),
			readFile(build.files.manifestJson, "utf8"),
		]);

		return {
			main: workerEntry,
			remoteBindings: false,
			additionalExports: { PluginBridge: "WorkerEntrypoint" },
			miniflare: {
				compatibilityDate: "2026-08-20",
				compatibilityFlags: ["nodejs_compat"],
				d1Databases: ["DB"],
				workerLoaders: { LOADER: {} },
				bindings: {
					EMDASH_PLUGIN_CODE: code,
					EMDASH_PLUGIN_MANIFEST: manifest,
				},
			},
		};
	});
}
