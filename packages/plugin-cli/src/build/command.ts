/**
 * `emdash-plugin build`
 *
 * Thin citty wrapper around `buildPlugin` from `./api.js`. Produces the
 * on-disk dist artifacts for an npm-installed sandboxed plugin:
 *
 *   - `dist/plugin.mjs` (+ `.d.mts`) — runtime bytes (hooks + routes).
 *   - `dist/index.mjs` (+ `.d.mts`) — descriptor module, bare default export.
 *   - `dist/manifest.json` — normalised manifest, kept in sync.
 *
 * Plugin authors run this from their package's `prepublishOnly` (or a
 * `pnpm build` script that delegates). Bundling for the registry (the
 * tarball form) is a separate command — see `emdash-plugin bundle`.
 */

import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { BuildError, buildPlugin, type BuildLogger } from "./api.js";

export const buildCommand = defineCommand({
	meta: {
		name: "build",
		description: "Build a sandboxed plugin's npm distribution artifacts",
	},
	args: {
		dir: {
			type: "string",
			description: "Plugin directory (default: current directory)",
			default: process.cwd(),
		},
		"out-dir": {
			type: "string",
			alias: "o",
			description: "Output directory (default: ./dist)",
			default: "dist",
		},
	},
	async run({ args }) {
		const logger: BuildLogger = {
			start: (m) => consola.start(m),
			info: (m) => consola.info(m),
			success: (m) => consola.success(m),
			warn: (m) => consola.warn(m),
		};

		let result;
		try {
			result = await buildPlugin({
				dir: args.dir,
				outDir: args["out-dir"],
				logger,
			});
		} catch (error) {
			if (error instanceof BuildError) {
				consola.error(error.message);
				process.exit(1);
			}
			throw error;
		}

		console.log();
		consola.info("Output:");
		console.log(`  ${pc.cyan(result.files.descriptor)}`);
		console.log(`  ${pc.cyan(result.files.runtime)}`);
		console.log(`  ${pc.cyan(result.files.manifestJson)}`);
	},
});
