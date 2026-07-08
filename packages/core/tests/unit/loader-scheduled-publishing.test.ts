import { sql } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("Loader scheduled-post visibility (#917)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	// Bypass repo.schedule()'s past-date guard so we can simulate the
	// "scheduled time elapsed, cron hasn't promoted to published yet" state.
	async function scheduledPost(title: string, scheduledAt: string): Promise<string> {
		const r = await handleContentCreate(ctx.db, "post", { data: { title }, status: "draft" });
		const { id, slug } = r.data!.item;
		await sql`UPDATE ec_post SET status = 'scheduled', scheduled_at = ${scheduledAt} WHERE id = ${id}`.execute(
			ctx.db,
		);
		return slug;
	}

	async function publishedSlugs(): Promise<string[]> {
		const loader = emdashLoader();
		const r = await runWithContext({ editMode: false, db: ctx.db }, () =>
			loader.loadCollection!({ filter: { type: "post" } }),
		);
		return ("entries" in r ? (r.entries ?? []) : []).map((e) => e.slug);
	}

	it("should include scheduled posts whose scheduled_at has passed", async () => {
		const slug = await scheduledPost("past", new Date(Date.now() - 1000).toISOString());
		expect(await publishedSlugs()).toContain(slug);
	});

	it("should exclude scheduled posts whose scheduled_at is still in the future", async () => {
		const slug = await scheduledPost("future", new Date(Date.now() + 3_600_000).toISOString());
		expect(await publishedSlugs()).not.toContain(slug);
	});
});
