// @vitest-environment jsdom
import { Kysely, SqliteDialect } from "kysely";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { runMigrations } from "../../../src/database/migrations/runner.js";
import type { Database } from "../../../src/database/types.js";
import { openNodeSqliteDatabase } from "../../../src/db/node-sqlite-compat.js";
import { runSeed, type RunOptions } from "./harness.js";

const START = Number(process.env.ROOM_SEED_START ?? 1);
const SEEDS = Number(process.env.ROOM_SEEDS ?? 1000);
const TAKEOVER_SEEDS = Number(process.env.ROOM_TAKEOVER_SEEDS ?? 100);

function seedRange(count: number): string {
	return count === 1 ? `seed ${START}` : `seeds ${START} to ${START + count - 1}`;
}

/** Runs `count` seeds from `START`, printing each failure with its seed, and stops after five. */
async function failingSeeds(count: number, options?: RunOptions): Promise<string[]> {
	const label = options?.db ? "room takeover harness" : "room harness";
	const failed: string[] = [];
	for (let seed = START; seed < START + count; seed++) {
		const result = await runSeed(seed, options);
		if (result.failures.length === 0) continue;
		failed.push(`seed ${seed}: ${result.failures.join("; ")}`);
		console.error(
			`[${label}] seed ${seed} failed:\n  ${result.failures.join("\n  ")}\n  events: ${result.events.slice(-40).join(" ")}`,
		);
		if (failed.length >= 5) break;
	}
	return failed;
}

describe("room convergence harness", () => {
	it(`converges over ${seedRange(SEEDS)}`, { timeout: 0 }, async () => {
		expect(await failingSeeds(SEEDS)).toEqual([]);
	});

	describe("with room storage in the site database", () => {
		let db: Kysely<Database>;

		// Not the shared test database helper: it loads modules this environment can't resolve.
		beforeAll(async () => {
			db = new Kysely<Database>({
				dialect: new SqliteDialect({ database: openNodeSqliteDatabase(":memory:") }),
			});
			await runMigrations(db);
		});

		afterAll(async () => {
			await db.destroy();
		});

		it(
			`converges over ${seedRange(TAKEOVER_SEEDS)} as another process takes each stalled room over`,
			{ timeout: 0 },
			async () => {
				expect(await failingSeeds(TAKEOVER_SEEDS, { db })).toEqual([]);
			},
		);
	});
});
