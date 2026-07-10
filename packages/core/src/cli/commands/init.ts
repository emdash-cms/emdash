/**
 * emdash init
 *
 * Initialize database from template config in package.json
 */

import { readFile, access } from "node:fs/promises";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import { sql } from "kysely";

import { createDatabase } from "../../database/connection.js";
import { runMigrations } from "../../database/migrations/runner.js";

export interface EmDashConfig {
	label?: string;
	schema?: string;
	seed?: string;
}

interface PackageJson {
	name?: string;
	emdash?: EmDashConfig;
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

async function runSqlFile(db: ReturnType<typeof createDatabase>, filePath: string): Promise<void> {
	const contents = await readFile(filePath, "utf-8");

	// Remove single-line comments
	const withoutComments = contents
		.split("\n")
		.filter((line) => !line.trim().startsWith("--"))
		.join("\n");

	// Split on semicolons, filter empty statements
	const statements = withoutComments
		.split(";")
		.map((s) => s.trim())
		.filter((s) => s.length > 0);

	for (const statement of statements) {
		await db.executeQuery(sql.raw(statement).compile(db));
	}
}

/**
 * Check if database has already been initialized with template schema
 */
async function isAlreadyInitialized(db: ReturnType<typeof createDatabase>): Promise<boolean> {
	try {
		// Use raw SQL since this runs on an untyped database connection
		const result = await sql<{
			count: number;
		}>`SELECT COUNT(id) as count FROM _emdash_collections`.execute(db);
		const row = result.rows[0];
		return row ? row.count > 0 : false;
	} catch {
		// Table doesn't exist yet
		return false;
	}
}

export const initCommand = defineCommand({
	meta: {
		name: "init",
		description: "Initialize database from template config",
	},
	args: {
		database: {
			type: "string",
			alias: "d",
			description: "Database path (default: ./data.db)",
			default: "./data.db",
		},
		cwd: {
			type: "string",
			description: "Working directory",
			default: process.cwd(),
		},
		force: {
			type: "boolean",
			alias: "f",
			description: "Force re-initialization",
			default: false,
		},
	},
	async run({ args }) {
		const cwd = resolve(args.cwd);
		consola.start("Initializing EmDash...");

		// 1. Read package.json
		const pkg = await readPackageJson(cwd);
		if (!pkg) {
			consola.error("No package.json found in", cwd);
			process.exit(1);
		}

		const config = pkg.emdash;
		consola.info(`Project: ${pkg.name || "unknown"}`);

		if (config?.label) {
			consola.info(`Template: ${config.label}`);
		}

		// 2. Create/connect to database
		const dbPath = resolve(cwd, args.database);
		consola.info(`Database: ${dbPath}`);

		const db = createDatabase({ url: `file:${dbPath}` });

		// 3. Run core migrations (always run - they're idempotent)
		consola.start("Running migrations...");
		try {
			const { applied } = await runMigrations(db);
			if (applied.length > 0) {
				consola.success(`Applied ${applied.length} migrations`);
				for (const name of applied) {
					consola.info(`  - ${name}`);
				}
			} else {
				consola.info("Migrations already up to date");
			}
		} catch (error) {
			consola.error("Migration failed:", error);
			await db.destroy();
			process.exit(1);
		}

		// 4. Check if already initialized (has collections)
		const alreadyInitialized = await isAlreadyInitialized(db);
		if (alreadyInitialized && !args.force) {
			await db.destroy();
			consola.success("Already initialized. Use --force to re-run schema/seed.");
			return;
		}

		if (alreadyInitialized && args.force) {
			consola.warn("Re-initializing (--force)...");
		}

		// 5. Run template schema.sql if present
		if (config?.schema) {
			const schemaPath = resolve(cwd, config.schema);
			if (await fileExists(schemaPath)) {
				consola.start(`Running schema: ${config.schema}`);
				try {
					await runSqlFile(db, schemaPath);
					consola.success("Schema applied");
				} catch (error) {
					consola.error("Schema failed:", error);
					await db.destroy();
					process.exit(1);
				}
			} else {
				consola.warn(`Schema file not found: ${config.schema}`);
			}
		}

		// 6. JSON seed files are now handled by `emdash seed` command
		// The bootstrap script runs `emdash init && emdash seed`
		// Legacy SQL seed files (seed.sql) could be handled here if needed

		await db.destroy();
		consola.success("EmDash initialized successfully!");
		consola.info("Run `pnpm dev` to start the development server");
	},
});
