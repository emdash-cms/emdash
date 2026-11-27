import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../../src/database/repositories/content.js";
import { SchemaRegistry } from "../../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../../utils/test-db.js";

describeEachDialect("ContentRepository fallback search", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;
	let longTextId: string;
	let wildcardId: string;
	let numericId: string;
	let nullId: string;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createField("post", {
			slug: "ticket_number",
			label: "Ticket number",
			type: "integer",
			searchable: true,
		});
		repo = new ContentRepository(ctx.db);

		const longText = "Literal Long Search ".repeat(4);
		const longTextEntry = await repo.create({
			type: "post",
			slug: "long-text",
			data: { title: longText.toUpperCase() },
		});
		longTextId = longTextEntry.id;

		const wildcard = "%_\\".repeat(20);
		const wildcardEntry = await repo.create({
			type: "post",
			slug: "literal-wildcards",
			data: { title: `Value ${wildcard} value` },
		});
		wildcardId = wildcardEntry.id;

		const numericEntry = await repo.create({
			type: "post",
			slug: "numeric-ticket",
			data: { title: null, ticket_number: 2179 },
		});
		numericId = numericEntry.id;

		const nullEntry = await repo.create({
			type: "post",
			slug: "null-fields",
			data: { title: null, ticket_number: null },
		});
		nullId = nullEntry.id;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	const searchColumns = ["title", "ticket_number"];

	async function search(q: string) {
		const where = { q, searchColumns };
		const result = await repo.findMany("post", { where, limit: 100 });
		const count = await repo.count("post", where);
		return { ids: result.items.map(({ id }) => id), count };
	}

	it("matches long case-insensitive text and excludes NULL values", async () => {
		const { ids, count } = await search("literal long search ".repeat(4));

		expect(ids).toEqual([longTextId]);
		expect(ids).not.toContain(nullId);
		expect(count).toBe(1);
	});

	it("matches %, _, and backslash as literal characters", async () => {
		const { ids, count } = await search("%_\\".repeat(20));

		expect(ids).toEqual([wildcardId]);
		expect(count).toBe(1);
	});

	it("searches numeric fields through their text representation", async () => {
		const { ids, count } = await search("2179");

		expect(ids).toEqual([numericId]);
		expect(ids).not.toContain(nullId);
		expect(count).toBe(1);
	});
});
