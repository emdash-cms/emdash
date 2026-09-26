import { sql } from "kysely";
import { afterEach, beforeEach, expect, vi } from "vitest";

import { CronAccessImpl, CronExecutor } from "../../../src/plugins/cron.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("cron correctness", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	it("stores one-shot due times as canonical UTC", async () => {
		vi.stubEnv("TZ", "America/New_York");
		const access = new CronAccessImpl(ctx.db, "reminders", () => {});
		await access.schedule("offset", { schedule: "2030-01-02T03:04:05+02:00" });
		await access.schedule("space", { schedule: "2030-01-02 04:05:06" });

		const rows = await sql<{ task_name: string; next_run_at: string; is_oneshot: number }>`
			SELECT task_name, next_run_at, is_oneshot
			FROM _emdash_cron_tasks
			ORDER BY task_name
		`.execute(ctx.db);

		expect(rows.rows).toEqual([
			{ task_name: "offset", next_run_at: "2030-01-02T01:04:05.000Z", is_oneshot: 1 },
			{ task_name: "space", next_run_at: "2030-01-02T04:05:06.000Z", is_oneshot: 1 },
		]);

		const invoked: string[] = [];
		const executor = new CronExecutor(
			ctx.db,
			async (_pluginId, event) => {
				invoked.push(event.name);
			},
			() => new Date("2030-01-02T01:05:00.000Z"),
		);
		expect(await executor.getNextDueTime()).toBe("2030-01-02T01:04:05.000Z");
		expect(await executor.tick()).toBe(1);
		expect(invoked).toEqual(["offset"]);
		expect(await executor.getNextDueTime()).toBe("2030-01-02T04:05:06.000Z");
	});

	it("disables an unsatisfiable row and continues the claimed batch", async () => {
		await sql`
			INSERT INTO _emdash_cron_tasks
				(id, plugin_id, task_name, schedule, is_oneshot, data, next_run_at, status, enabled)
			VALUES
				('bad', 'plugin', 'bad', '2030-01-02 03:04:05', 0, NULL, '2030-01-02T03:04:05.000Z', 'idle', 1),
				('good', 'plugin', 'good', '@daily', 0, NULL, '2030-01-02T04:00:00.000Z', 'idle', 1)
		`.execute(ctx.db);
		const invoked: string[] = [];
		const error = vi.spyOn(console, "error").mockImplementation(() => {});
		const executor = new CronExecutor(
			ctx.db,
			async (_pluginId, event) => {
				invoked.push(event.name);
			},
			() => new Date("2030-01-03T00:00:00.000Z"),
		);

		expect(await executor.tick()).toBe(2);
		expect(invoked).toEqual(["bad", "good"]);
		const rows = await sql<{ id: string; status: string; enabled: number; next_run_at: string }>`
			SELECT id, status, enabled, next_run_at
			FROM _emdash_cron_tasks
			ORDER BY id
		`.execute(ctx.db);
		expect(rows.rows).toEqual([
			{
				id: "bad",
				status: "idle",
				enabled: 0,
				next_run_at: "2030-01-02T03:04:05.000Z",
			},
			{
				id: "good",
				status: "idle",
				enabled: 1,
				next_run_at: "2030-01-04T00:00:00.000Z",
			},
		]);
		expect(error).toHaveBeenCalledOnce();
	});

	it("disables malformed task data without blocking later tasks", async () => {
		await sql`
			INSERT INTO _emdash_cron_tasks
				(id, plugin_id, task_name, schedule, is_oneshot, data, next_run_at, status, enabled)
			VALUES
				('bad-data', 'plugin', 'bad-data', '@daily', 0, '{', '2030-01-02T03:00:00.000Z', 'idle', 1),
				('good-data', 'plugin', 'good-data', '@daily', 0, NULL, '2030-01-02T04:00:00.000Z', 'idle', 1)
		`.execute(ctx.db);
		const invoked: string[] = [];
		vi.spyOn(console, "error").mockImplementation(() => {});
		const executor = new CronExecutor(
			ctx.db,
			async (_pluginId, event) => {
				invoked.push(event.name);
			},
			() => new Date("2030-01-03T00:00:00.000Z"),
		);

		expect(await executor.tick()).toBe(1);
		expect(invoked).toEqual(["good-data"]);
		const bad = await sql<{ status: string; enabled: number }>`
			SELECT status, enabled FROM _emdash_cron_tasks WHERE id = 'bad-data'
		`.execute(ctx.db);
		expect(bad.rows[0]).toEqual({ status: "idle", enabled: 0 });
	});
});
