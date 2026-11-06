import { afterEach, beforeEach, expect, it } from "vitest";

import { RedirectRepository } from "../../../src/database/repositories/redirect.js";
import { importWxrPermalinks, type WxrPermalinkEntry } from "../../../src/import/wxr-permalinks.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const pattern = "/{slug}";
const retryError =
	"Could not finish WordPress permalink redirects; retry with skip existing enabled";

describeEachDialect("WordPress permalink redirect write-lock preflight", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function entry(title: string, options: Partial<WxrPermalinkEntry> = {}): WxrPermalinkEntry {
		return {
			title,
			collection: "posts",
			pattern,
			item: {
				id: title,
				slug: title,
				status: "published",
				publishedAt: "2024-01-01T00:00:00.000Z",
				locale: "en",
			},
			...options,
		};
	}

	async function holdRedirectWriteLock() {
		await ctx.db.deleteFrom("_emdash_redirect_write_lock").where("id", "=", 1).execute();
		await ctx.db
			.insertInto("_emdash_redirect_write_lock")
			.values({
				id: 1,
				token: "another-writer",
				expires_at: Date.now() + 60_000,
				generation: 1,
			})
			.execute();
	}

	it("does not need the write lock for entries with no redirect or owned cleanup work", async () => {
		await holdRedirectWriteLock();

		const result = await importWxrPermalinks(ctx.db, [
			entry("no-link"),
			entry("query", { link: "https://wp.test/?p=1" }),
			entry("same-canonical", { link: "https://wp.test/same-canonical" }),
		]);

		expect(result).toEqual([]);
	});

	it("reports only the candidate that cannot acquire the write lock", async () => {
		await holdRedirectWriteLock();

		const result = await importWxrPermalinks(ctx.db, [
			entry("candidate", { link: "https://wp.test/old-candidate" }),
			entry("no-link"),
			entry("query", { link: "https://wp.test/?p=1" }),
		]);

		expect(result).toEqual([{ title: "candidate", error: retryError }]);
	});

	it("reports only the entry whose canonical path needs owned-rule cleanup", async () => {
		const repo = new RedirectRepository(ctx.db);
		const rule = await repo.create({
			source: "/live/",
			destination: "/old",
			type: 301,
			enabled: true,
			auto: true,
			groupName: "WordPress import",
		});
		await holdRedirectWriteLock();

		const result = await importWxrPermalinks(ctx.db, [
			entry("cleanup", {
				item: {
					id: "live",
					slug: "live",
					status: "published",
					publishedAt: "2024-01-01T00:00:00.000Z",
					locale: "en",
				},
			}),
			entry("unrelated"),
		]);

		expect(result).toEqual([{ title: "cleanup", error: retryError }]);
		expect(await repo.findById(rule.id)).toEqual(rule);
	});
});
