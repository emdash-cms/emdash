/**
 * `emdash-registry bundle`
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
		outDir: {
			type: "string",
			alias: "o",
			description: "Output directory for the tarball (default: ./dist)",
			default: "dist",
		},
		validateOnly: {
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
				outDir: args.outDir,
				validateOnly: args.validateOnly,
				logger,
			});
		} catch (error) {
			if (error instanceof BundleError) {
				consola.error(error.message);
				process.exit(1);
			}
			throw error;
		}

		// Bundling and publishing are two steps with a "go upload this somewhere"
		// gap between them — the registry never accepts uploads, the publisher
		// hosts the artifact (GitHub release asset, R2, S3, their own server)
		// and the registry indexes the URL. Spell out the next step so users
		// don't have to dig for it.
		if (!args.validateOnly && result.tarballPath) {
			console.log();
			consola.info("Next steps:");
			console.log(`  1. Upload ${pc.cyan(result.tarballPath)} to a public URL.`);
			console.log(
				`  2. Publish the release record:\n` +
					`     ${pc.cyan(`emdash-registry publish --url <hosted-url>`)}`,
			);
			console.log(
				`     ${pc.dim(`(or pass --local ${result.tarballPath} to verify the URL serves matching bytes before publishing)`)}`,
			);
		}
	},
});
