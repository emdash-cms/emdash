import { sql } from "kysely";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("astro:content", async () => {
	const { emdashLoader } = await import("../../src/loader.js");
	return {
		getLiveCollection: vi.fn(
			(collection: string, filter: import("../../src/loader.js").CollectionFilter) =>
				emdashLoader().loadCollection!({ collection, filter }),
		),
		getLiveEntry: vi.fn(),
	};
});

import { ContentRepository } from "../../src/database/repositories/content.js";
import { TaxonomyRepository } from "../../src/database/repositories/taxonomy.js";
import { encodeCursor } from "../../src/database/repositories/types.js";
import { emdashLoader, resetTaxonomyNamesCache, type SortDirection } from "../../src/loader.js";
import { getEmDashCollection } from "../../src/query.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import {
	describeEachDialect,
	destroySharedPool,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

afterAll(destroySharedPool);

const UNDATED = ["undated-a", "undated-b", "undated-c"];
const DATED = ["dated-2024", "dated-2025-a", "dated-2025-b", "dated-2026"];

describeEachDialect("public collection cursor pages over nullable sort fields", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;
	let taxonomies: TaxonomyRepository;

	/**
	 * The listing keeps each database's own NULL position: SQLite sorts NULL
	 * lowest, Postgres highest.
	 */
	function expectedOrder(direction: SortDirection, nulls: string[], values: string[]): string[] {
		const ascending = dialect === "sqlite" ? [...nulls, ...values] : [...values, ...nulls];
		return direction === "asc" ? ascending : ascending.toReversed();
	}

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "event_date",
			label: "Event date",
			type: "datetime",
		});
		await ctx.db
			.updateTable("_emdash_taxonomy_def_groups")
			.set({ collections: JSON.stringify(["post"]) })
			.where("name", "=", "category")
			.execute();
		resetTaxonomyNamesCache();
		repo = new ContentRepository(ctx.db);
		taxonomies = new TaxonomyRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function seedDates(): Promise<void> {
		const dates: Array<[string, string | null]> = [
			["dated-2025-b", "2025-01-01T00:00:00.000Z"],
			["undated-c", null],
			["dated-2024", "2024-01-01T00:00:00.000Z"],
			["undated-a", null],
			["dated-2026", "2026-01-01T00:00:00.000Z"],
			["undated-b", null],
			["dated-2025-a", "2025-01-01T00:00:00.000Z"],
		];
		for (const [id, date] of dates) {
			await repo.create({
				id,
				slug: id,
				type: "post",
				status: "published",
				data: { event_date: date },
				publishedAt: date,
			});
		}
	}

	async function tagAll(slugs: string[]): Promise<void> {
		const termIds = [];
		for (const slug of slugs) {
			const id = `term-${slug}`;
			await ctx.db
				.insertInto("taxonomies")
				.values({ id, name: "category", slug, label: slug, translation_group: id })
				.execute();
			termIds.push(id);
		}
		for (const [index, id] of [...UNDATED, ...DATED].entries()) {
			await taxonomies.attachToEntry("post", id, termIds[index % termIds.length]!);
		}
	}

	async function listIds(
		orderBy: Record<string, SortDirection>,
		{ cursor, where }: { cursor?: string; where?: Record<string, string | string[]> } = {},
	): Promise<string[]> {
		const ids: string[] = [];
		let next = cursor;
		for (let page = 0; page < 10; page++) {
			const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
				getEmDashCollection("post", { limit: 2, cursor: next, orderBy, where }),
			);
			ids.push(...result.entries.map((entry) => String(entry.data.id)));
			next = result.nextCursor;
			if (!next) return ids;
		}
		throw new Error("pagination did not terminate");
	}

	it.each([
		["event_date", "asc"],
		["event_date", "desc"],
		["published_at", "asc"],
		["published_at", "desc"],
	] as const)("returns every entry once when paging by %s %s", async (field, direction) => {
		await seedDates();

		expect(await listIds({ [field]: direction })).toEqual(expectedOrder(direction, UNDATED, DATED));
	});

	it.each(["asc", "desc"] as const)(
		"keeps missing and empty titles apart when paging by title %s",
		async (direction) => {
			const titles: Array<[string, string | null]> = [
				["blank-b", ""],
				["untitled-b", null],
				["bravo", "Bravo"],
				["blank-a", ""],
				["alpha", "Alpha"],
				["untitled-a", null],
			];
			for (const [id, title] of titles) {
				await repo.create({ id, slug: id, type: "post", status: "published", data: { title } });
			}

			expect(await listIds({ title: direction })).toEqual(
				expectedOrder(
					direction,
					["untitled-a", "untitled-b"],
					["blank-a", "blank-b", "alpha", "bravo"],
				),
			);
		},
	);

	it.each(["asc", "desc"] as const)(
		"returns every entry once when paging by a boolean field %s",
		async (direction) => {
			await new SchemaRegistry(ctx.db).createField("post", {
				slug: "featured",
				label: "Featured",
				type: "boolean",
			});
			const flags: Array<[string, boolean | null]> = [
				["on-b", true],
				["off-a", false],
				["unset-a", null],
				["on-a", true],
				["off-b", false],
			];
			for (const [id, featured] of flags) {
				await repo.create({ id, slug: id, type: "post", status: "published", data: { featured } });
			}

			expect(await listIds({ featured: direction })).toEqual(
				expectedOrder(direction, ["unset-a"], ["off-a", "off-b", "on-a", "on-b"]),
			);
		},
	);

	it.each(["asc", "desc"] as const)(
		"returns every entry once when paging by version %s",
		async (direction) => {
			for (const [id, version] of [
				["v3", 3],
				["v1", 1],
				["v4", 4],
				["v2", 2],
				["v5", 5],
			] as const) {
				await repo.create({ id, slug: id, type: "post", status: "published", data: {} });
				await sql`UPDATE ec_post SET version = ${version} WHERE id = ${id}`.execute(ctx.db);
			}

			const ascending = ["v1", "v2", "v3", "v4", "v5"];
			expect(await listIds({ version: direction })).toEqual(
				direction === "asc" ? ascending : ascending.toReversed(),
			);
		},
	);

	it.each(["asc", "desc"] as const)(
		"returns every entry once when following the loader's own cursor %s",
		async (direction) => {
			await seedDates();
			const loader = emdashLoader();

			const ids: string[] = [];
			let cursor: string | undefined;
			do {
				const result = await runWithContext({ editMode: false, db: ctx.db }, () =>
					loader.loadCollection!({
						collection: "_emdash",
						filter: { type: "post", limit: 2, cursor, orderBy: { event_date: direction } },
					}),
				);
				if ("error" in result) throw result.error;
				ids.push(...result.entries.map((entry) => String(entry.data.id)));
				cursor = (result as { nextCursor?: string }).nextCursor;
			} while (cursor && ids.length <= 10);

			expect(ids).toEqual(expectedOrder(direction, UNDATED, DATED));
		},
	);

	it.each([
		["published_at", ["news"], "asc"],
		["published_at", ["news"], "desc"],
		["published_at", ["news", "sports"], "asc"],
		["published_at", ["news", "sports"], "desc"],
		["event_date", ["news"], "asc"],
		["event_date", ["news"], "desc"],
	] as const)(
		"returns every entry once when paging by %s filtered to categories %j %s",
		async (field, categories, direction) => {
			await seedDates();
			await tagAll([...categories]);

			expect(
				await listIds({ [field]: direction }, { where: { category: [...categories] } }),
			).toEqual(expectedOrder(direction, UNDATED, DATED));
		},
	);

	it("continues from cursors issued before null-aware paging", async () => {
		await seedDates();
		const dated = await repo.findById("post", "dated-2024");

		// The earlier `{ orderValue, id }` cursor, which wrote a NULL as "".
		const afterUndated = encodeCursor("", "undated-b");
		const afterDated = encodeCursor(String(dated!.data.event_date), "dated-2024");

		const ascending = expectedOrder("asc", UNDATED, DATED);
		expect(await listIds({ event_date: "asc" }, { cursor: afterUndated })).toEqual(
			ascending.slice(ascending.indexOf("undated-b") + 1),
		);
		const descending = expectedOrder("desc", UNDATED, DATED);
		expect(await listIds({ event_date: "desc" }, { cursor: afterDated })).toEqual(
			descending.slice(descending.indexOf("dated-2024") + 1),
		);
	});
});
