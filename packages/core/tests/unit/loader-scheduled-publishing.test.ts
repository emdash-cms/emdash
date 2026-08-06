import { sql } from "kysely";
import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { BylineRepository } from "../../src/database/repositories/byline.js";
import { ContentRepository } from "../../src/database/repositories/content.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("committed scheduled publication visibility", (dialect) => {
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

	it("excludes scheduled posts whose scheduled_at has passed", async () => {
		const slug = await scheduledPost("past", new Date(Date.now() - 1000).toISOString());
		expect(await publishedSlugs()).not.toContain(slug);
	});

	it("should exclude scheduled posts whose scheduled_at is still in the future", async () => {
		const slug = await scheduledPost("future", new Date(Date.now() + 3_600_000).toISOString());
		expect(await publishedSlugs()).not.toContain(slug);
	});

	it("never exposes the initial slug or fields before the staged revision is promoted", async () => {
		const bylineRepo = new BylineRepository(ctx.db);
		const byline = await bylineRepo.create({ slug: "reporter", displayName: "Reporter" });
		const created = await handleContentCreate(ctx.db, "post", {
			slug: "how-were-rethinking-work",
			data: { title: "Initial title", content: "Initial content" },
			status: "draft",
			bylines: [{ bylineId: byline.id }],
		});
		const id = created.data!.item.id;
		const contentRepo = new ContentRepository(ctx.db);
		const revisionRepo = new RevisionRepository(ctx.db);
		const revision = await revisionRepo.create({
			collection: "post",
			entryId: id,
			data: {
				...created.data!.item.data,
				title: "Final title",
				content: "Final content",
				_slug: "how-we-use-ai",
			},
		});
		await contentRepo.setDraftRevision("post", id, revision.id);
		const taxonomyRepo = new TaxonomyRepository(ctx.db);
		const term = await taxonomyRepo.create({
			name: "category",
			slug: "technology",
			label: "Technology",
		});
		await taxonomyRepo.attachToEntry("post", id, term.id);
		const scheduledAt = new Date(Date.now() - 1000).toISOString();
		await sql`UPDATE ec_post SET status = 'scheduled', scheduled_at = ${scheduledAt} WHERE id = ${id}`.execute(
			ctx.db,
		);
		const loader = emdashLoader();
		const load = async (where?: Record<string, string>) => {
			const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
				loader.loadCollection!({ filter: { type: "post", where } }),
			);
			return "entries" in result ? (result.entries ?? []) : [];
		};

		expect(await load()).toEqual([]);
		expect(await load({ category: "technology" })).toEqual([]);
		expect(await load({ byline: byline.translationGroup ?? byline.id })).toEqual([]);

		await contentRepo.publish("post", id, scheduledAt, true, scheduledAt);

		const entries = await load();
		expect(entries).toHaveLength(1);
		expect(entries[0]?.slug).toBe("how-we-use-ai");
		expect(entries[0]?.data.title).toBe("Final title");
		expect(entries[0]?.data.content).toBe("Final content");
		expect(entries.map((entry) => entry.slug)).not.toContain("how-were-rethinking-work");
	});
});
