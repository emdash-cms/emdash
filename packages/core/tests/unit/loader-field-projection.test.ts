import { it, expect, beforeEach, afterEach } from "vitest";

import { handleContentCreate } from "../../src/api/index.js";
import { emdashLoader } from "../../src/loader.js";
import { runWithContext } from "../../src/request-context.js";
import { SchemaRegistry } from "../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

describeEachDialect("Collection field projection", (dialect) => {
	let ctx: DialectTestContext;
	const COLLECTION = "projected_posts";

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({
			slug: COLLECTION,
			label: "Projected Posts",
			labelSingular: "Projected Post",
		});
		for (const slug of ["title", "excerpt", "body"]) {
			await registry.createField(COLLECTION, {
				slug,
				label: slug,
				type: "string",
			});
		}
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function seed(n: number) {
		for (let i = 1; i <= n; i++) {
			const result = await handleContentCreate(ctx.db, COLLECTION, {
				data: {
					title: `Post ${i}`,
					excerpt: `Excerpt ${i}`,
					body: `Body ${i}`.padEnd(500, "x"),
				},
				status: "published",
			});
			if (!result.success) throw new Error("Failed to create entry");
		}
	}

	function load(fields?: readonly string[]) {
		const loader = emdashLoader();
		return runWithContext({ db: ctx.db }, () =>
			loader.loadCollection!({ filter: { type: COLLECTION, status: "published", fields } }),
		);
	}

	function entriesOf(result: unknown) {
		return (result as { entries: { id: string; data: Record<string, unknown> }[] }).entries;
	}

	it("returns the requested fields and omits the rest", async () => {
		await seed(3);

		const entries = entriesOf(await load(["title", "excerpt"]));

		expect(entries).toHaveLength(3);
		for (const entry of entries) {
			expect(entry.data.title).toMatch(/^Post \d$/);
			expect(entry.data.excerpt).toMatch(/^Excerpt \d$/);
			expect("body" in entry.data).toBe(false);
		}
	});

	it("selects every column when no fields are given", async () => {
		await seed(1);

		const [entry] = entriesOf(await load());

		expect(entry.data.title).toBe("Post 1");
		expect(entry.data.excerpt).toBe("Excerpt 1");
		expect(typeof entry.data.body).toBe("string");
	});

	it("keeps system metadata on a projected entry", async () => {
		await seed(1);

		const [full] = entriesOf(await load());
		const [projected] = entriesOf(await load(["title"]));

		expect(projected!.id).toBe(full!.id);
		expect(projected!.data.slug).toBe(full!.data.slug);
		expect(projected!.data.status).toBe(full!.data.status);
		expect(projected!.data.createdAt).toEqual(full!.data.createdAt);
		expect(projected!.data.createdAt).toBeInstanceOf(Date);
		expect(projected!.data.updatedAt).toEqual(full!.data.updatedAt);
		expect(projected!.data.locale).toBe(full!.data.locale);
		expect(projected!.data.translationGroup).toBe(full!.data.translationGroup);
	});

	it("paginates a projected list, including by an unrequested sort column", async () => {
		await seed(3);

		const loader = emdashLoader();
		const page = (cursor?: string) =>
			runWithContext({ db: ctx.db }, () =>
				loader.loadCollection!({
					filter: {
						type: COLLECTION,
						status: "published",
						fields: ["title"],
						orderBy: { created_at: "desc" },
						limit: 2,
						cursor,
					},
				}),
			);

		const first = (await page()) as { entries: unknown[]; nextCursor?: string };
		expect(first.entries).toHaveLength(2);
		expect(first.nextCursor).toBeTruthy();

		// A cursor is encoded from the sort value read off the row. If the sort
		// column were dropped by the projection, this second page would repeat
		// the first one forever.
		const second = entriesOf(await page(first.nextCursor));
		expect(second).toHaveLength(1);
		expect(second[0]!.data.title).toBe("Post 1");
	});

	it("paginates a projected list sorted by an unrequested field", async () => {
		await seed(3);

		const loader = emdashLoader();
		const page = (cursor?: string) =>
			runWithContext({ db: ctx.db }, () =>
				loader.loadCollection!({
					filter: {
						type: COLLECTION,
						status: "published",
						fields: ["title"],
						orderBy: { excerpt: "desc" },
						limit: 2,
						cursor,
					},
				}),
			);

		const first = (await page()) as {
			entries: { data: Record<string, unknown> }[];
			nextCursor?: string;
		};
		expect(first.entries.map((entry) => entry.data.title)).toEqual(["Post 3", "Post 2"]);
		const second = entriesOf(await page(first.nextCursor));
		expect(second.map((entry) => entry.data.title)).toEqual(["Post 1"]);
		expect("body" in second[0]!.data).toBe(false);
	});

	it("rejects a field name that is not a plain identifier", async () => {
		await seed(1);

		const result = (await load(["title", 'body" FROM ec_other --'])) as { error?: Error };

		expect(result.error).toBeInstanceOf(Error);
		expect(result.error!.message).toContain("Invalid field name");
	});
});
