import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { CronExecutor } from "../../../src/plugins/cron.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("CronExecutor.tick", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("disables a recurring task whose schedule has no future runs instead of stalling the batch", async () => {
		const now = new Date("2030-01-05T00:00:00.000Z");
		const past = new Date("2030-01-02T03:04:05.000Z").toISOString();

		await db
			.insertInto("_emdash_cron_tasks" as never)
			.values([
				{
					id: "task_bad",
					plugin_id: "test",
					task_name: "bad",
					schedule: "2030-01-02 03:04:05",
					is_oneshot: 0,
					data: null,
					status: "idle",
					enabled: 1,
					next_run_at: past,
					locked_at: null,
					last_run_at: null,
					created_at: past,
				},
				{
					id: "task_good",
					plugin_id: "test",
					task_name: "good",
					schedule: "@daily",
					is_oneshot: 0,
					data: null,
					status: "idle",
					enabled: 1,
					next_run_at: past,
					locked_at: null,
					last_run_at: null,
					created_at: past,
				},
			] as never)
			.execute();

		const invoked: string[] = [];
		const executor = new CronExecutor(
			db,
			async (_pluginId, event) => {
				invoked.push(event.name);
			},
			() => now,
		);

		await executor.tick();

		expect(invoked).toEqual(["bad", "good"]);

		const tasks = (await db
			.selectFrom("_emdash_cron_tasks" as never)
			.selectAll()
			.execute()) as Array<{
			task_name: string;
			enabled: number;
			status: string;
			next_run_at: string;
		}>;

		const bad = tasks.find((t) => t.task_name === "bad");
		const good = tasks.find((t) => t.task_name === "good");

		expect(bad).toBeDefined();
		expect(bad!.enabled).toBe(0);
		expect(bad!.status).toBe("idle");
		expect(good).toBeDefined();
		expect(good!.enabled).toBe(1);
		expect(new Date(good!.next_run_at).getTime()).toBeGreaterThan(now.getTime());
	});
});
