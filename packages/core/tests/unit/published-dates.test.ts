import { sql, type Kysely, type KyselyPlugin, type QueryId } from "kysely";
import { afterAll, afterEach, beforeEach, expect, it, vi } from "vitest";

vi.mock("astro:content", async () => {
	const { emdashLoader } = await import("../../src/loader.js");
	return {
		getLiveCollection: vi.fn(
			(_collection: string, filter: import("../../src/loader.js").CollectionFilter) =>
				emdashLoader().loadCollection!({ filter }),
		),
		getLiveEntry: vi.fn(),
	};
});

import { ContentRepository } from "../../src/database/repositories/content.js";
import type { Database } from "../../src/database/types.js";
import { waitForDeferredTasks } from "../../src/deferred-tasks.js";
import { setI18nConfig } from "../../src/i18n/config.js";
import {
	__setObjectCacheBackendForTests,
	invalidateCollectionCache,
	invalidateObjectCache,
	type ObjectCacheBackend,
} from "../../src/object-cache/index.js";
import { getEmDashCollection, getPublishedDates } from "../../src/query.js";
import { runWithContext, type EmDashRequestContext } from "../../src/request-context.js";
import { groupEntriesByPublishedAt } from "../../src/widgets/archives.js";
import { createPostFixture } from "../utils/fixtures.js";
import {
	describeEachDialect,
	destroySharedPool,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../utils/test-db.js";

const march = "2026-03-15T12:00:00.000Z";
const april = "2026-04-15T12:00:00.000Z";
const may = "2026-05-15T12:00:00.000Z";

function memoryBackend(): ObjectCacheBackend {
	const store = new Map<string, string>();
	return {
		get: (key) => Promise.resolve(store.get(key) ?? null),
		set: (key, value) => {
			store.set(key, value);
			return Promise.resolve();
		},
		delete: (key) => {
			store.delete(key);
			return Promise.resolve();
		},
	};
}

afterAll(destroySharedPool);

describeEachDialect("published dates", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let queries: Array<{ sql: string; fields?: string[] }>;
	let failNextRead: boolean;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		__setObjectCacheBackendForTests(null);
		setI18nConfig(null);
		queries = [];
		failNextRead = false;
		const reads = new Map<QueryId, (typeof queries)[number]>();
		const plugin: KyselyPlugin = {
			transformQuery(args) {
				const compiled = ctx.db.getExecutor().compileQuery(args.node, args.queryId);
				if (/^\s*(SELECT|WITH)\b/i.test(compiled.sql)) {
					const query = { sql: compiled.sql };
					queries.push(query);
					reads.set(args.queryId, query);
				}
				return args.node;
			},
			async transformResult(args) {
				const query = reads.get(args.queryId);
				if (query) {
					query.fields = Object.keys(args.result.rows[0] ?? {}).toSorted();
					if (failNextRead && query.sql.includes("ec_post")) {
						failNextRead = false;
						throw new Error("Content read failed");
					}
				}
				return args.result;
			},
		};
		db = ctx.db.withPlugin(plugin);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
		__setObjectCacheBackendForTests(null);
		setI18nConfig(null);
		vi.clearAllMocks();
	});

	async function seed(
		slug: string,
		publishedAt: string | null,
		options: { locale?: string; status?: string; deletedAt?: string; updatedAt?: string } = {},
	) {
		const item = await new ContentRepository(ctx.db).create(
			createPostFixture({ slug, status: "published", locale: options.locale ?? "en" }),
		);
		await sql`
			UPDATE ec_post SET published_at = ${publishedAt},
				updated_at = ${options.updatedAt ?? march}, status = ${options.status ?? "published"},
				deleted_at = ${options.deletedAt ?? null}
			WHERE id = ${item.id}
		`.execute(ctx.db);
		return item.id;
	}

	function read(options?: { locale?: string }, context: Partial<EmDashRequestContext> = {}) {
		return runWithContext({ editMode: false, db, ...context }, () =>
			getPublishedDates("post", options),
		);
	}

	async function enableCache() {
		await waitForDeferredTasks();
		__setObjectCacheBackendForTests(memoryBackend(), { revalidate: 60_000, defaultTtl: 3600 });
	}

	const contentReads = () => queries.filter((query) => query.sql.includes("ec_post"));
	const timestamps = (dates: Date[]) => dates.map((date) => date.toISOString());

	it("projects only dates while preserving visible groups and their full counts", async () => {
		await seed("march-first", march);
		await seed("april", april);
		await seed("march-second", "2026-03-20T12:00:00.000Z");
		await seed("previous-year", "2025-12-15T12:00:00.000Z");
		await seed("draft", may, { status: "draft", updatedAt: "2030-01-01T12:00:00.000Z" });
		await seed("archived", may, { status: "archived" });
		await seed("deleted", may, { deletedAt: march });
		const past = await seed("scheduled-past", may, { status: "scheduled" });
		const future = await seed("scheduled-future", may, { status: "scheduled" });
		await sql`UPDATE ec_post SET scheduled_at = '2000-01-01T00:00:00.000Z' WHERE id = ${past}`.execute(
			ctx.db,
		);
		await sql`UPDATE ec_post SET scheduled_at = '2100-01-01T00:00:00.000Z' WHERE id = ${future}`.execute(
			ctx.db,
		);

		const result = await read();
		expect(result.error).toBeUndefined();
		expect(timestamps(result.dates)).toEqual([
			april,
			"2026-03-20T12:00:00.000Z",
			march,
			"2025-12-15T12:00:00.000Z",
		]);
		expect(result.cacheHint).toEqual({ tags: ["post"], lastModified: new Date(march) });
		const entries = result.dates.map((publishedAt) => ({ data: { publishedAt } }));
		expect(groupEntriesByPublishedAt(entries, { limit: 2 })).toEqual([
			{ label: "April 2026", count: 1, url: "/archives/2026/04" },
			{ label: "March 2026", count: 2, url: "/archives/2026/03" },
		]);
		expect(groupEntriesByPublishedAt(entries, { type: "yearly" })).toEqual([
			{ label: "2026", count: 3, url: "/archives/2026" },
			{ label: "2025", count: 1, url: "/archives/2025" },
		]);
		expect(queries).toHaveLength(1);
		expect(queries[0]?.fields).toEqual(["published_at", "updated_at"]);
	});

	it("ignores invalid publication dates and retains visible last-modified hints through L2", async () => {
		await seed("valid", march);
		await seed("missing-date", null, { updatedAt: may });
		await seed("empty-date", "");
		await seed("invalid-date", "not-a-date");
		await seed("invalid-update", april, { updatedAt: "not-a-date" });
		await enableCache();
		const first = await read();
		await waitForDeferredTasks();
		const second = await read();
		expect(first.error).toBeUndefined();
		expect(second).toEqual(first);
		expect(timestamps(second.dates)).toEqual([april, march]);
		expect(second.cacheHint.lastModified).toEqual(new Date(may));
		expect(contentReads()).toHaveLength(1);
	});

	it("resolves explicit, request and configured locales without mixing cached dates", async () => {
		await seed("english", march, { locale: "en" });
		await seed("french", april, { locale: "fr" });
		setI18nConfig({ defaultLocale: "fr", locales: ["en", "fr"] });
		await enableCache();
		expect(timestamps((await read({ locale: "en" }, { locale: "fr" })).dates)).toEqual([march]);
		expect(timestamps((await read(undefined, { locale: "en" })).dates)).toEqual([march]);
		expect(timestamps((await read()).dates)).toEqual([april]);
		await waitForDeferredTasks();
		setI18nConfig(null);
		expect(timestamps((await read()).dates)).toEqual([april, march]);
		expect(timestamps((await read({ locale: "fr" })).dates)).toEqual([april]);
		await waitForDeferredTasks();
		const before = contentReads().length;
		expect(timestamps((await read({ locale: "fr" })).dates)).toEqual([april]);
		expect(contentReads()).toHaveLength(before);
	});

	it("preserves collection results when content localization is disabled", async () => {
		await seed("english", march, { locale: "en" });
		await seed("french", april, { locale: "fr" });
		for (const config of [null, { defaultLocale: "fr", locales: ["fr"] }]) {
			setI18nConfig(config);
			const expected = await runWithContext({ editMode: false, db }, () =>
				getEmDashCollection<string, { publishedAt: Date }>("post", {
					orderBy: { published_at: "desc" },
				}),
			);
			expect(timestamps((await read()).dates)).toEqual(
				expected.entries.map((entry) => entry.data.publishedAt.toISOString()),
			);
		}
	});

	it("shares concurrent reads within one request without reusing them in the next request", async () => {
		await seed("published", march);
		await runWithContext({ editMode: false, db }, async () => {
			const results = await Promise.all([getPublishedDates("post"), getPublishedDates("post")]);
			expect(results[0]).toEqual(results[1]);
			expect(contentReads()).toHaveLength(1);
		});
		await read();
		expect(contentReads()).toHaveLength(2);
	});

	it("rejects invalid collection identifiers and binds locale values", async () => {
		await seed("published", march);
		const invalid = await runWithContext({ editMode: false, db }, () =>
			getPublishedDates("post; DROP TABLE ec_post"),
		);
		expect(invalid.error).toBeInstanceOf(Error);
		expect(invalid.dates).toEqual([]);
		expect(queries).toHaveLength(0);
		expect((await read({ locale: "en' OR 1=1 --" })).dates).toEqual([]);
		expect(timestamps((await read({ locale: "en" })).dates)).toEqual([march]);
	});

	it("reloads cached dates after current and legacy collection invalidation", async () => {
		const id = await seed("published", march);
		await enableCache();
		await read();
		await waitForDeferredTasks();
		expect(timestamps((await read()).dates)).toEqual([march]);
		expect(contentReads()).toHaveLength(1);
		await sql`UPDATE ec_post SET published_at = ${april} WHERE id = ${id}`.execute(ctx.db);
		invalidateCollectionCache("post");
		await waitForDeferredTasks();
		expect(timestamps((await read()).dates)).toEqual([april]);
		await waitForDeferredTasks();
		await sql`UPDATE ec_post SET published_at = ${may} WHERE id = ${id}`.execute(ctx.db);
		invalidateObjectCache("content:post");
		await waitForDeferredTasks();
		expect(timestamps((await read()).dates)).toEqual([may]);
		expect(contentReads()).toHaveLength(3);
	});

	it.each(["edit", "preview", "isolated"])(
		"bypasses L2 reads and writes for %s requests",
		async (mode) => {
			const id = await seed("published", march);
			await seed("draft", may, { status: "draft" });
			await enableCache();
			await read();
			await waitForDeferredTasks();
			await sql`UPDATE ec_post SET published_at = ${april} WHERE id = ${id}`.execute(ctx.db);
			const context: Partial<EmDashRequestContext> =
				mode === "edit"
					? { editMode: true }
					: mode === "preview"
						? { preview: { collection: "post", id } }
						: { dbIsIsolated: true };
			expect(timestamps((await read(undefined, context)).dates)).toEqual([april]);
			await waitForDeferredTasks();
			expect(timestamps((await read(undefined, context)).dates)).toEqual([april]);
			await waitForDeferredTasks();
			expect(timestamps((await read()).dates)).toEqual([march]);
			expect(contentReads()).toHaveLength(3);
		},
	);

	it("retries a failed read within the request without retaining its error in either cache", async () => {
		await seed("published", march);
		await enableCache();
		failNextRead = true;
		await runWithContext({ editMode: false, db }, async () => {
			const failed = await getPublishedDates("post");
			expect(failed.error).toBeInstanceOf(Error);
			expect(failed.dates).toEqual([]);
			await waitForDeferredTasks();
			const retried = await getPublishedDates("post");
			expect(retried.error).toBeUndefined();
			expect(timestamps(retried.dates)).toEqual([march]);
		});
		await waitForDeferredTasks();
		expect(timestamps((await read()).dates)).toEqual([march]);
		expect(contentReads()).toHaveLength(2);
	});

	it("does not cache a missing table as an empty collection", async () => {
		await enableCache();
		const load = () => runWithContext({ editMode: false, db }, () => getPublishedDates("missing"));
		const missing = await load();
		expect(missing.dates).toEqual([]);
		expect(missing.error).toBeUndefined();
		await waitForDeferredTasks();
		await sql`CREATE TABLE ec_missing (
			id TEXT PRIMARY KEY, published_at TEXT, updated_at TEXT,
			status TEXT, deleted_at TEXT, locale TEXT
		)`.execute(ctx.db);
		await sql`INSERT INTO ec_missing VALUES ('entry', ${march}, ${march}, 'published', NULL, 'en')`.execute(
			ctx.db,
		);
		expect(timestamps((await load()).dates)).toEqual([march]);
	});
});
