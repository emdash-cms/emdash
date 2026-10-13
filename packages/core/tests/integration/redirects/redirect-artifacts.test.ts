import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { up as migrateRedirectArtifacts } from "../../../src/database/migrations/091_redirect_artifacts.js";
import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import { waitForDeferredTasks } from "../../../src/deferred-tasks.js";
import {
	createRedirectSource,
	publishRedirectArtifacts,
} from "../../../src/redirects/artifacts.js";
import { invalidateRedirectCache } from "../../../src/redirects/cache.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

function redirectRow(
	id: string,
	source: string,
	destination: string,
	options: { isPattern?: boolean; createdAt?: string } = {},
) {
	const createdAt = options.createdAt ?? "2026-01-01T00:00:00.000Z";
	return {
		id,
		source,
		destination,
		type: 301,
		is_pattern: options.isPattern ? 1 : 0,
		enabled: 1,
		hits: 0,
		auto: 0,
		created_at: createdAt,
		updated_at: createdAt,
	};
}

describeEachDialect("redirect artifacts", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;
	let repo: RedirectRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- dialect test contexts use the same migrated Database schema
		db = ctx.db as unknown as Kysely<Database>;
		repo = new RedirectRepository(db);
		invalidateRedirectCache();
	});

	afterEach(async () => {
		await waitForDeferredTasks();
		invalidateRedirectCache();
		await teardownForDialect(ctx);
	});

	async function state() {
		const row = await db
			.selectFrom("_emdash_redirect_state")
			.selectAll()
			.where("id", "=", 1)
			.executeTakeFirstOrThrow();
		return {
			revision: Number(row.revision),
			generation: row.generation,
			generationRevision: Number(row.generation_revision),
		};
	}

	async function revision() {
		return (await state()).revision;
	}

	async function insertMany(rows: ReturnType<typeof redirectRow>[]) {
		for (let i = 0; i < rows.length; i += 100) {
			await db
				.insertInto("_emdash_redirects")
				.values(rows.slice(i, i + 100))
				.execute();
		}
	}

	async function artifactDigests(kind: "exact" | "pattern") {
		const rows = await db
			.selectFrom("_emdash_redirect_artifacts")
			.select("digest")
			.where("kind", "=", kind)
			.execute();
		return new Set(rows.map((row) => row.digest));
	}

	it("restarts the migration without disturbing existing state", async () => {
		await repo.create({ source: "/a", destination: "/b" });
		await publishRedirectArtifacts(db);
		const before = await state();

		await migrateRedirectArtifacts(db);
		await repo.create({ source: "/c", destination: "/d" });

		expect(await state()).toEqual({ ...before, revision: before.revision + 1 });
	});

	it("bumps the revision only for changes that affect enabled rules", async () => {
		let expected = await revision();

		const enabled = await repo.create({ source: "/a", destination: "/b" });
		expect(await revision()).toBe(++expected);

		const disabled = await repo.create({ source: "/c", destination: "/d", enabled: false });
		expect(await revision()).toBe(expected);

		await repo.recordHit(enabled.id);
		await repo.update(enabled.id, { groupName: "moved" });
		expect(await revision()).toBe(expected);

		await repo.update(enabled.id, { destination: "/other" });
		expect(await revision()).toBe(++expected);

		await repo.update(disabled.id, { destination: "/elsewhere" });
		expect(await revision()).toBe(expected);

		await repo.update(disabled.id, { enabled: true });
		expect(await revision()).toBe(++expected);

		await repo.update(disabled.id, { enabled: false });
		expect(await revision()).toBe(++expected);

		await repo.delete(disabled.id);
		expect(await revision()).toBe(expected);

		await repo.delete(enabled.id);
		expect(await revision()).toBe(++expected);
	});

	it("loads the published rules in one query", async () => {
		await repo.create({ source: "/old", destination: "/new", type: 308 });
		await repo.create({ source: "/blog/[slug]", destination: "/posts/[slug]" });
		await repo.create({ source: "/off", destination: "/x", enabled: false });
		await publishRedirectArtifacts(db);

		let queries = 0;
		const counted = db.withPlugin({
			transformQuery(args) {
				queries++;
				return args.node;
			},
			async transformResult(args) {
				return args.result;
			},
		});
		const loaded = await createRedirectSource(counted).load();

		expect(queries).toBe(1);
		expect(loaded.version).toBe((await state()).generation);
		expect(loaded.exact).toEqual([
			expect.objectContaining({ source: "/old", destination: "/new", type: 308 }),
		]);
		expect(loaded.patterns).toEqual([
			expect.objectContaining({ source: "/blog/[slug]", destination: "/posts/[slug]" }),
		]);
	});

	it("publishes an empty rule set that loads without falling back", async () => {
		await publishRedirectArtifacts(db);
		const findAllEnabled = RedirectRepository.prototype.findAllEnabled;
		let fallbacks = 0;
		RedirectRepository.prototype.findAllEnabled = async function () {
			fallbacks++;
			return findAllEnabled.call(this);
		};
		try {
			const loaded = await createRedirectSource(db).load();
			expect(loaded).toEqual({ version: (await state()).generation, exact: [], patterns: [] });
			expect(fallbacks).toBe(0);
		} finally {
			RedirectRepository.prototype.findAllEnabled = findAllEnabled;
		}
	});

	it("splits large rule sets and keeps pattern precedence across chunks", async () => {
		const padding = "x".repeat(200);
		const rows: ReturnType<typeof redirectRow>[] = [];
		for (let i = 0; i < 800; i++) {
			const n = String(i).padStart(4, "0");
			rows.push(redirectRow(`e${n}`, `/exact/${n}`, `/to/${padding}/${n}`));
			rows.push(
				redirectRow(`p${n}`, `/pattern/${n}/[slug]`, `/to/${padding}/[slug]`, {
					isPattern: true,
					createdAt: `2026-01-01T00:00:${String(59 - (i % 60)).padStart(2, "0")}.000Z`,
				}),
			);
		}
		await insertMany(rows);
		await publishRedirectArtifacts(db);

		expect((await artifactDigests("exact")).size).toBeGreaterThan(1);
		expect((await artifactDigests("pattern")).size).toBeGreaterThan(1);

		const loaded = await createRedirectSource(db).load();
		const direct = await repo.findAllEnabled();
		expect(loaded.version).not.toBeNull();
		expect(loaded.exact.map((rule) => rule.id).toSorted()).toEqual(
			direct
				.filter((rule) => !rule.isPattern)
				.map((rule) => rule.id)
				.toSorted(),
		);
		expect(loaded.patterns.map((rule) => rule.id)).toEqual(
			direct.filter((rule) => rule.isPattern).map((rule) => rule.id),
		);
	});

	it("rewrites one exact shard when one exact rule changes", async () => {
		const padding = "x".repeat(200);
		const rows: ReturnType<typeof redirectRow>[] = [];
		for (let i = 0; i < 1000; i++) {
			const n = String(i).padStart(4, "0");
			rows.push(redirectRow(`e${n}`, `/exact/${n}`, `/to/${padding}/${n}`));
		}
		await insertMany(rows);
		await publishRedirectArtifacts(db);
		const before = await artifactDigests("exact");
		expect(before.size).toBeGreaterThan(2);

		await db
			.updateTable("_emdash_redirects")
			.set({ destination: `/to/${padding}/changed` })
			.where("id", "=", "e0500")
			.execute();
		await publishRedirectArtifacts(db);
		const after = await artifactDigests("exact");

		expect(after.size).toBe(before.size);
		expect([...after].filter((digest) => !before.has(digest))).toHaveLength(1);
	});

	it("reads the rules table while the generation is stale and repairs it in the background", async () => {
		const rule = await repo.create({ source: "/old", destination: "/new" });
		await publishRedirectArtifacts(db);
		const published = await state();

		await repo.update(rule.id, { destination: "/newer" });
		const source = createRedirectSource(db);
		const stale = await source.load();
		expect(stale.version).toBeNull();
		expect(stale.exact[0]?.destination).toBe("/newer");

		await waitForDeferredTasks();
		const repaired = await state();
		expect(repaired.generation).not.toBe(published.generation);
		expect(repaired.generationRevision).toBe(repaired.revision);
		const loaded = await source.load();
		expect(loaded.version).toBe(repaired.generation);
		expect(loaded.exact[0]?.destination).toBe("/newer");
	});

	it("reads the rules table when a rule was reordered after publishing", async () => {
		await db
			.insertInto("_emdash_redirects")
			.values([
				redirectRow("first", "/blog/[slug]", "/posts/[slug]", {
					isPattern: true,
					createdAt: "2026-01-01T00:00:00.000Z",
				}),
				redirectRow("second", "/blog/[...rest]", "/archive/[...rest]", {
					isPattern: true,
					createdAt: "2026-01-02T00:00:00.000Z",
				}),
			])
			.execute();
		await publishRedirectArtifacts(db);

		await db
			.updateTable("_emdash_redirects")
			.set({ created_at: "2025-12-31T00:00:00.000Z" })
			.where("id", "=", "second")
			.execute();

		const loaded = await createRedirectSource(db).load();
		expect(loaded.patterns.map((rule) => rule.id)).toEqual(["second", "first"]);
	});

	it("reports a published generation as current until another one replaces it", async () => {
		await repo.create({ source: "/a", destination: "/b" });
		await publishRedirectArtifacts(db);
		const source = createRedirectSource(db);
		const { version } = await source.load();

		expect(await source.isCurrent(version!)).toBe(true);

		await repo.create({ source: "/c", destination: "/d" });
		expect(await source.isCurrent(version!)).toBe(false);

		await publishRedirectArtifacts(db);
		expect(await source.isCurrent(version!)).toBe(false);
	});

	it("falls back to the rules table when an artifact payload was altered, then republishes", async () => {
		await repo.create({ source: "/old", destination: "/new" });
		await publishRedirectArtifacts(db);
		await db
			.updateTable("_emdash_redirect_artifacts")
			.set({ payload: JSON.stringify([["forged", "/old", "https://evil.example", 301]]) })
			.execute();

		const loaded = await createRedirectSource(db).load();
		expect(loaded.version).toBeNull();
		expect(loaded.exact).toEqual([
			expect.objectContaining({ source: "/old", destination: "/new" }),
		]);

		await waitForDeferredTasks();
		const repaired = await createRedirectSource(db).load();
		expect(repaired.version).toBe((await state()).generation);
		expect(repaired.exact[0]?.destination).toBe("/new");
	});

	it("falls back to the rules table when an artifact link is missing", async () => {
		await repo.create({ source: "/old", destination: "/new" });
		await repo.create({ source: "/blog/[slug]", destination: "/posts/[slug]" });
		await publishRedirectArtifacts(db);
		await db
			.deleteFrom("_emdash_redirect_generation_artifacts")
			.where("position", "=", 0)
			.execute();

		const loaded = await createRedirectSource(db).load();

		expect(loaded.version).toBeNull();
		expect(loaded.exact).toHaveLength(1);
		expect(loaded.patterns).toHaveLength(1);

		await waitForDeferredTasks();
		expect((await createRedirectSource(db).load()).version).toBe((await state()).generation);
	});

	it("repairs a generation whose links point at the wrong artifacts", async () => {
		await repo.create({ source: "/old", destination: "/new" });
		await repo.create({ source: "/blog/[slug]", destination: "/posts/[slug]" });
		await publishRedirectArtifacts(db);
		const { generation } = await state();
		const links = await db
			.selectFrom("_emdash_redirect_generation_artifacts")
			.selectAll()
			.where("generation", "=", generation!)
			.orderBy("position")
			.execute();
		expect(links).toHaveLength(2);
		await db
			.updateTable("_emdash_redirect_generation_artifacts")
			.set({ digest: links[1]!.digest })
			.where("generation", "=", generation!)
			.where("position", "=", 0)
			.execute();
		await db
			.insertInto("_emdash_redirect_generation_artifacts")
			.values({ generation: generation!, position: 2, digest: links[0]!.digest })
			.execute();

		expect((await createRedirectSource(db).load()).version).toBeNull();

		await waitForDeferredTasks();
		const repaired = await createRedirectSource(db).load();
		expect(repaired.version).toBe(generation);
		expect(repaired.exact).toHaveLength(1);
		expect(repaired.patterns).toHaveLength(1);
	});

	it("reads the rules table before the artifact tables exist", async () => {
		await repo.create({ source: "/old", destination: "/new" });
		await sql`DROP TABLE _emdash_redirect_generation_artifacts`.execute(db);

		const loaded = await createRedirectSource(db).load();

		expect(loaded.version).toBeNull();
		expect(loaded.exact).toEqual([
			expect.objectContaining({ source: "/old", destination: "/new" }),
		]);
	});
});
