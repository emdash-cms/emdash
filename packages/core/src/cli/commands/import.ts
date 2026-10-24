/**
 * emdash import
 *
 * Convert content exported from another CMS into files on disk
 */

import { access } from "node:fs/promises";
import { join, resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { executeWordPressImport, prepareWordPressImport } from "./import/wordpress.js";

const wordpressCommand = defineCommand({
	meta: {
		name: "wordpress",
		description: "Convert a WordPress WXR export into JSON files",
	},
	args: {
		file: {
			type: "positional",
			description: "Path to the WordPress export (WXR) file",
			required: true,
		},
		prepare: {
			type: "boolean",
			description: "Analyze the export and write a migration config (default)",
		},
		execute: {
			type: "boolean",
			description: "Convert content using the migration config",
			default: false,
		},
		resume: {
			type: "boolean",
			description: "Continue an interrupted --execute run, skipping items already converted",
			default: false,
		},
		"output-dir": {
			type: "string",
			alias: "o",
			description: "Directory for the config, converted files, and progress",
			default: "./wordpress-import",
		},
		config: {
			type: "string",
			description: "Migration config path (default: <output-dir>/migration-config.json)",
		},
		"media-dir": {
			type: "string",
			description: "Directory for downloaded media (default: <output-dir>/media)",
		},
		"skip-media": {
			type: "boolean",
			description: "Do not download attachments",
			default: false,
		},
		"dry-run": {
			type: "boolean",
			description: "Report what would be written without writing files",
			default: false,
		},
		verbose: {
			type: "boolean",
			alias: "v",
			description: "Log each converted item",
			default: false,
		},
		json: {
			type: "boolean",
			description: "Print the result as JSON",
			default: false,
		},
	},
	async run({ args }) {
		const execute = args.execute || args.resume;
		if (args.prepare && execute) {
			consola.error("--prepare cannot be combined with --execute or --resume");
			process.exitCode = 1;
			return;
		}

		const filePath = resolve(args.file);
		try {
			await access(filePath);
		} catch {
			consola.error(`Export file not found: ${args.file}`);
			process.exitCode = 1;
			return;
		}

		const outputDir = resolve(args["output-dir"]);
		const configPath = resolve(args.config ?? join(outputDir, "migration-config.json"));

		try {
			const result = execute
				? await executeWordPressImport(filePath, {
						outputDir,
						configPath,
						mediaDir: resolve(args["media-dir"] ?? join(outputDir, "media")),
						skipMedia: args["skip-media"],
						resume: args.resume,
						dryRun: args["dry-run"],
						verbose: args.verbose,
						json: args.json,
					})
				: await prepareWordPressImport(filePath, {
						outputDir,
						configPath,
						dryRun: args["dry-run"],
						verbose: args.verbose,
						json: args.json,
					});
			if (!result.success || result.errors.length > 0) {
				process.exitCode = 1;
			}
		} catch (error) {
			consola.error(error instanceof Error ? error.message : error);
			process.exitCode = 1;
		}
	},
});

export const importCommand = defineCommand({
	meta: {
		name: "import",
		description: "Convert content from another CMS",
	},
	subCommands: {
		wordpress: wordpressCommand,
	},
});
