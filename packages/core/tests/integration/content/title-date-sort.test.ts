import { beforeEach, afterEach, expect, it } from "vitest";

import { handleContentCreate, handleContentList } from "../../../src/api/handlers/content.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

// #1133: a collection's configured `dateField` drives the admin list's default
// sort, and its titleField/dateField are the only non-system fields allowed
// as `orderBy`: a closed, server-resolved set (no column enumeration).
describeEachDialect("content list custom-field sort (#1133)", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "events", label: "Events", labelSingular: "Event" });
		await registry.createField("events", { slug: "title", label: "Title", type: "string" });
		await registry.createField("events", { slug: "event_date", label: "Date", type: "datetime" });
		await registry.createField("events", { slug: "location", label: "Location", type: "string" });
		await registry.updateCollection("events", { dateField: "event_date" });

		// createdAt order (e1 newest) is deliberately the reverse of event_date
		// order, so sorting by event_date can't be confused with the default.
		const seed = [
			{ slug: "e1", event_date: "2020-01-01T00:00:00.000Z", createdAt: "2025-06-01T00:00:00.000Z" },
			{ slug: "e2", event_date: "2022-01-01T00:00:00.000Z", createdAt: "2024-06-01T00:00:00.000Z" },
			{ slug: "e3", event_date: "2021-01-01T00:00:00.000Z", createdAt: "2023-06-01T00:00:00.000Z" },
		];
		for (const s of seed) {
			const created = await handleContentCreate(ctx.db, "events", {
				slug: s.slug,
				data: { title: s.slug, event_date: s.event_date, location: "HQ" },
				createdAt: s.createdAt,
			});
			if (!created.success) throw new Error(`seed ${s.slug} failed`);
		}
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function slugsOf(result: Awaited<ReturnType<typeof handleContentList>>): string[] {
		if (!result.success) throw new Error(`list failed: ${result.error.code}`);
		return result.data.items.map((i) => i.slug ?? "");
	}

	it("sorts by the configured dateField, not createdAt", async () => {
		const desc = await handleContentList(ctx.db, "events", {
			orderBy: "event_date",
			order: "desc",
		});
		expect(slugsOf(desc)).toEqual(["e2", "e3", "e1"]); // 2022, 2021, 2020

		const asc = await handleContentList(ctx.db, "events", { orderBy: "event_date", order: "asc" });
		expect(slugsOf(asc)).toEqual(["e1", "e3", "e2"]);
	});

	it("rejects ordering by a field that isn't titleField/dateField", async () => {
		// `location` is a real field but not a configured sort field.
		const result = await handleContentList(ctx.db, "events", { orderBy: "location" });
		expect(result.success).toBe(false);
	});

	it("rejects ordering by an unknown field", async () => {
		const result = await handleContentList(ctx.db, "events", { orderBy: "not_a_field" });
		expect(result.success).toBe(false);
	});
});
