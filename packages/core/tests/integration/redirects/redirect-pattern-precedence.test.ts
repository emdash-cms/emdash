import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import type { Database } from "../../../src/database/types.js";
import {
	createRedirectSource,
	publishRedirectArtifacts,
} from "../../../src/redirects/artifacts.js";
import {
	invalidateRedirectCache,
	loadCachedRedirects,
	matchCachedPatterns,
} from "../../../src/redirects/cache.js";
import {
	type DialectTestContext,
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
} from "../../utils/test-db.js";

function patternRule(id: string, source: string, destination: string, createdAt: string) {
	return {
		id,
		source,
		destination,
		type: 301,
		is_pattern: 1,
		enabled: 1,
		hits: 0,
		auto: 0,
		created_at: createdAt,
		updated_at: createdAt,
	};
}

describeEachDialect("redirect pattern precedence", (dialect) => {
	let ctx: DialectTestContext;
	let db: Kysely<Database>;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- dialect test contexts use the same migrated Database schema
		db = ctx.db as unknown as Kysely<Database>;
		invalidateRedirectCache();
	});

	afterEach(async () => {
		invalidateRedirectCache();
		await teardownForDialect(ctx);
	});

	async function matchBoth(path: string) {
		const repo = new RedirectRepository(db);
		await publishRedirectArtifacts(db);
		const cached = await loadCachedRedirects(createRedirectSource(db));
		return {
			cached: matchCachedPatterns(cached.patterns, path)?.redirect.id,
			direct: (await repo.matchPath(path))?.redirect.id,
		};
	}

	it("matches the earliest-created overlapping pattern regardless of row order", async () => {
		await db
			.insertInto("_emdash_redirects")
			.values(
				patternRule("newer", "/blog/[...rest]", "/archive/[...rest]", "2026-02-01T00:00:00.000Z"),
			)
			.execute();
		await db
			.insertInto("_emdash_redirects")
			.values(patternRule("older", "/blog/[slug]", "/posts/[slug]", "2026-01-01T00:00:00.000Z"))
			.execute();

		await expect(matchBoth("/blog/hello")).resolves.toEqual({ cached: "older", direct: "older" });
	});

	it("breaks created_at ties by id", async () => {
		const createdAt = "2026-01-01T00:00:00.000Z";
		await db
			.insertInto("_emdash_redirects")
			.values(patternRule("b", "/blog/[...rest]", "/archive/[...rest]", createdAt))
			.execute();
		await db
			.insertInto("_emdash_redirects")
			.values(patternRule("a", "/blog/[slug]", "/posts/[slug]", createdAt))
			.execute();

		await expect(matchBoth("/blog/hello")).resolves.toEqual({ cached: "a", direct: "a" });
	});
});
