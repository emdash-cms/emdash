import { afterEach, beforeEach, expect, it } from "vitest";

import { importContent as importPluginContent } from "../../../src/astro/routes/api/import/wordpress-plugin/execute.js";
import { importContent as importWxrContent } from "../../../src/astro/routes/api/import/wordpress/execute.js";
import type { EmDashHandlers, EmDashManifest } from "../../../src/astro/types.js";
import { parseWxrString } from "../../../src/cli/wxr/parser.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { interpolateUrlPattern } from "../../../src/i18n/resolve.js";
import { wxrPostToNormalizedItem } from "../../../src/import/sources/wxr.js";
import type { TaxonomyImportPlan } from "../../../src/import/wxr-taxonomies.js";
import { publishDueContent } from "../../../src/scheduled-publish.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { createTestRuntime, handlersFromRuntime } from "../../utils/mcp-runtime.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const ORIGINAL_DATE = "2020-06-15T12:30:00.000Z";
const EMPTY_TAXONOMY_PLAN: TaxonomyImportPlan = {
	termsCreated: {},
	termsReused: {},
	missingTaxonomies: [],
	termIdByNameAndSlug: new Map(),
	collectionsByTaxonomy: new Map(),
	translationGroupByTermId: new Map(),
};

const CONFIG = {
	postTypeMappings: { post: { collection: "post", enabled: true } },
	skipExisting: false,
};

