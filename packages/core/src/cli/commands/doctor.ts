/**
 * emdash doctor
 *
 * Diagnose database health: connection, migrations, schema integrity.
 */

import { access } from "node:fs/promises";
import { resolve } from "node:path";

import { defineCommand } from "citty";
import consola from "consola";

import { createDatabase } from "../../database/connection.js";
import { listTablesLike } from "../../database/dialect-helpers.js";
import { getMigrationStatus } from "../../database/migrations/runner.js";

interface CheckResult {
	name: string;
	status: "pass" | "warn" | "fail";
	message: string;
}

async function fileExists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
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
		description: "Check database health and diagnose issues",
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

		const results = await checkDatabase(dbPath);

		if (args.json) {
			process.stdout.write(JSON.stringify(results, null, 2) + "\n");
			return;
		}

		consola.start("EmDash Doctor\n");

		for (const result of results) {
			printResult(result);
		}

		// Summary
		const fails = results.filter((r) => r.status === "fail");
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
