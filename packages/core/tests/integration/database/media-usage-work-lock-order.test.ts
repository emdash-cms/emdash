import { sql } from "kysely";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { MediaUsageWorkRepository } from "../../../src/database/repositories/media-usage-work.js";
import {
	activateMediaUsageCapture,
	continueMediaUsageActivation,
} from "../../../src/media/usage/activation.js";
import { processMediaUsageWorkAfterWrite } from "../../../src/media/usage/work-processor.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	hasPgTestDatabase,
	setupTestPostgresDatabase,
	teardownTestPostgresDatabase,
	type PgTestContext,
} from "../../utils/test-db.js";

describe.skipIf(!hasPgTestDatabase)("media usage work processing alongside a content write", () => {
	let ctx: PgTestContext;

	beforeEach(async () => {
		ctx = await setupTestPostgresDatabase();
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts", supports: [] });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });
		let activation = await activateMediaUsageCapture(ctx.db, { writersDrained: true });
		while (activation.outcome === "activating") {
			activation = await continueMediaUsageActivation(ctx.db);
		}
		expect(activation.outcome).toBe("active");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await teardownTestPostgresDatabase(ctx);
	});

	async function waitForBlockedStatement(): Promise<void> {
		for (let attempt = 0; attempt < 200; attempt++) {
			const { rows } = await sql<{ blocked: number | string }>`
				SELECT count(*) AS blocked FROM pg_stat_activity
				WHERE datname = current_database() AND wait_event_type = 'Lock'
			`.execute(ctx.db);
			if (Number(rows[0]?.blocked) > 0) return;
			await new Promise((resolve) => setTimeout(resolve, 10));
		}
		throw new Error("The content write never waited on a lock");
	}

	it("lets a write to the entry being processed finish instead of deadlocking", async () => {
		const repo = new ContentRepository(ctx.db);
		const entry = await repo.create({ type: "posts", data: { title: "First" }, slug: "first" });

		let resume!: () => void;
		const resumed = new Promise<void>((resolve) => {
			resume = resolve;
		});
		let paused!: () => void;
		const pausedInside = new Promise<void>((resolve) => {
			paused = resolve;
		});
		const lockWork = MediaUsageWorkRepository.prototype.lockClaimedWorkBatch;
		vi.spyOn(MediaUsageWorkRepository.prototype, "lockClaimedWorkBatch").mockImplementation(
			async function (this: MediaUsageWorkRepository, ...args) {
				const locked = await lockWork.apply(this, args);
				paused();
				await resumed;
				return locked;
			},
		);

		const processing = processMediaUsageWorkAfterWrite(ctx.db, "posts", entry.id);
		await pausedInside;
		const write = repo.update("posts", entry.id, { data: { title: "Second" } });
		await waitForBlockedStatement();
		resume();

		await expect(write).resolves.toEqual(
			expect.objectContaining({ data: expect.objectContaining({ title: "Second" }) }),
		);
		await expect(processing).resolves.toEqual(expect.objectContaining({ outcome: "completed" }));
	});
});
