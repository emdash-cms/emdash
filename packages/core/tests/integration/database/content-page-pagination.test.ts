import { sql } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { ContentRepository } from "../../../src/database/repositories/content.js";
import {
	EmDashValidationError,
	type FindManyOptions,
} from "../../../src/database/repositories/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const PAGE_SIZE = 2;

type ListOptions = Pick<FindManyOptions, "where" | "orderBy">;

describeEachDialect("content list numbered pages", (dialect) => {
	let ctx: DialectTestContext;
	let repo: ContentRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
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

	/** Ties on created_at and priority, and NULLs on either side of a page boundary. */
	async function seedPosts(): Promise<void> {
		const posts: Array<[string, string, string | null, number | null, string]> = [
			["a", "2026-01-01T00:00:00.000Z", "2026-02-01T00:00:00.000Z", 3, "published"],
			["b", "2026-01-02T00:00:00.000Z", null, null, "draft"],
			["c", "2026-01-02T00:00:00.000Z", "2026-02-03T00:00:00.000Z", 1, "published"],
			["d", "2026-01-03T00:00:00.000Z", null, 3, "draft"],
			["e", "2026-01-04T00:00:00.000Z", "2026-02-02T00:00:00.000Z", null, "published"],
			["f", "2026-01-04T00:00:00.000Z", null, 2, "published"],
			["g", "2026-01-05T00:00:00.000Z", "2026-02-04T00:00:00.000Z", 1, "draft"],
		];
		for (const [id, createdAt, publishedAt, priority, status] of posts) {
			await repo.create({ id, type: "post", data: { priority }, createdAt, publishedAt, status });
		}
	}

	async function cursorIds(options: ListOptions): Promise<string[]> {
		const ids: string[] = [];
		let cursor: string | undefined;
		for (let page = 0; page < 20; page++) {
			const result = await repo.findMany("post", { ...options, limit: PAGE_SIZE, cursor });
			ids.push(...result.items.map((item) => item.id));
			cursor = result.nextCursor;
			if (!cursor) return ids;
		}
		throw new Error("cursor pagination did not terminate");
	}

	async function numberedPages(options: ListOptions) {
		const ids: string[] = [];
		const totals = new Set<number | undefined>();
		for (let page = 0; page < 20; page++) {
			const result = await repo.findMany("post", {
				...options,
				limit: PAGE_SIZE,
				offset: page * PAGE_SIZE,
			});
			expect(result.nextCursor).toBeUndefined();
			ids.push(...result.items.map((item) => item.id));
			totals.add(result.total);
			if (result.items.length < PAGE_SIZE) return { ids, totals: [...totals] };
		}
		throw new Error("numbered pagination did not terminate");
	}

	it.each([
		["createdAt", "desc"],
		["createdAt", "asc"],
		["publishedAt", "desc"],
		["publishedAt", "asc"],
		["priority", "desc"],
		["priority", "asc"],
	] as const)("lists every entry once in cursor order by %s %s", async (field, direction) => {
		await seedPosts();
		const options: ListOptions = { orderBy: { field, direction } };

		const pages = await numberedPages(options);

		expect(pages.ids).toEqual(await cursorIds(options));
		expect(pages.ids.toSorted()).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
		expect(pages.totals).toEqual([7]);
	});

	it("filters the page rows and the total together", async () => {
		await seedPosts();
		const options: ListOptions = {
			where: { status: "published" },
			orderBy: { field: "publishedAt", direction: "desc" },
		};

		const pages = await numberedPages(options);

		expect(pages.ids).toEqual(await cursorIds(options));
		expect(pages.ids.toSorted()).toEqual(["a", "c", "e", "f"]);
		expect(pages.totals).toEqual([4]);
	});

	it("returns no rows past the last page but keeps the total", async () => {
		await seedPosts();

		const result = await repo.findMany("post", { limit: PAGE_SIZE, offset: 8 });

		expect(result.items).toEqual([]);
		expect(result.total).toBe(7);
	});

	it("pages the trash in cursor order", async () => {
		await seedPosts();
		const deletedAt: Array<[string, string]> = [
			["a", "2026-03-01T00:00:00.000Z"],
			["c", "2026-03-02T00:00:00.000Z"],
			["d", "2026-03-02T00:00:00.000Z"],
			["f", "2026-03-03T00:00:00.000Z"],
			["g", "2026-03-04T00:00:00.000Z"],
		];
		for (const [id, at] of deletedAt) {
			await repo.delete("post", id);
			await sql`UPDATE ${sql.ref("ec_post")} SET deleted_at = ${at} WHERE id = ${id}`.execute(
				ctx.db,
			);
		}

		const cursorWalk: string[] = [];
		let cursor: string | undefined;
		do {
			const result = await repo.findTrashed("post", { limit: PAGE_SIZE, cursor });
			cursorWalk.push(...result.items.map((item) => item.id));
			cursor = result.nextCursor;
		} while (cursor);
		const pageWalk: string[] = [];
		for (let offset = 0; offset < 6; offset += PAGE_SIZE) {
			const result = await repo.findTrashed("post", { limit: PAGE_SIZE, offset });
			expect(result.nextCursor).toBeUndefined();
			pageWalk.push(...result.items.map((item) => item.id));
		}

		expect(pageWalk).toEqual(cursorWalk);
		expect(pageWalk.toSorted()).toEqual(["a", "c", "d", "f", "g"]);
	});

	it.each([
		[{ offset: -1 }],
		[{ offset: 1.5 }],
		[{ offset: Number.MAX_SAFE_INTEGER + 1 }],
		[{ offset: 2, cursor: "anything" }],
	])("rejects %o", async (options) => {
		await expect(repo.findMany("post", options)).rejects.toThrow(EmDashValidationError);
		await expect(repo.findTrashed("post", options)).rejects.toThrow(EmDashValidationError);
	});
});
