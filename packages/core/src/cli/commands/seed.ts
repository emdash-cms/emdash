/**
 * emdash seed
 *
 * Apply a seed file to the database
 */

import { readFile, access, mkdir } from "node:fs/promises";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { createDatabase } from "../../database/connection.js";
import { runMigrations } from "../../database/migrations/runner.js";
import { applySeed } from "../../seed/apply.js";
import type { SeedFile, SeedApplyOptions } from "../../seed/types.js";
import { validateSeed } from "../../seed/validate.js";
import { LocalStorage } from "../../storage/local.js";

interface PackageJson {
	name?: string;
	emdash?: {
		seed?: string;
	};
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

async function readPackageJson(cwd: string): Promise<PackageJson | null> {
	const pkgPath = resolve(cwd, "package.json");
	try {
		const content = await readFile(pkgPath, "utf-8");
		return JSON.parse(content);
	} catch {
		return null;
	}
}

/**
 * Resolve seed file path from:
 * 1. Positional argument (if provided)
 * 2. .emdash/seed.json (convention)
 * 3. package.json emdash.seed (config)
 */
async function resolveSeedPath(cwd: string, positional?: string): Promise<string | null> {
	// 1. Positional argument
	if (positional) {
		const resolved = resolve(cwd, positional);
		if (await fileExists(resolved)) {
			return resolved;
		}
		consola.error(`Seed file not found: ${positional}`);
		return null;
	}

	// 2. Convention: .emdash/seed.json
	const conventionPath = resolve(cwd, ".emdash", "seed.json");
	if (await fileExists(conventionPath)) {
		return conventionPath;
	}

	// 3. package.json emdash.seed
	const pkg = await readPackageJson(cwd);
	if (pkg?.emdash?.seed) {
		const pkgSeedPath = resolve(cwd, pkg.emdash.seed);
		if (await fileExists(pkgSeedPath)) {
			return pkgSeedPath;
		}
		consola.warn(`Seed file from package.json not found: ${pkg.emdash.seed}`);
	}

	return null;
}

export const seedCommand = defineCommand({
	meta: {
		name: "seed",
		description: "Apply a seed file to the database",
	},
	args: {
		path: {
			type: "positional",
			description: "Path to seed file (default: .emdash/seed.json)",
			required: false,
		},
		database: {
			type: "string",
			alias: "d",
			description: "Database path",
			default: "./data.db",
		},
		cwd: {
			type: "string",
			description: "Working directory",
			default: process.cwd(),
		},
		validate: {
			type: "boolean",
			description: "Validate only, don't apply",
			default: false,
		},
		"no-content": {
			type: "boolean",
			description: "Skip sample content",
			default: false,
		},
		"on-conflict": {
			type: "string",
			description: "Conflict handling: skip, update, error",
			default: "skip",
		},
		"uploads-dir": {
			type: "string",
			description: "Directory for media uploads",
			default: "./uploads",
		},
		"media-base-url": {
			type: "string",
			description: "Base URL for media files",
			default: "/_emdash/api/media/file",
		},
	},
	async run({ args }) {
		const cwd = resolve(args.cwd);
		consola.start("Loading seed file...");

		// Resolve seed file path
		const seedPath = await resolveSeedPath(cwd, args.path);
		if (!seedPath) {
			consola.error("No seed file found");
			consola.info("Provide a path, create .emdash/seed.json, or set emdash.seed in package.json");
			process.exit(1);
		}

		consola.info(`Seed file: ${seedPath}`);

		// Load and parse seed file
		let seed: SeedFile;
		try {
			const content = await readFile(seedPath, "utf-8");
			seed = JSON.parse(content);
		} catch (error) {
			consola.error("Failed to parse seed file:", error);
			process.exit(1);
		}

		// Validate seed
		consola.start("Validating seed file...");
		const validation = validateSeed(seed);

		if (validation.warnings.length > 0) {
			for (const warning of validation.warnings) {
				consola.warn(warning);
			}
		}

		if (!validation.valid) {
			consola.error("Seed validation failed:");
			for (const error of validation.errors) {
				consola.error(`  - ${error}`);
			}
			process.exit(1);
		}

		consola.success("Seed file is valid");

		// If validate-only mode, exit here
		if (args.validate) {
			consola.success("Validation complete");
			return;
		}

		// Connect to database
		const dbPath = resolve(cwd, args.database);
		consola.info(`Database: ${dbPath}`);

		const db = createDatabase({ url: `file:${dbPath}` });

		// Run migrations
		consola.start("Running migrations...");
		try {
			const { applied } = await runMigrations(db);
			if (applied.length > 0) {
				consola.success(`Applied ${applied.length} migrations`);
			} else {
				consola.info("Database up to date");
			}
		} catch (error) {
			consola.error("Migration failed:", error);
			await db.destroy();
			process.exit(1);
		}

		// Set up storage for $media resolution
		const uploadsDir = resolve(cwd, args["uploads-dir"]);
		await mkdir(uploadsDir, { recursive: true });

		const storage = new LocalStorage({
			directory: uploadsDir,
			baseUrl: args["media-base-url"],
		});

		// Prepare apply options
		const onConflictRaw = args["on-conflict"];
		if (onConflictRaw !== "skip" && onConflictRaw !== "update" && onConflictRaw !== "error") {
			consola.error(`Invalid --on-conflict value: ${onConflictRaw}`);
			consola.info("Use: skip, update, or error");
			await db.destroy();
			process.exit(1);
		}

		const options: SeedApplyOptions = {
			includeContent: !args["no-content"],
			onConflict: onConflictRaw,
			storage,
		};

		// Apply seed
		consola.start("Applying seed...");
		try {
			const result = await applySeed(db, seed, options);

			consola.success("Seed applied successfully!");
			consola.log("");

			// Print summary
			if (result.settings.applied > 0) {
				consola.info(`Settings: ${result.settings.applied} applied`);
			}
			if (
				result.collections.created > 0 ||
				result.collections.skipped > 0 ||
				result.collections.updated > 0
			) {
				consola.info(
					`Collections: ${result.collections.created} created, ${result.collections.skipped} skipped, ${result.collections.updated} updated`,
				);
			}
			if (result.fields.created > 0 || result.fields.skipped > 0 || result.fields.updated > 0) {
				consola.info(
					`Fields: ${result.fields.created} created, ${result.fields.skipped} skipped, ${result.fields.updated} updated`,
				);
			}
			if (result.taxonomies.created > 0 || result.taxonomies.terms > 0) {
				consola.info(
					`Taxonomies: ${result.taxonomies.created} created, ${result.taxonomies.terms} terms`,
				);
			}
			if (result.bylines.created > 0 || result.bylines.skipped > 0 || result.bylines.updated > 0) {
				consola.info(
					`Bylines: ${result.bylines.created} created, ${result.bylines.skipped} skipped, ${result.bylines.updated} updated`,
				);
			}
			if (result.menus.created > 0 || result.menus.items > 0) {
				consola.info(`Menus: ${result.menus.created} created, ${result.menus.items} items`);
			}
			if (result.widgetAreas.created > 0 || result.widgetAreas.widgets > 0) {
				consola.info(
					`Widget Areas: ${result.widgetAreas.created} created, ${result.widgetAreas.widgets} widgets`,
				);
			}
			if (result.content.created > 0 || result.content.skipped > 0 || result.content.updated > 0) {
				consola.info(
					`Content: ${result.content.created} created, ${result.content.skipped} skipped, ${result.content.updated} updated`,
				);
			}
			if (result.media.created > 0 || result.media.skipped > 0) {
				consola.info(`Media: ${result.media.created} created, ${result.media.skipped} skipped`);
			}

			// If schema changed and a dev server is already running, its
			// in-memory manifest cache is stale until the next restart.
			// applySeed clears the DB-persisted cache so a fresh process
			// picks up the new schema, but it can't reach a live process.
			// See #776.
			const schemaChanged =
				result.collections.created > 0 ||
				result.collections.updated > 0 ||
				result.fields.created > 0 ||
				result.fields.updated > 0 ||
				result.taxonomies.created > 0;
			if (schemaChanged) {
				consola.info("Schema changed -- restart your dev server to pick up the new manifest");
			}
		} catch (error) {
			consola.error("Seed failed:", error instanceof Error ? error.message : error);
			await db.destroy();
			process.exit(1);
		}

		await db.destroy();
		consola.success("Done!");
	},
});
