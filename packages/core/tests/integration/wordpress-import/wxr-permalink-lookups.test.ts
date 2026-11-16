import {
	type KyselyPlugin,
	type PluginTransformQueryArgs,
	type PluginTransformResultArgs,
	type QueryResult,
	type RootOperationNode,
	type UnknownRow,
} from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import { importWxrPermalinks } from "../../../src/import/wxr-permalinks.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const IMPORT_GROUP = "WordPress import";

/** Counts rows returned by redirect ownership lookups, rather than every redirect read. */
class RedirectLookupCounter implements KyselyPlugin {
	private readonly lookupQueries = new Set<unknown>();
	readonly returnedRows: number[] = [];

	transformQuery({ node, queryId }: PluginTransformQueryArgs): RootOperationNode {
		if (node.kind !== "SelectQueryNode") return node;
		const text = JSON.stringify(node);
		if (
			text.includes("_emdash_redirects") &&
			text.includes('"auto"') &&
			text.includes('"group_name"')
		) {
			this.lookupQueries.add(queryId);
		}
		return node;
	}

	transformResult({
		queryId,
		result,
	}: PluginTransformResultArgs): Promise<QueryResult<UnknownRow>> {
		if (this.lookupQueries.has(queryId)) this.returnedRows.push(result.rows.length);
		return Promise.resolve(result);
	}
}

async function seedRedirects(ctx: DialectTestContext, ownSource: string) {
	const repository = new RedirectRepository(ctx.db);
	for (let index = 0; index < 100; index++) {
		await repository.create({
			source: `/unrelated-${index}`,
			destination: `/posts/unrelated-${index}`,
			auto: true,
			groupName: IMPORT_GROUP,
		});
	}
	await repository.create({
		source: ownSource,
		destination: "/posts/old-example",
		auto: true,
		groupName: IMPORT_GROUP,
	});
}

describeEachDialect("WordPress permalink source-indexed lookups", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("uses the source index for canonical-only import cleanup", async () => {
		const canonical = "/posts/example";
		await seedRedirects(ctx, canonical);
		const counter = new RedirectLookupCounter();
		const countedDb = ctx.db.withPlugin(counter);

		const errors = await importWxrPermalinks(countedDb, [
			{
				title: "Example",
				link: `https://wp.test${canonical}`,
				collection: "posts",
				pattern: "/posts/{slug}",
				item: {
					id: "example",
					slug: "example",
					status: "published",
					publishedAt: "2024-01-01T00:00:00.000Z",
					locale: "en",
				},
			},
		]);

		expect(errors).toEqual([]);
		expect(counter.returnedRows.length).toBeGreaterThan(0);
		expect(counter.returnedRows.length).toBeLessThanOrEqual(2);
		expect(counter.returnedRows.reduce((sum, count) => sum + count, 0)).toBeLessThanOrEqual(2);
		expect(counter.returnedRows.every((count) => count <= 1)).toBe(true);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toHaveLength(100);
		expect(
			await ctx.db
				.selectFrom("_emdash_redirects")
				.select("source")
				.where("source", "=", canonical)
				.execute(),
		).toEqual([]);
	});

	it("uses the source index for publish cleanup", async () => {
		const canonical = "/posts/example";
		await seedRedirects(ctx, canonical);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: "posts",
			label: "Posts",
			labelSingular: "Post",
			urlPattern: "/posts/{slug}",
		});
		const counter = new RedirectLookupCounter();
		const runtime = createTestRuntime(ctx.db.withPlugin(counter));
		const created = await runtime.handleContentCreate("posts", {
			slug: "example",
			status: "draft",
			data: {},
		});
		expect(created.success).toBe(true);
		if (!created.success) return;

		const published = await runtime.handleContentPublish("posts", created.data.item.id);
		expect(published.success).toBe(true);
		expect(counter.returnedRows).toHaveLength(1);
		expect(counter.returnedRows[0]).toBeLessThanOrEqual(1);
		expect(await ctx.db.selectFrom("_emdash_redirects").selectAll().execute()).toHaveLength(100);
		expect(
			await ctx.db
				.selectFrom("_emdash_redirects")
				.select("source")
				.where("source", "=", canonical)
				.execute(),
		).toEqual([]);
	});
});
