import { sql } from "kysely";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { up } from "../../../src/database/migrations/088_cron_oneshot_utc.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("cron one-shot UTC migration", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		vi.unstubAllEnvs();
	});

	it("normalizes offset and no-offset rows and can resume after partial completion", async () => {
		vi.stubEnv("TZ", "America/New_York");
		await sql`
			INSERT INTO _emdash_cron_tasks
				(id, plugin_id, task_name, schedule, is_oneshot, data, next_run_at, status, enabled)
			VALUES
				('negative', 'plugin', 'negative', '2030-01-02T03:04:05-03:00', 1, NULL, '2030-01-02T03:04:05-03:00', 'idle', 1),
				('no-zone-space', 'plugin', 'no-zone-space', '2030-01-02 03:04:05', 1, NULL, '2030-01-02 03:04:05', 'idle', 1),
				('no-zone-t', 'plugin', 'no-zone-t', '2030-01-02T03:04:05', 1, NULL, '2030-01-02T03:04:05', 'idle', 1),
				('positive', 'plugin', 'positive', '2030-01-02T03:04:05+02:00', 1, NULL, '2030-01-02T03:04:05+02:00', 'idle', 1),
				('canonical', 'plugin', 'canonical', '2030-01-02T03:04:05Z', 1, NULL, '2030-01-02T03:04:05.000Z', 'idle', 1),
				('recurring', 'plugin', 'recurring', '@daily', 0, NULL, '2030-01-02T03:04:05+02:00', 'idle', 1)
		`.execute(ctx.db);

		await up(ctx.db);
		await sql`
			UPDATE _emdash_cron_tasks
			SET next_run_at = '2030-01-02T03:04:05+02:00'
			WHERE id = 'positive'
		`.execute(ctx.db);
		await up(ctx.db);

		const rows = await sql<{ id: string; next_run_at: string }>`
			SELECT id, next_run_at FROM _emdash_cron_tasks ORDER BY id
		`.execute(ctx.db);
		expect(rows.rows).toEqual([
			{ id: "canonical", next_run_at: "2030-01-02T03:04:05.000Z" },
			{ id: "negative", next_run_at: "2030-01-02T06:04:05.000Z" },
			{ id: "no-zone-space", next_run_at: "2030-01-02T03:04:05.000Z" },
			{ id: "no-zone-t", next_run_at: "2030-01-02T03:04:05.000Z" },
			{ id: "positive", next_run_at: "2030-01-02T01:04:05.000Z" },
			{ id: "recurring", next_run_at: "2030-01-02T03:04:05+02:00" },
		]);
	});

	it("processes more than one bounded page", async () => {
		const rows = Array.from({ length: 105 }, (_, index) => ({
			id: `task-${String(index).padStart(3, "0")}`,
			plugin_id: "plugin",
			task_name: `task-${index}`,
			schedule: "2030-01-02T03:04:05+02:00",
			is_oneshot: 1,
			data: null,
			next_run_at: "2030-01-02T03:04:05+02:00",
			status: "idle" as const,
			enabled: 1,
		}));
		for (let offset = 0; offset < rows.length; offset += 20) {
			await ctx.db
				.insertInto("_emdash_cron_tasks")
				.values(rows.slice(offset, offset + 20))
				.execute();
		}

		await up(ctx.db);

		const result = await sql<{ next_run_at: string; count: string | number | bigint }>`
			SELECT next_run_at, COUNT(*) AS count
			FROM _emdash_cron_tasks
			GROUP BY next_run_at
		`.execute(ctx.db);
		expect(result.rows).toHaveLength(1);
		expect(result.rows[0]?.next_run_at).toBe("2030-01-02T01:04:05.000Z");
		expect(Number(result.rows[0]?.count)).toBe(105);
	});
});
