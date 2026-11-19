import type { Kysely } from "kysely";
import { afterEach, beforeEach, expect, it } from "vitest";

import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { SeoRepository } from "../../../src/database/repositories/seo.js";
import { TaxonomyRepository } from "../../../src/database/repositories/taxonomy.js";
import type { Database } from "../../../src/database/types.js";
import { setRoomNotifier } from "../../../src/rooms/notifications.js";
import { roomId } from "../../../src/rooms/types.js";
import { countQueries, RecordingNotifier } from "../../utils/room-notifier.js";
import {
	describeEachDialect,
	setupForDialectWithCollections,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

/** Orders notifications by room, for writers that notify several rooms in no set order. */
function byRoom(a: readonly unknown[], b: readonly unknown[]): number {
	return String(a[0]).localeCompare(String(b[0]));
}

describeEachDialect("Room notifications for values outside the document", (dialect) => {
	let ctx: DialectTestContext;
	let notifier: RecordingNotifier;

	beforeEach(async () => {
		ctx = await setupForDialectWithCollections(dialect);
		notifier = new RecordingNotifier();
		setRoomNotifier(notifier);
	});

	afterEach(async () => {
		setRoomNotifier(null);
		await teardownForDialect(ctx);
	});

	/** An entry in `collection`, with its room. */
	async function entry(collection: string, slug: string, translationOf?: string) {
		const item = await new ContentRepository(ctx.db).create({
			type: collection,
			data: { title: slug },
			slug,
			...(translationOf ? { locale: "fr", translationOf } : {}),
		});
		return { id: item.id, room: roomId({ collection, id: item.id }) };
	}

	it("names seo for an SEO write", async () => {
		const post = await entry("post", "seo");

		await new SeoRepository(ctx.db).upsert("post", post.id, { title: "Search title" });

		expect(await notifier.rooms()).toEqual([[post.room, ["seo"]]]);
	});

	it("names bylines for credits, and a byline delete notifies every entry it credited", async () => {
		const bylines = new BylineRepository(ctx.db);
		const ana = await bylines.create({ slug: "ana", displayName: "Ana" });
		const post = await entry("post", "credited");
		const page = await entry("page", "credited");

		await bylines.setContentBylines("post", post.id, [{ bylineId: ana.id }]);
		await bylines.setContentBylines("page", page.id, [{ bylineId: ana.id }]);
		expect(await notifier.rooms()).toEqual([
			[post.room, ["bylines"]],
			[page.room, ["bylines"]],
		]);

		await bylines.delete(ana.id);

		expect((await notifier.rooms()).toSorted(byRoom)).toEqual(
			[
				[post.room, ["bylines"]],
				[page.room, ["bylines"]],
			].toSorted(byRoom),
		);
	});

	it("names terms for assignment writes, in every locale of the entry", async () => {
		const taxonomies = new TaxonomyRepository(ctx.db);
		const news = await taxonomies.create({ name: "category", slug: "news", label: "News" });
		const sport = await taxonomies.create({ name: "category", slug: "sport", label: "Sport" });
		const en = await entry("post", "tagged");
		const fr = await entry("post", "tagged-fr", en.id);
		const bothLocales = [
			[en.room, ["terms"]],
			[fr.room, ["terms"]],
		];
		const group = news.translationGroup ?? news.id;

		await taxonomies.attachToEntry("post", en.id, news.id);
		expect((await notifier.rooms()).toSorted(byRoom)).toEqual(bothLocales.toSorted(byRoom));
		await taxonomies.setTermsForEntry("post", fr.id, "category", [news.id, sport.id]);
		expect((await notifier.rooms()).toSorted(byRoom)).toEqual(bothLocales.toSorted(byRoom));
		await taxonomies.detachFromEntry("post", en.id, sport.id);
		expect((await notifier.rooms()).toSorted(byRoom)).toEqual(bothLocales.toSorted(byRoom));
		await taxonomies.detachGroupsFromEntry("post", en.id, [group]);
		expect((await notifier.rooms()).toSorted(byRoom)).toEqual(bothLocales.toSorted(byRoom));
		await taxonomies.attachGroupsToEntry("post", en.id, [group]);
		await notifier.take();
		await taxonomies.clearEntryTerms("post", en.id);
		expect((await notifier.rooms()).toSorted(byRoom)).toEqual(bothLocales.toSorted(byRoom));
	});

	it("doesn't notify for assignment writes that change nothing", async () => {
		const taxonomies = new TaxonomyRepository(ctx.db);
		const news = await taxonomies.create({ name: "category", slug: "news", label: "News" });
		const post = await entry("post", "tagged");
		await taxonomies.attachToEntry("post", post.id, news.id);
		await notifier.take();

		await taxonomies.attachToEntry("post", post.id, news.id);
		await taxonomies.setTermsForEntry("post", post.id, "category", [news.id]);

		expect(await notifier.rooms()).toEqual([]);
	});

	it("notifies every locale of every entry a term delete unassigns", async () => {
		const taxonomies = new TaxonomyRepository(ctx.db);
		const news = await taxonomies.create({ name: "category", slug: "news", label: "News" });
		const en = await entry("post", "tagged");
		const fr = await entry("post", "tagged-fr", en.id);
		const page = await entry("page", "tagged");
		await taxonomies.attachToEntry("post", en.id, news.id);
		await taxonomies.attachToEntry("page", page.id, news.id);
		await notifier.take();

		await taxonomies.delete(news.id);

		expect((await notifier.rooms()).toSorted(byRoom)).toEqual(
			[
				[en.room, ["terms"]],
				[fr.room, ["terms"]],
				[page.room, ["terms"]],
			].toSorted(byRoom),
		);
	});

	it("runs no query to find entries while no room host is set", async () => {
		/** Queries a byline delete and a term delete and assignment run on `db`. */
		async function run(db: Kysely<Database>): Promise<void> {
			const bylines = new BylineRepository(db);
			const taxonomies = new TaxonomyRepository(db);
			const post = await entry("post", `post-${crypto.randomUUID()}`);
			const ana = await bylines.create({ slug: `ana-${crypto.randomUUID()}`, displayName: "Ana" });
			const term = await taxonomies.create({
				name: "category",
				slug: `news-${crypto.randomUUID()}`,
				label: "News",
			});
			await bylines.setContentBylines("post", post.id, [{ bylineId: ana.id }]);
			await taxonomies.attachToEntry("post", post.id, term.id);
			await bylines.delete(ana.id);
			await taxonomies.delete(term.id);
		}

		const withHost = countQueries(ctx.db);
		await run(withHost.db);
		setRoomNotifier(null);
		const withoutHost = countQueries(ctx.db);
		await run(withoutHost.db);

		expect(await notifier.take()).not.toEqual([]);
		// The byline delete's select, and the term writes' selects of the entry's locale rows.
		expect(withHost.count() - withoutHost.count()).toBe(4);
	});
});