function makeWxr(withDates = true): string {
	const posts = withDates
		? ["publish", "draft", "pending", "private", "custom-status", "future"]
		: ["draft"];
	return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:wp="http://wordpress.org/export/1.2/">
	<channel><title>Test</title><link>https://example.com</link>
		${posts
			.map(
				(status, i) => `<item>
			<title>Post ${i}</title>
			<wp:post_id>${i + 1}</wp:post_id>
			<wp:post_type>post</wp:post_type>
			<wp:status>${status}</wp:status>
			<wp:post_name>post-${i}</wp:post_name>
			${
				withDates
					? `<wp:post_date>2020-06-15 20:30:00</wp:post_date>
			<wp:post_date_gmt>2020-06-15 12:30:00</wp:post_date_gmt>`
					: ""
			}
		</item>`,
			)
			.join("\n")}
	</channel>
</rss>`;
}

function datePath(item: { id: string; slug: string | null; publishedAt: string | null }): string {
	return interpolateUrlPattern({
		pattern: "/{year}/{month}/{day}/{slug}",
		collection: "post",
		slug: item.slug ?? "",
		id: item.id,
		date: item.publishedAt,
	});
}

describeEachDialect("WordPress import dates", (dialect) => {
	let ctx: DialectTestContext;
	let emdash: EmDashHandlers;
	let manifest: EmDashManifest;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		await new SchemaRegistry(ctx.db).createField("post", {
			slug: "excerpt",
			label: "Excerpt",
			type: "text",
		});
		const runtime = createTestRuntime(ctx.db);
		emdash = handlersFromRuntime(runtime);
		manifest = await emdash.getManifest();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	for (const importer of ["wxr", "plugin"] as const) {
		it.each(["gmt", "local"])(
			`${importer} preserves %s source dates for published posts and drafts`,
			async (dateSource) => {
				const wxr = await parseWxrString(makeWxr());
				const expectedDate =
					dateSource === "gmt" ? ORIGINAL_DATE : new Date("2020-06-15T20:30:00").toISOString();
				if (dateSource === "local") {
					for (const post of wxr.posts) {
						post.postDateGmt = "0000-00-00 00:00:00";
						post.pubDate = "Mon, 30 Nov -0001 00:00:00 +0000";
					}
				}
				if (importer === "wxr") {
					const result = await importWxrContent(
						wxr.posts,
						CONFIG,
						emdash,
						manifest,
						new Map(),
						undefined,
						new Map(),
						EMPTY_TAXONOMY_PLAN,
					);
					expect(result.errors).toEqual([]);
				} else {
					const items = wxr.posts.map((post) => wxrPostToNormalizedItem(post, new Map(), ""));
					const result = await importPluginContent(items, CONFIG, emdash, manifest, undefined);
					expect(result.result.errors).toEqual([]);
				}

				const repo = new ContentRepository(ctx.db);
				for (const [slug, status] of [
					["post-0", "published"],
					["post-1", "draft"],
					["post-2", "draft"],
					["post-3", "draft"],
					["post-4", "draft"],
					["post-5", "draft"],
				] as const) {
					const item = await repo.findBySlug("post", slug);
					expect(item).toMatchObject({
						status,
						createdAt: expectedDate,
						publishedAt: expectedDate,
					});
					if (status === "draft") {
						const before = datePath(item!);
						expect(before).toBe(`/${expectedDate.slice(0, 10).replaceAll("-", "/")}/${slug}`);
						const published = await emdash.handleContentPublish("post", item!.id);
						expect(published.success).toBe(true);
						const after = await repo.findBySlug("post", slug);
						expect(after?.publishedAt).toBe(expectedDate);
						expect(datePath(after!)).toBe(before);
					}
				}
			},
		);

		it.each(["reschedule", "publish now", "schedule missed"])(
			`${importer} handles %s for WordPress future posts`,
			async (action) => {
				const wxr = await parseWxrString(makeWxr(false));
				const missedSchedule = action === "schedule missed";
				const post = {
					...wxr.posts[0],
					status: "future",
					postDateGmt: missedSchedule ? "2020-06-15 12:30:00" : "2099-06-15 12:30:00",
				};
				if (importer === "wxr") {
					const result = await importWxrContent(
						[post],
						CONFIG,
						emdash,
						manifest,
						new Map(),
						undefined,
						undefined,
						EMPTY_TAXONOMY_PLAN,
					);
					expect(result.errors).toEqual([]);
				} else {
					const { result } = await importPluginContent(
						[wxrPostToNormalizedItem(post, new Map(), "")],
						CONFIG,
						emdash,
						manifest,
						undefined,
					);
					expect(result.errors).toEqual([]);
				}
				const repo = new ContentRepository(ctx.db);
				const item = await repo.findBySlug("post", "post-0");
				expect(item).toMatchObject({
					status: missedSchedule ? "draft" : "scheduled",
					scheduledAt: missedSchedule ? null : "2099-06-15T12:30:00.000Z",
					publishedAt: missedSchedule ? ORIGINAL_DATE : null,
				});
				if (action === "publish now") {
					expect((await emdash.handleContentUnschedule("post", item!.id)).success).toBe(true);
					const before = Date.now();
					expect((await emdash.handleContentPublish("post", item!.id)).success).toBe(true);
					const published = await repo.findById("post", item!.id);
					expect(Date.parse(published!.publishedAt!)).toBeGreaterThanOrEqual(before);
					expect(Date.parse(published!.publishedAt!)).toBeLessThanOrEqual(Date.now());
					return;
				}
				const rescheduledAt = "2099-07-01T10:00:00.000Z";
				expect((await emdash.handleContentSchedule("post", item!.id, rescheduledAt)).success).toBe(
					true,
				);
				const published = await publishDueContent(ctx.db, {
					currentTime: new Date("2099-07-01T10:01:00.000Z"),
					publish: (collection, id, options) =>
						emdash.handleContentPublish(collection, id, options),
				});
				expect(published).toEqual([{ collection: "post", id: item!.id }]);
				const stored = await repo.findById("post", item!.id);
				expect(stored?.publishedAt).toBe(missedSchedule ? ORIGINAL_DATE : rescheduledAt);
				if (missedSchedule) expect(datePath(stored!)).toBe("/2020/06/15/post-0");
			},
		);
	}

	it("publishes a WXR draft with no date using the current time", async () => {
		const wxr = await parseWxrString(makeWxr(false));
		wxr.posts[0].postDateGmt = "0000-00-00 00:00:00";
		wxr.posts[0].postDate = "0000-00-00 00:00:00";
		wxr.posts[0].pubDate = "Mon, 30 Nov -0001 00:00:00 +0000";
		const result = await importWxrContent(
			wxr.posts,
			CONFIG,
			emdash,
			manifest,
			new Map(),
			undefined,
			new Map(),
			EMPTY_TAXONOMY_PLAN,
		);
		expect(result.errors).toEqual([]);
		const repo = new ContentRepository(ctx.db);
		const item = await repo.findBySlug("post", "post-0");
		expect(item?.publishedAt).toBeNull();
		const before = Date.now();
		const published = await emdash.handleContentPublish("post", item!.id);
		expect(published.success).toBe(true);
		const after = Date.now();
		const publishedAt = Date.parse((await repo.findBySlug("post", "post-0"))!.publishedAt!);
		expect(publishedAt).toBeGreaterThanOrEqual(before);
		expect(publishedAt).toBeLessThanOrEqual(after);
	});

	it("does not turn an invalid plugin date into a publication date", async () => {
		const wxr = await parseWxrString(makeWxr());
		const item = wxrPostToNormalizedItem(wxr.posts[1]!, new Map(), "");
		item.date = new Date("invalid");
		const result = await importPluginContent(
			[{ ...item, slug: "invalid-date", status: "draft" }],
			CONFIG,
			emdash,
			manifest,
			undefined,
		);
		expect(result.result.errors).toEqual([]);
		const stored = await new ContentRepository(ctx.db).findBySlug("post", "invalid-date");
		expect(stored?.publishedAt).toBeNull();
	});
});
