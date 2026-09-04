/**
 * `emdash-plugin bundle`
 *
 * Thin citty wrapper around `bundlePlugin` from `./api.js`. The interesting
 * logic lives there; this file only handles arg parsing, consola formatting,
 * and process exit on errors so the rest of the CLI can `await` it cleanly.
 *
 * If you're building tooling on top of bundling, import `bundlePlugin`
 * directly -- this command is the terminal-output adapter, not the API.
 */

import { defineCommand } from "citty";
import consola from "consola";
import pc from "picocolors";

import { BundleError, bundlePlugin, type BundleLogger } from "./api.js";

export const bundleCommand = defineCommand({
	meta: {
		name: "bundle",
		description: "Bundle a plugin for marketplace distribution",
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
			description: "Output directory for the tarball (default: ./dist)",
			default: "dist",
		},
		"validate-only": {
			type: "boolean",
			description: "Run validation only, skip tarball creation",
			default: false,
		},
	},
	async run({ args }) {
		const logger: BundleLogger = {
			start: (m) => consola.start(m),
			info: (m) => consola.info(m),
			success: (m) => consola.success(m),
			warn: (m) => consola.warn(m),
		};

		let result;
		try {
			result = await bundlePlugin({
				dir: args.dir,
				outDir: args["out-dir"],
				validateOnly: args["validate-only"],
				logger,
			});
		} catch (error) {
			if (error instanceof BundleError) {
				consola.error(error.message);
				process.exit(1);
			}
			throw error;
		}

		if (!args["validate-only"] && result.tarballPath) {
			console.log();
			consola.info("Publish this plugin from its source directory:");
			console.log(`  ${pc.cyan("emdash-plugin publish")}`);
			console.log(pc.dim("  Publish rebuilds the bundle and uploads it to your PDS."));
		}
	},
});
