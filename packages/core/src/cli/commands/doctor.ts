/**
 * emdash doctor
 *
 * Diagnose database health (connection, migrations, schema integrity) and
 * Cloudflare Worker scheduler wiring (Cron Trigger + scheduled() handler).
 */

import { access, readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";
import { parse, printParseErrorCode, type ParseError } from "jsonc-parser";
import { parse as parseToml } from "smol-toml";

import { createDatabase } from "../../database/connection.js";
import { listTablesLike } from "../../database/dialect-helpers.js";
import { getMigrationStatus } from "../../database/migrations/runner.js";

export interface CheckResult {
	name: string;
	status: "pass" | "warn" | "fail";
	message: string;
}

const WRANGLER_CONFIG_FILES = ["wrangler.jsonc", "wrangler.json", "wrangler.toml"] as const;
const CLOUDFLARE_WORKER_MODULE = "@emdash-cms/cloudflare/worker";
const WORKER_FIX = `export { default, PluginBridge } from "${CLOUDFLARE_WORKER_MODULE}";`;
const MAIN_FIX_JSONC = `"main": "./src/worker.ts"`;
const MAIN_FIX_TOML = `main = "./src/worker.ts"`;
const TRIGGER_FIX_JSONC = `"triggers": { "crons": ["* * * * *"] }`;
const TRIGGER_FIX_TOML = `[triggers]\ncrons = ["* * * * *"]`;
const SCHEDULED_HANDLER_PATTERN = /\bscheduled\s*:\s*createScheduledHandler\s*\(/m;

function triggerFix(configPath: string): string {
	return configPath.endsWith(".toml") ? TRIGGER_FIX_TOML : TRIGGER_FIX_JSONC;
}

function mainFix(configPath: string): string {
	return configPath.endsWith(".toml") ? MAIN_FIX_TOML : MAIN_FIX_JSONC;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sourcePosition(source: string, offset: number): { line: number; column: number } {
	const prefix = source.slice(0, offset);
	return {
		line: prefix.split("\n").length,
		column: offset - prefix.lastIndexOf("\n"),
	};
}

async function findWranglerConfig(cwd: string): Promise<string | null> {
	for (const filename of WRANGLER_CONFIG_FILES) {
		const path = resolve(cwd, filename);
		if (await fileExists(path)) return path;
	}
	return null;
}

function workerExportsScheduledMaintenance(source: string): boolean {
	const modulePattern = CLOUDFLARE_WORKER_MODULE.replaceAll("/", "\\/");
	const reExportsWorker = new RegExp(
		`export\\s*\\{[^}]*\\bdefault\\b[^}]*\\}\\s*from\\s*["']${modulePattern}["']`,
		"m",
	);
	const importsFactory = new RegExp(
		`import\\s+[^;]*\\{[^}]*\\bcreateScheduledHandler\\b[^}]*\\}\\s*from\\s*["']${modulePattern}["']`,
		"m",
	);
	return (
		reExportsWorker.test(source) ||
		(importsFactory.test(source) && SCHEDULED_HANDLER_PATTERN.test(source))
	);
}

export async function checkSchedulerWiring(cwd: string): Promise<CheckResult[]> {
	const configPath = await findWranglerConfig(cwd);
	if (!configPath) return [];
	return checkSchedulerWiringAtPath(cwd, configPath);
}

async function checkSchedulerWiringAtPath(cwd: string, configPath: string): Promise<CheckResult[]> {
	const configSource = await readFile(configPath, "utf8");
	let parsed: unknown;
	if (configPath.endsWith(".toml")) {
		try {
			parsed = parseToml(configSource);
		} catch (error) {
			return [
				{
					name: "scheduler config",
					status: "fail",
					message: `could not parse ${configPath}: ${error instanceof Error ? error.message : "invalid TOML"} — fix the Wrangler configuration syntax`,
				},
			];
		}
	} else {
		const parseErrors: ParseError[] = [];
		parsed = parse(configSource, parseErrors, {
			allowTrailingComma: true,
			disallowComments: false,
		});
		if (parseErrors.length > 0) {
			const error = parseErrors[0];
			const { line, column } = sourcePosition(configSource, error.offset);
			return [
				{
					name: "scheduler config",
					status: "fail",
					message: `could not parse ${configPath}: ${printParseErrorCode(error.error)} at line ${line}, column ${column} — fix the Wrangler configuration syntax`,
				},
			];
		}
	}
	if (!isRecord(parsed)) {
		return [
			{
				name: "scheduler config",
				status: "fail",
				message: `could not parse ${configPath}: expected an object — fix the Wrangler configuration syntax`,
			},
		];
	}

	const triggers = isRecord(parsed.triggers) ? parsed.triggers : null;
	const hasCronTrigger =
		Array.isArray(triggers?.crons) &&
		triggers.crons.some((cron) => typeof cron === "string" && cron.trim().length > 0);
	const main = typeof parsed.main === "string" && parsed.main.trim() ? parsed.main : null;
	if (!main) {
		return [
			{
				name: "scheduler handler",
				status: "fail",
				message: `Wrangler configuration has no Worker entry to inspect — add ${mainFix(configPath)}, then export: ${WORKER_FIX}`,
			},
		];
	}

	const workerPath = resolve(cwd, main);
	let hasScheduledHandler = false;
	try {
		const workerSource = await readFile(workerPath, "utf8");
		hasScheduledHandler = workerExportsScheduledMaintenance(workerSource);
	} catch (error) {
		const code = isRecord(error) && typeof error.code === "string" ? error.code : null;
		if (code !== "ENOENT") {
			return [
				{
					name: "scheduler handler",
					status: "fail",
					message: `could not read Worker entry ${workerPath}: ${error instanceof Error ? error.message : "unknown I/O error"} — check the file path and permissions`,
				},
			];
		}
		return [
			{
				name: "scheduler handler",
				status: "fail",
				message: `Worker entry not found at ${workerPath} — create it with: ${WORKER_FIX}`,
			},
		];
	}

	if (hasCronTrigger && !hasScheduledHandler) {
		return [
			{
				name: "scheduler handler",
				status: "fail",
				message: `Cron Trigger is configured, but ${main} does not export EmDash scheduled() maintenance — replace its Worker export with: ${WORKER_FIX}`,
			},
		];
	}

	if (hasScheduledHandler && !hasCronTrigger) {
		return [
			{
				name: "scheduler trigger",
				status: "fail",
				message: `EmDash scheduled() handler is exported, but no Cron Trigger is configured — add this to ${configPath}: ${triggerFix(configPath)}`,
			},
		];
	}

	if (!hasCronTrigger && !hasScheduledHandler) {
		return [];
	}

	return [
		{
			name: "scheduler wiring",
			status: "pass",
			message: `Cron Trigger and scheduled() handler found (${main})`,
		},
	];
}

export async function checkDoctor(cwd: string, dbPath: string): Promise<CheckResult[]> {
	const results = await checkDatabase(dbPath);
	const configPath = await findWranglerConfig(cwd);
	if (configPath) results.push(...(await checkSchedulerWiringAtPath(cwd, configPath)));

	return results;
}

function printResult(result: CheckResult): void {
	const color =
		result.status === "pass"
			? consola.success
			: result.status === "warn"
				? consola.warn
				: consola.error;
	color(`${result.name}: ${result.message}`);
}

async function checkDatabase(dbPath: string): Promise<CheckResult[]> {
	const results: CheckResult[] = [];

	// Check database file exists
	if (!(await fileExists(dbPath))) {
		results.push({
			name: "database",
			status: "fail",
			message: `not found at ${dbPath} — run "emdash init"`,
		});
		return results;
	}

	results.push({
		name: "database",
		status: "pass",
		message: dbPath,
	});

	// Connect and check migrations
	let db;
	try {
		db = createDatabase({ url: `file:${dbPath}` });

		const { applied, pending } = await getMigrationStatus(db);
		if (pending.length === 0) {
			results.push({
				name: "migrations",
				status: "pass",
				message: `${applied.length} applied, none pending`,
			});
		} else {
			results.push({
				name: "migrations",
				status: "warn",
				message: `${applied.length} applied, ${pending.length} pending — run "emdash init"`,
			});
		}

		const { sql } = await import("kysely");

		// Check collections exist
		try {
			const collectionsResult = await sql<{
				count: number;
			}>`SELECT COUNT(id) as count FROM _emdash_collections`.execute(db);
			const count = collectionsResult.rows[0]?.count ?? 0;
			results.push({
				name: "collections",
				status: count > 0 ? "pass" : "warn",
				message:
					count > 0 ? `${count} collections defined` : "no collections — seed or create via admin",
			});
		} catch {
			results.push({
				name: "collections",
				status: "fail",
				message: "could not query collections table — migrations may not have run",
			});
		}

		// Check for orphaned ec_ tables without matching collection records
		try {
			const tableNames = await listTablesLike(db, "ec_%");
			const collectionsResult = await sql<{
				slug: string;
			}>`SELECT slug FROM _emdash_collections`.execute(db);
			const registeredSlugs = new Set(collectionsResult.rows.map((r) => `ec_${r.slug}`));
			const orphaned = tableNames.filter((name) => !registeredSlugs.has(name));

			if (orphaned.length > 0) {
				results.push({
					name: "orphaned tables",
					status: "warn",
					message: `found ${orphaned.length}: ${orphaned.join(", ")}`,
				});
			}
		} catch {
			// Non-critical — tables may not exist on fresh DB
		}

		// Check users exist
		try {
			const usersResult = await sql<{
				count: number;
			}>`SELECT COUNT(id) as count FROM users`.execute(db);
			const count = usersResult.rows[0]?.count ?? 0;
			results.push({
				name: "users",
				status: count > 0 ? "pass" : "warn",
				message:
					count > 0 ? `${count} users` : "no users — complete setup wizard at /_emdash/admin",
			});
		} catch {
			results.push({
				name: "users",
				status: "warn",
				message: "could not query users table",
			});
		}
	} catch (error) {
		results.push({
			name: "database connection",
			status: "fail",
			message: error instanceof Error ? error.message : "failed to connect",
		});
	} finally {
		if (db) {
			await db.destroy();
		}
	}

	return results;
}

export const doctorCommand = defineCommand({
	meta: {
		name: "doctor",
		description: "Check database health, scheduler wiring, and diagnose issues",
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
		json: {
			type: "boolean",
			description: "Output results as JSON",
			default: false,
		},
	},
	async run({ args }) {
		const cwd = resolve(args.cwd);
		const dbPath = resolve(cwd, args.database);

		const results = await checkDoctor(cwd, dbPath);
		const fails = results.filter((result) => result.status === "fail");

		if (args.json) {
			process.stdout.write(JSON.stringify(results, null, 2) + "\n");
			if (fails.length > 0) process.exitCode = 1;
			return;
		}

		consola.start("EmDash Doctor\n");

		for (const result of results) {
			printResult(result);
		}

		// Summary
		const warns = results.filter((r) => r.status === "warn");

		consola.log("");
		if (fails.length === 0 && warns.length === 0) {
			consola.success("All checks passed");
		} else if (fails.length === 0) {
			consola.info(`All critical checks passed (${warns.length} warnings)`);
		} else {
			consola.error(`${fails.length} issues found`);
			process.exitCode = 1;
		}
	},
});
