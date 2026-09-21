import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import { createRedirectAccess } from "../../../src/plugins/context.js";
import { detectLoops } from "../../../src/redirects/loops.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

describeEachDialect("plugin redirect optimistic concurrency", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- dialect test contexts use the same migrated Database schema
		db = ctx.db as unknown as Kysely<Database>;
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	it("guards configuration writes without conflicting on hit tracking", async () => {
		const access = createRedirectAccess(db, true);
		const created = await access.create({ source: "/old", destination: "/current" });
		await new RedirectRepository(db).recordHit(created.redirect.id);

		const updated = await access.update(created.redirect.id, {
			destination: "/latest",
			_rev: created._rev,
		});
		expect(updated.redirect).toMatchObject({ destination: "/latest", hits: 1 });
		await expect(
			access.update(created.redirect.id, {
				destination: "/lost",
				_rev: created._rev,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});

	it("serializes concurrent duplicate and loop-forming creates", async () => {
		const access = createRedirectAccess(db, true);
		const duplicates = await Promise.allSettled([
			access.create({ source: "/same", destination: "/first" }),
			access.create({ source: "/same", destination: "/second" }),
		]);
		expect(duplicates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(duplicates.filter((result) => result.status === "rejected")).toHaveLength(1);

		const loop = await Promise.allSettled([
			access.create({ source: "/a", destination: "/b" }),
			access.create({ source: "/b", destination: "/a" }),
		]);
		expect(loop.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(loop.filter((result) => result.status === "rejected")).toHaveLength(1);
		const redirects = await new RedirectRepository(db).findAllEnabled();
		expect(
			detectLoops(
				redirects.map((redirect) => ({
					id: redirect.id,
					source: redirect.source,
					destination: redirect.destination,
					enabled: redirect.enabled,
					isPattern: redirect.isPattern,
				})),
			),
		).toEqual([]);
	});

	it("serializes concurrent updates to different rows", async () => {
		const access = createRedirectAccess(db, true);
		const left = await access.create({ source: "/left", destination: "/safe-left" });
		const right = await access.create({ source: "/right", destination: "/safe-right" });
		const results = await Promise.allSettled([
			access.update(left.redirect.id, { destination: "/right", _rev: left._rev }),
			access.update(right.redirect.id, { destination: "/left", _rev: right._rev }),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

		const redirects = await new RedirectRepository(db).findAllEnabled();
		expect(
			detectLoops(
				redirects.map((redirect) => ({
					id: redirect.id,
					source: redirect.source,
					destination: redirect.destination,
					enabled: redirect.enabled,
					isPattern: redirect.isPattern,
				})),
			),
		).toEqual([]);
	});

	it("serializes legacy-shaped concurrent inserts after the schema expands", async () => {
		const results = await Promise.allSettled([
			sql`
				INSERT INTO _emdash_redirects (id, source, destination)
				VALUES ('legacy-a', '/legacy-a', '/legacy-b')
			`.execute(db),
			sql`
				INSERT INTO _emdash_redirects (id, source, destination)
				VALUES ('legacy-b', '/legacy-b', '/legacy-a')
			`.execute(db),
		]);
		expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
		expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
		const redirects = await new RedirectRepository(db).findAllEnabled();
		expect(detectLoops(redirects)).toEqual([]);
	});

	it("allows previous-runtime writes when an enabled pattern redirect exists", async () => {
		await sql`
			INSERT INTO _emdash_redirects (id, source, destination, is_pattern)
			VALUES ('legacy-pattern', '/docs/[slug]', '/guides/[slug]', 1)
		`.execute(db);
		await sql`
			INSERT INTO _emdash_redirects (id, source, destination)
			VALUES ('legacy-exact', '/old', '/new')
		`.execute(db);
		await sql`
			UPDATE _emdash_redirects SET destination = '/newer'
			WHERE id = 'legacy-exact'
		`.execute(db);

		await expect(new RedirectRepository(db).findBySource("/old")).resolves.toMatchObject({
			destination: "/newer",
		});
	});

	it("allows a previous-runtime update after a current-runtime write", async () => {
		const access = createRedirectAccess(db, true);
		const created = await access.create({
			source: "/managed",
			destination: "/current",
		});
		const repository = new RedirectRepository(db);
		const revisionBeforeLegacyUpdate = await repository.findConfigRevision(created.redirect.id);

		await expect(
			sql`
				UPDATE _emdash_redirects SET destination = '/legacy'
				WHERE id = ${created.redirect.id}
			`.execute(db),
		).resolves.toBeDefined();
		await expect(repository.findBySource("/managed")).resolves.toMatchObject({
			destination: "/legacy",
		});
		expect(await repository.findConfigRevision(created.redirect.id)).not.toBe(
			revisionBeforeLegacyUpdate,
		);
		await expect(
			access.update(created.redirect.id, {
				destination: "/stale",
				_rev: created._rev,
			}),
		).rejects.toMatchObject({ code: "CONFLICT" });
	});
});
