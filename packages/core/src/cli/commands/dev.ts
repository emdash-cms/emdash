/**
 * emdash dev
 *
 * Start development server with optional schema sync from remote
 */

import { spawn } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { createDatabase } from "../../database/connection.js";
import { runMigrations } from "../../database/migrations/runner.js";

interface PackageJson {
	name?: string;
	scripts?: Record<string, string>;
	emdash?: {
		url?: string;
		database?: string;
	};
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

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

export const DEV_DEPRECATION_MESSAGE =
	"`emdash dev` is deprecated and will be removed in a future release.\n\n" +
	"Use your project's dev script instead (for example, `pnpm dev`), or run `astro dev` directly.";

export const devCommand = defineCommand({
	meta: {
		name: "dev",
		description: "Start dev server with local database",
		hidden: true,
	},
	args: {
		database: {
			type: "string",
			alias: "d",
			description: "Database path (default: ./data.db)",
			default: "./data.db",
		},
		types: {
			type: "boolean",
			alias: "t",
			description: "Generate types from remote before starting",
			default: false,
		},
		port: {
			type: "string",
			alias: "p",
			description: "Port for dev server",
			default: "4321",
		},
		cwd: {
			type: "string",
			description: "Working directory",
			default: process.cwd(),
		},
	},
	async run({ args }) {
		consola.box({
			title: "DEPRECATED COMMAND",
			message: DEV_DEPRECATION_MESSAGE,
		});

		const cwd = resolve(args.cwd);
		const pkg = await readPackageJson(cwd);

		if (!pkg) {
			consola.error("No package.json found");
			process.exit(1);
		}

		const dbPath = resolve(cwd, args.database);

		// Run migrations if database doesn't exist
		const dbExists = await fileExists(dbPath);
		if (!dbExists) {
			consola.start("Database not found, initializing...");
		}

		// Always run migrations (they're idempotent)
		const db = createDatabase({ url: `file:${dbPath}` });
		try {
			consola.start("Checking database migrations...");
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
		await db.destroy();

		// Generate types from remote if requested
		if (args.types) {
			const remoteUrl = pkg.emdash?.url || process.env.EMDASH_URL;

			if (!remoteUrl) {
				consola.warn("No remote URL configured. Set EMDASH_URL or emdash.url in package.json");
			} else {
				try {
					const { createClientFromArgs } = await import("../client-factory.js");
					const client = createClientFromArgs({ url: remoteUrl });
					const schema = await client.schemaExport();
					const types = await client.schemaTypes();

					const { mkdir, writeFile } = await import("node:fs/promises");
					const { dirname, resolve: resolvePath } = await import("node:path");
					const outputPath = resolvePath(cwd, ".emdash/types.ts");
					await mkdir(dirname(outputPath), { recursive: true });
					await writeFile(outputPath, types, "utf-8");
					await writeFile(
						resolvePath(dirname(outputPath), "schema.json"),
						JSON.stringify(schema, null, 2),
						"utf-8",
					);
					consola.success(`Generated types for ${schema.collections.length} collections`);
				} catch (error) {
					consola.warn("Type generation failed:", error instanceof Error ? error.message : error);
				}
			}
		}

		// Start Astro dev server
		consola.start("Starting Astro dev server...");

		const astroArgs = ["astro", "dev", "--port", args.port];

		// Check if using pnpm, npm, or yarn
		const pnpmLockExists = await fileExists(resolve(cwd, "pnpm-lock.yaml"));
		const yarnLockExists = await fileExists(resolve(cwd, "yarn.lock"));

		let cmd: string;
		let cmdArgs: string[];

		if (pnpmLockExists) {
			cmd = "pnpm";
			cmdArgs = astroArgs;
		} else if (yarnLockExists) {
			cmd = "yarn";
			cmdArgs = astroArgs;
		} else {
			cmd = "npx";
			cmdArgs = astroArgs;
		}

		consola.info(`Running: ${cmd} ${cmdArgs.join(" ")}`);

		const child = spawn(cmd, cmdArgs, {
			cwd,
			stdio: "inherit",
			env: {
				...process.env,
				// Pass database path to Astro
				EMDASH_DATABASE_URL: `file:${dbPath}`,
			},
		});

		child.on("error", (error) => {
			consola.error("Failed to start dev server:", error);
			process.exit(1);
		});

		child.on("exit", (code) => {
			process.exit(code ?? 0);
		});

		// Handle termination signals
		const cleanup = () => {
			child.kill("SIGTERM");
		};

		process.on("SIGINT", cleanup);
		process.on("SIGTERM", cleanup);
	},
});
