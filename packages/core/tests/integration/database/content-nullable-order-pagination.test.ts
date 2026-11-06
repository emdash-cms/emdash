import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import { encodeCursor, type FindManyOptions } from "../../../src/database/repositories/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

type Direction = "asc" | "desc";

const UNDATED = ["undated-a", "undated-b", "undated-c"];
const DATED = ["dated-2024", "dated-2025-a", "dated-2025-b", "dated-2026"];

describeEachDialect("content list cursor pages over nullable sort columns", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	/**
	 * The list keeps each database's own NULL position: SQLite sorts NULL
	 * lowest, Postgres highest.
	 */
	function expectedOrder(direction: Direction, nulls: string[], values: string[]): string[] {
		const ascending = dialect === "sqlite" ? [...nulls, ...values] : [...values, ...nulls];
		return direction === "asc" ? ascending : ascending.toReversed();
	}

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		await registry.createField("post", {
			slug: "event_date",
			label: "Event date",
			type: "datetime",
		});
		await registry.createField("post", {
			slug: "priority",
			label: "Priority",
			type: "number",
			indexed: true,
		});
		repo = new ContentRepository(ctx.db);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function listIds(
		field: string,
		direction: Direction,
		{ cursor, where }: Pick<FindManyOptions, "cursor" | "where"> = {},
	): Promise<string[]> {
		const ids: string[] = [];
		let next = cursor;
		for (let page = 0; page < 10; page++) {
			const result = await repo.findMany("post", {
				limit: 2,
				cursor: next,
				where,
				orderBy: { field, direction },
				sortableExtras: ["event_date"],
			});
			ids.push(...result.items.map((item) => item.id));
			next = result.nextCursor;
			if (!next) return ids;
		}
		throw new Error("pagination did not terminate");
	}

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
			await repo.create({ id, type: "post", data: { event_date: date }, publishedAt: date });
			if (date) await repo.update("post", id, { scheduledAt: date });
		}
	}

	it.each([
		["publishedAt", "asc"],
		["publishedAt", "desc"],
		["scheduledAt", "asc"],
		["scheduledAt", "desc"],
		["event_date", "asc"],
		["event_date", "desc"],
	] as const)("returns every entry once when paging by %s %s", async (field, direction) => {
		await seedDates();

		expect(await listIds(field, direction)).toEqual(expectedOrder(direction, UNDATED, DATED));
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
				await repo.create({ id, type: "post", data: { title } });
			}

			expect(await listIds("title", direction)).toEqual(
				expectedOrder(
					direction,
					["untitled-a", "untitled-b"],
					["blank-a", "blank-b", "alpha", "bravo"],
				),
			);
		},
	);

	it("continues from cursors issued before null-aware paging", async () => {
		await seedDates();
		const dated = await repo.findById("post", "dated-2024");

		// The earlier `{ orderValue, id }` cursor, which wrote a NULL as "".
		const afterUndated = encodeCursor("", "undated-b");
		const afterDated = encodeCursor(dated!.publishedAt!, "dated-2024");

		const ascending = expectedOrder("asc", UNDATED, DATED);
		expect(await listIds("publishedAt", "asc", { cursor: afterUndated })).toEqual(
			ascending.slice(ascending.indexOf("undated-b") + 1),
		);
		const descending = expectedOrder("desc", UNDATED, DATED);
		expect(await listIds("publishedAt", "desc", { cursor: afterDated })).toEqual(
			descending.slice(descending.indexOf("dated-2024") + 1),
		);
	});

	it.each([
		["scheduledAt", "asc"],
		["scheduledAt", "desc"],
		["priority", "asc"],
		["priority", "desc"],
	] as const)("keeps every filter on every page when paging by %s %s", async (field, direction) => {
		const matching: Array<[string, string | null, number | null]> = [
			["undated-1", null, null],
			["undated-2", null, null],
			["undated-3", null, null],
			["dated-1", "2026-01-01T00:00:00.000Z", 1],
			["dated-2", "2026-02-01T00:00:00.000Z", 2],
		];
		for (const [id, scheduledAt, priority] of matching) {
			await repo.create({ id, type: "post", status: "published", data: { priority } });
			if (scheduledAt) await repo.update("post", id, { scheduledAt });
		}
		await repo.create({ id: "undated-draft", type: "post", data: { priority: null } });
		await repo.create({
			id: "undated-trashed",
			type: "post",
			status: "published",
			data: { priority: null },
		});
		await repo.delete("post", "undated-trashed");

		const ids = await listIds(field, direction, { where: { status: "published" } });
		expect(ids.toSorted()).toEqual(matching.map(([id]) => id).toSorted());
	});
});
