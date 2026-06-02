import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { BylineRepository } from "../../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../../src/database/repositories/content.js";
import type { Database } from "../../../../src/database/types.js";
import { SQL_BATCH_SIZE } from "../../../../src/utils/chunks.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../../utils/test-db.js";

describe("BylineRepository", () => {
	let db: Kysely<Database>;
	let bylineRepo: BylineRepository;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		bylineRepo = new BylineRepository(db);
		contentRepo = new ContentRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("creates and reads bylines", async () => {
		const created = await bylineRepo.create({
			slug: "jane-doe",
			displayName: "Jane Doe",
			isGuest: true,
		});

		expect(created.slug).toBe("jane-doe");
		expect(created.displayName).toBe("Jane Doe");
		expect(created.isGuest).toBe(true);

		const foundById = await bylineRepo.findById(created.id);
		expect(foundById?.id).toBe(created.id);

		const foundBySlug = await bylineRepo.findBySlug("jane-doe");
		expect(foundBySlug?.id).toBe(created.id);

		const foundByUser = await bylineRepo.findByUserId("missing-user");
		expect(foundByUser).toBeNull();
	});

	it("supports updates and paginated listing", async () => {
		const alpha = await bylineRepo.create({
			slug: "alpha",
			displayName: "Alpha Writer",
			isGuest: true,
		});
		await bylineRepo.create({
			slug: "beta",
			displayName: "Beta Writer",
			isGuest: false,
		});

		const updated = await bylineRepo.update(alpha.id, {
			displayName: "Alpha Updated",
			websiteUrl: "https://example.com",
		});
		expect(updated?.displayName).toBe("Alpha Updated");
		expect(updated?.websiteUrl).toBe("https://example.com");

		const searchResult = await bylineRepo.findMany({ search: "Beta" });
		expect(searchResult.items).toHaveLength(1);
		expect(searchResult.items[0]?.slug).toBe("beta");

		const page1 = await bylineRepo.findMany({ limit: 1 });
		expect(page1.items).toHaveLength(1);
		expect(page1.nextCursor).toBeTruthy();

		const page2 = await bylineRepo.findMany({ limit: 1, cursor: page1.nextCursor });
		expect(page2.items).toHaveLength(1);
		expect(page2.items[0]?.id).not.toBe(page1.items[0]?.id);
	});

	it("assigns ordered bylines to content and syncs primary_byline_id", async () => {
		const lead = await bylineRepo.create({
			slug: "lead",
			displayName: "Lead Author",
		});
		const second = await bylineRepo.create({
			slug: "second",
			displayName: "Second Author",
		});

		const content = await contentRepo.create({
			type: "post",
			slug: "bylined-post",
			data: { title: "Bylined Post" },
		});

		const assigned = await bylineRepo.setContentBylines("post", content.id, [
			{ bylineId: lead.id },
			{ bylineId: second.id, roleLabel: "Editor" },
		]);

		expect(assigned).toHaveLength(2);
		expect(assigned[0]?.byline.id).toBe(lead.id);
		expect(assigned[0]?.sortOrder).toBe(0);
		expect(assigned[1]?.byline.id).toBe(second.id);
		expect(assigned[1]?.roleLabel).toBe("Editor");

		const refreshed = await contentRepo.findById("post", content.id);
		expect(refreshed?.primaryBylineId).toBe(lead.id);
	});

	it("reorders bylines and updates primary_byline_id", async () => {
		const first = await bylineRepo.create({
			slug: "first",
			displayName: "First",
		});
		const second = await bylineRepo.create({
			slug: "second-reorder",
			displayName: "Second",
		});

		const content = await contentRepo.create({
			type: "post",
			slug: "reordered-post",
			data: { title: "Reordered" },
		});

		await bylineRepo.setContentBylines("post", content.id, [
			{ bylineId: first.id },
			{ bylineId: second.id },
		]);

		await bylineRepo.setContentBylines("post", content.id, [
			{ bylineId: second.id },
			{ bylineId: first.id },
		]);

		const refreshed = await contentRepo.findById("post", content.id);
		expect(refreshed?.primaryBylineId).toBe(second.id);

		const bylines = await bylineRepo.getContentBylines("post", content.id);
		expect(bylines[0]?.byline.id).toBe(second.id);
		expect(bylines[1]?.byline.id).toBe(first.id);
	});

	it("hydrates avatar storage key and alt via the media join", async () => {
		// A media row standing in for an uploaded avatar.
		await db
			.insertInto("media")
			.values({
				id: "media-avatar-1",
				filename: "jane.png",
				mime_type: "image/png",
				storage_key: "media-avatar-1.png",
				status: "ready",
				alt: "Jane Doe headshot",
			})
			.execute();

		const withAvatar = await bylineRepo.create({
			slug: "with-avatar",
			displayName: "With Avatar",
			avatarMediaId: "media-avatar-1",
		});
		const withoutAvatar = await bylineRepo.create({
			slug: "without-avatar",
			displayName: "Without Avatar",
		});

		const content = await contentRepo.create({
			type: "post",
			slug: "avatar-post",
			data: { title: "Avatar Post" },
		});
		await bylineRepo.setContentBylines("post", content.id, [
			{ bylineId: withAvatar.id },
			{ bylineId: withoutAvatar.id },
		]);

		// Single-entry hydration path.
		const credits = await bylineRepo.getContentBylines("post", content.id);
		const avatared = credits.find((c) => c.byline.id === withAvatar.id)!;
		const plain = credits.find((c) => c.byline.id === withoutAvatar.id)!;
		expect(avatared.byline.avatarMediaId).toBe("media-avatar-1");
		expect(avatared.byline.avatarStorageKey).toBe("media-avatar-1.png");
		expect(avatared.byline.avatarAlt).toBe("Jane Doe headshot");
		// No avatar -> storage key and alt are null, not undefined.
		expect(plain.byline.avatarStorageKey).toBeNull();
		expect(plain.byline.avatarAlt).toBeNull();

		// Batch hydration path (the list-page case) resolves the same data
		// without a per-byline media lookup.
		const batch = await bylineRepo.getContentBylinesMany("post", [content.id]);
		const batchCredit = batch.get(content.id)!.find((c) => c.byline.id === withAvatar.id)!;
		expect(batchCredit.byline.avatarStorageKey).toBe("media-avatar-1.png");
		expect(batchCredit.byline.avatarAlt).toBe("Jane Doe headshot");
	});

	it("hydrates avatar storage key for author-inferred bylines via findByUserIds", async () => {
		await db
			.insertInto("media")
			.values({
				id: "media-avatar-3",
				filename: "u.png",
				mime_type: "image/png",
				storage_key: "media-avatar-3.png",
				status: "ready",
				alt: "User avatar",
			})
			.execute();
		await db
			.insertInto("users")
			.values({
				id: "user-123",
				email: "linked@example.com",
				name: "Linked User",
				role: 30,
				email_verified: 1,
			})
			.execute();
		// A byline linked to a CMS user (the author-fallback path resolves
		// these via findByUserIds when an entry has no explicit credits).
		const byline = await bylineRepo.create({
			slug: "linked-user",
			displayName: "Linked User",
			userId: "user-123",
			avatarMediaId: "media-avatar-3",
		});
		expect(byline.id).toBeTruthy();

		const map = await bylineRepo.findByUserIds(["user-123"]);
		const resolved = map.get("user-123");
		expect(resolved?.avatarStorageKey).toBe("media-avatar-3.png");
		expect(resolved?.avatarAlt).toBe("User avatar");
	});

	it("leaves avatar storage key null on the plain byline finders", async () => {
		await db
			.insertInto("media")
			.values({
				id: "media-avatar-2",
				filename: "x.png",
				mime_type: "image/png",
				storage_key: "media-avatar-2.png",
				status: "ready",
			})
			.execute();
		const created = await bylineRepo.create({
			slug: "finder-avatar",
			displayName: "Finder Avatar",
			avatarMediaId: "media-avatar-2",
		});

		// findById/findBySlug don't join media — the field is null there, and
		// callers should rely on the content-credit hydration path for it.
		const byId = await bylineRepo.findById(created.id);
		expect(byId?.avatarMediaId).toBe("media-avatar-2");
		expect(byId?.avatarStorageKey).toBeNull();
	});

	it("getContentBylinesMany handles more IDs than SQL_BATCH_SIZE", async () => {
		const byline = await bylineRepo.create({
			slug: "batch-author",
			displayName: "Batch Author",
		});

		// Create a few real content entries with bylines
		const realIds: string[] = [];
		for (let i = 0; i < 3; i++) {
			const content = await contentRepo.create({
				type: "post",
				slug: `batch-post-${i}`,
				data: { title: `Batch Post ${i}` },
			});
			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: byline.id }]);
			realIds.push(content.id);
		}

		// Build an ID list larger than SQL_BATCH_SIZE with the real IDs spread across chunks
		const ids: string[] = [];
		for (let i = 0; i < SQL_BATCH_SIZE + 10; i++) {
			ids.push(`fake-id-${i}`);
		}
		// Place real IDs so they span different chunks
		ids[0] = realIds[0]!;
		ids[SQL_BATCH_SIZE - 1] = realIds[1]!;
		ids[SQL_BATCH_SIZE + 5] = realIds[2]!;

		const result = await bylineRepo.getContentBylinesMany("post", ids);

		// All 3 real entries should have their byline resolved
		expect(result.get(realIds[0]!)).toHaveLength(1);
		expect(result.get(realIds[1]!)).toHaveLength(1);
		expect(result.get(realIds[2]!)).toHaveLength(1);
		expect(result.get(realIds[0]!)![0]!.byline.id).toBe(byline.id);
	});

	it("getContentBylinesMany does not duplicate credits for repeated content IDs", async () => {
		const byline = await bylineRepo.create({
			slug: "duplicate-batch-author",
			displayName: "Duplicate Batch Author",
		});

		const content = await contentRepo.create({
			type: "post",
			slug: "duplicate-batch-post",
			data: { title: "Duplicate Batch Post" },
		});
		await bylineRepo.setContentBylines("post", content.id, [{ bylineId: byline.id }]);

		const ids: string[] = [];
		for (let i = 0; i < SQL_BATCH_SIZE + 10; i++) {
			ids.push(`fake-id-${i}`);
		}
		ids[0] = content.id;
		ids[SQL_BATCH_SIZE + 5] = content.id;

		const result = await bylineRepo.getContentBylinesMany("post", ids);

		expect(result.get(content.id)).toHaveLength(1);
		expect(result.get(content.id)?.[0]?.byline.id).toBe(byline.id);
	});

	it("findByUserIds handles more IDs than SQL_BATCH_SIZE", async () => {
		// Create a real user so the FK constraint is satisfied
		const userId = "user-batch-test";
		await db
			.insertInto("users" as any)
			.values({ id: userId, email: "batch@test.com", name: "Batch", role: 50 })
			.execute();

		const byline = await bylineRepo.create({
			slug: "user-batch",
			displayName: "User Batch",
			userId,
		});

		// Build a user ID list larger than SQL_BATCH_SIZE
		const userIds: string[] = [];
		for (let i = 0; i < SQL_BATCH_SIZE + 10; i++) {
			userIds.push(`user-fake-${i}`);
		}
		userIds[SQL_BATCH_SIZE + 5] = userId;

		const result = await bylineRepo.findByUserIds(userIds);

		expect(result.size).toBe(1);
		expect(result.get(userId)?.id).toBe(byline.id);
	});

	it("deletes byline, removes links, and nulls primary_byline_id", async () => {
		const byline = await bylineRepo.create({
			slug: "delete-me",
			displayName: "Delete Me",
		});

		const content = await contentRepo.create({
			type: "post",
			slug: "delete-byline-post",
			data: { title: "Delete Byline" },
		});

		await bylineRepo.setContentBylines("post", content.id, [{ bylineId: byline.id }]);

		const deleted = await bylineRepo.delete(byline.id);
		expect(deleted).toBe(true);

		const unresolved = await bylineRepo.getContentBylines("post", content.id);
		expect(unresolved).toHaveLength(0);

		const refreshed = await contentRepo.findById("post", content.id);
		expect(refreshed?.primaryBylineId).toBeNull();
	});

	describe("i18n (migration 040)", () => {
		it("create() mints translation_group equal to id for anchors", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
			});

			expect(anchor.translationGroup).toBe(anchor.id);
			expect(anchor.locale).toBe("en");
		});

		it("create({ translationOf }) joins the source's translation_group", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});

			const translation = await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			expect(translation.translationGroup).toBe(anchor.id);
			expect(translation.locale).toBe("fr");
			expect(translation.id).not.toBe(anchor.id);
		});

		it("create({ translationOf }) throws when the source byline is missing", async () => {
			await expect(
				bylineRepo.create({
					slug: "ghost",
					displayName: "Ghost",
					translationOf: "non-existent-id",
				}),
			).rejects.toThrow(/Source byline for translation not found/);
		});

		it("(slug, locale) is unique — same slug across locales is allowed", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			const sibling = await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			expect(anchor.slug).toBe(sibling.slug);
			expect(anchor.translationGroup).toBe(sibling.translationGroup);
		});

		it("findBySlug filters strictly by locale when provided", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const enHit = await bylineRepo.findBySlug("jane", { locale: "en" });
			const frHit = await bylineRepo.findBySlug("jane", { locale: "fr" });
			const deMiss = await bylineRepo.findBySlug("jane", { locale: "de" });

			expect(enHit?.displayName).toBe("Jane Doe");
			expect(frHit?.displayName).toBe("Jeanne");
			expect(deMiss).toBeNull();
		});

		it("findByUserId filters strictly by locale when provided", async () => {
			const userId = "user-i18n-1";
			await db
				.insertInto("users" as any)
				.values({ id: userId, email: "u@test.com", name: "U", role: 50 })
				.execute();

			const anchor = await bylineRepo.create({
				slug: "user-byline",
				displayName: "User Byline",
				userId,
				locale: "en",
			});
			await bylineRepo.create({
				slug: "user-byline",
				displayName: "User Byline FR",
				userId,
				locale: "fr",
				translationOf: anchor.id,
			});

			const enHit = await bylineRepo.findByUserId(userId, { locale: "en" });
			const frHit = await bylineRepo.findByUserId(userId, { locale: "fr" });
			const deMiss = await bylineRepo.findByUserId(userId, { locale: "de" });

			expect(enHit?.displayName).toBe("User Byline");
			expect(frHit?.displayName).toBe("User Byline FR");
			expect(deMiss).toBeNull();
		});

		it("findMany filters strictly by locale", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});
			await bylineRepo.create({
				slug: "ada",
				displayName: "Ada",
				locale: "en",
			});

			const en = await bylineRepo.findMany({ locale: "en" });
			const fr = await bylineRepo.findMany({ locale: "fr" });
			const de = await bylineRepo.findMany({ locale: "de" });

			expect(en.items.map((b) => b.slug).toSorted()).toEqual(["ada", "jane"]);
			expect(fr.items).toHaveLength(1);
			expect(fr.items[0]?.displayName).toBe("Jeanne");
			expect(de.items).toHaveLength(0);
		});

		it("setContentBylines stores translation_group in the junction (not row id)", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const content = await contentRepo.create({
				type: "post",
				slug: "i18n-credited-post",
				data: { title: "Credited" },
			});

			// Editor credits the fr row — server should normalise to the group.
			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: fr.id }]);

			const rows = await db
				.selectFrom("_emdash_content_bylines")
				.select(["byline_id"])
				.where("content_id", "=", content.id)
				.execute();
			expect(rows[0]?.byline_id).toBe(anchor.id);
			expect(rows[0]?.byline_id).toBe(anchor.translationGroup);
		});

		it("setContentBylines sets primary_byline_id to the translation_group", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const content = await contentRepo.create({
				type: "post",
				slug: "i18n-primary-post",
				data: { title: "Primary" },
			});

			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: fr.id }]);

			const refreshed = await contentRepo.findById("post", content.id);
			expect(refreshed?.primaryBylineId).toBe(anchor.translationGroup);
		});

		it("getContentBylines returns the row at the requested locale", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const content = await contentRepo.create({
				type: "post",
				slug: "i18n-hydrated-post",
				data: { title: "Hydrated" },
			});

			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: anchor.id }]);

			const enCredits = await bylineRepo.getContentBylines("post", content.id, { locale: "en" });
			const frCredits = await bylineRepo.getContentBylines("post", content.id, { locale: "fr" });

			expect(enCredits[0]?.byline.displayName).toBe("Jane Doe");
			expect(frCredits[0]?.byline.displayName).toBe("Jeanne");
			expect(frCredits[0]?.byline.id).toBe(fr.id);
		});

		it("getContentBylines is strict — credits with no row at the requested locale are omitted", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});

			const content = await contentRepo.create({
				type: "post",
				slug: "i18n-strict-post",
				data: { title: "Strict" },
			});

			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: anchor.id }]);

			// No fr row exists for this byline. Strict hydration returns nothing.
			const frCredits = await bylineRepo.getContentBylines("post", content.id, { locale: "fr" });
			expect(frCredits).toHaveLength(0);

			// DB-level credit still exists — the junction wasn't dropped, it
			// just resolves to no presentation at this locale.
			const junction = await db
				.selectFrom("_emdash_content_bylines")
				.select(["byline_id"])
				.where("content_id", "=", content.id)
				.execute();
			expect(junction).toHaveLength(1);
			expect(junction[0]?.byline_id).toBe(anchor.id);
		});

		it("getContentBylines without a locale returns every locale variant of the credit", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const content = await contentRepo.create({
				type: "post",
				slug: "i18n-no-locale-post",
				data: { title: "No locale filter" },
			});

			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: anchor.id }]);

			const all = await bylineRepo.getContentBylines("post", content.id);
			expect(all).toHaveLength(2);
			expect(all.map((c) => c.byline.locale).toSorted()).toEqual(["en", "fr"]);
		});

		it("getContentBylinesMany is strict per requested locale", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const enPost = await contentRepo.create({
				type: "post",
				slug: "en-batch",
				data: { title: "EN" },
			});
			const frPost = await contentRepo.create({
				type: "post",
				slug: "fr-batch",
				data: { title: "FR" },
			});

			await bylineRepo.setContentBylines("post", enPost.id, [{ bylineId: anchor.id }]);
			await bylineRepo.setContentBylines("post", frPost.id, [{ bylineId: anchor.id }]);

			const enResult = await bylineRepo.getContentBylinesMany("post", [enPost.id, frPost.id], {
				locale: "en",
			});
			expect(enResult.get(enPost.id)?.[0]?.byline.displayName).toBe("Jane Doe");
			expect(enResult.get(frPost.id)?.[0]?.byline.displayName).toBe("Jane Doe");

			const frResult = await bylineRepo.getContentBylinesMany("post", [enPost.id, frPost.id], {
				locale: "fr",
			});
			expect(frResult.get(enPost.id)?.[0]?.byline.displayName).toBe("Jeanne");
			expect(frResult.get(frPost.id)?.[0]?.byline.displayName).toBe("Jeanne");
		});

		it("copyContentBylines clones junction rows verbatim", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
			});
			const co = await bylineRepo.create({
				slug: "co",
				displayName: "Co-author",
			});

			const source = await contentRepo.create({
				type: "post",
				slug: "src",
				data: { title: "Source" },
			});
			const target = await contentRepo.create({
				type: "post",
				slug: "tgt",
				data: { title: "Target" },
			});

			await bylineRepo.setContentBylines("post", source.id, [
				{ bylineId: anchor.id },
				{ bylineId: co.id, roleLabel: "Editor" },
			]);

			await bylineRepo.copyContentBylines("post", source.id, target.id);

			const credits = await bylineRepo.getContentBylines("post", target.id, { locale: "en" });
			expect(credits).toHaveLength(2);
			expect(credits[0]?.byline.id).toBe(anchor.id);
			expect(credits[1]?.byline.id).toBe(co.id);
			expect(credits[1]?.roleLabel).toBe("Editor");

			const tgt = await contentRepo.findById("post", target.id);
			expect(tgt?.primaryBylineId).toBe(anchor.translationGroup);
		});

		it("copyContentBylines is a no-op when the target already has credits", async () => {
			const a = await bylineRepo.create({ slug: "a", displayName: "A" });
			const b = await bylineRepo.create({ slug: "b", displayName: "B" });

			const source = await contentRepo.create({
				type: "post",
				slug: "src-noop",
				data: { title: "Source" },
			});
			const target = await contentRepo.create({
				type: "post",
				slug: "tgt-noop",
				data: { title: "Target" },
			});

			await bylineRepo.setContentBylines("post", source.id, [{ bylineId: a.id }]);
			await bylineRepo.setContentBylines("post", target.id, [{ bylineId: b.id }]);

			await bylineRepo.copyContentBylines("post", source.id, target.id);

			const credits = await bylineRepo.getContentBylines("post", target.id);
			expect(credits).toHaveLength(1);
			expect(credits[0]?.byline.id).toBe(b.id);
		});

		it("delete preserves siblings and keeps junction rows when other translations exist", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const content = await contentRepo.create({
				type: "post",
				slug: "delete-sibling",
				data: { title: "Sibling test" },
			});

			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: anchor.id }]);

			// Delete the FR sibling; junctions and the EN row must survive.
			const deleted = await bylineRepo.delete(fr.id);
			expect(deleted).toBe(true);

			const junction = await db
				.selectFrom("_emdash_content_bylines")
				.select(["byline_id"])
				.where("content_id", "=", content.id)
				.execute();
			expect(junction).toHaveLength(1);

			const refreshed = await contentRepo.findById("post", content.id);
			expect(refreshed?.primaryBylineId).toBe(anchor.translationGroup);

			// EN row still exists.
			expect(await bylineRepo.findById(anchor.id)).not.toBeNull();
		});

		it("delete cascades junction rows when the last sibling is removed", async () => {
			const byline = await bylineRepo.create({
				slug: "solo",
				displayName: "Solo Author",
			});

			const content = await contentRepo.create({
				type: "post",
				slug: "delete-last",
				data: { title: "Last sibling" },
			});

			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: byline.id }]);

			const deleted = await bylineRepo.delete(byline.id);
			expect(deleted).toBe(true);

			const junction = await db
				.selectFrom("_emdash_content_bylines")
				.select(["byline_id"])
				.where("content_id", "=", content.id)
				.execute();
			expect(junction).toHaveLength(0);

			const refreshed = await contentRepo.findById("post", content.id);
			expect(refreshed?.primaryBylineId).toBeNull();
		});

		it("listTranslations / findByTranslationGroup return every sibling", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});
			const de = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane DE",
				locale: "de",
				translationOf: anchor.id,
			});

			const siblings = await bylineRepo.listTranslations(anchor.id);
			expect(siblings.map((b) => b.locale).toSorted()).toEqual(["de", "en", "fr"]);

			const byGroup = await bylineRepo.findByTranslationGroup(anchor.translationGroup!);
			expect(byGroup).toHaveLength(3);
			expect(byGroup.map((b) => b.id).toSorted()).toEqual([anchor.id, fr.id, de.id].toSorted());
		});

		it("listTranslations returns [] for a missing byline", async () => {
			expect(await bylineRepo.listTranslations("does-not-exist")).toEqual([]);
		});

		it("hasContentBylines distinguishes empty from unresolved-at-locale", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});

			const credited = await contentRepo.create({
				type: "post",
				slug: "credited",
				data: { title: "Credited" },
			});
			const uncredited = await contentRepo.create({
				type: "post",
				slug: "uncredited",
				data: { title: "Uncredited" },
			});

			await bylineRepo.setContentBylines("post", credited.id, [{ bylineId: anchor.id }]);

			// `credited` has explicit junction rows even though they don't
			// resolve at `fr`. `uncredited` truly has no credits.
			expect(await bylineRepo.hasContentBylines("post", credited.id)).toBe(true);
			expect(await bylineRepo.hasContentBylines("post", uncredited.id)).toBe(false);

			// And — strict-locale credit hydration at fr still returns [].
			const frCredits = await bylineRepo.getContentBylines("post", credited.id, {
				locale: "fr",
			});
			expect(frCredits).toEqual([]);
		});

		it("hasContentBylinesMany returns the set of credited content ids", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});

			const a = await contentRepo.create({
				type: "post",
				slug: "a",
				data: { title: "A" },
			});
			const b = await contentRepo.create({
				type: "post",
				slug: "b",
				data: { title: "B" },
			});
			const c = await contentRepo.create({
				type: "post",
				slug: "c",
				data: { title: "C" },
			});
			await bylineRepo.setContentBylines("post", a.id, [{ bylineId: anchor.id }]);
			await bylineRepo.setContentBylines("post", c.id, [{ bylineId: anchor.id }]);

			const result = await bylineRepo.hasContentBylinesMany("post", [a.id, b.id, c.id]);
			expect(result.has(a.id)).toBe(true);
			expect(result.has(b.id)).toBe(false);
			expect(result.has(c.id)).toBe(true);
		});

		it("setContentBylines dedupes by translation_group, not wire row id", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jane",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: anchor.id,
			});

			const content = await contentRepo.create({
				type: "post",
				slug: "dedup-post",
				data: { title: "Dedup" },
			});

			// Both sibling row ids passed in — they normalise to the same
			// translation_group. Without dedup-after-resolve, the second
			// insert would violate UNIQUE(collection, content, byline_id).
			const credits = await bylineRepo.setContentBylines("post", content.id, [
				{ bylineId: anchor.id, roleLabel: "Writer" },
				{ bylineId: fr.id, roleLabel: "Editor" },
			]);

			// Exactly one row landed, keyed by translation_group, with the
			// first occurrence's role_label preserved.
			const junction = await db
				.selectFrom("_emdash_content_bylines")
				.select(["byline_id", "role_label"])
				.where("content_id", "=", content.id)
				.execute();
			expect(junction).toHaveLength(1);
			expect(junction[0]?.byline_id).toBe(anchor.translationGroup);
			expect(junction[0]?.role_label).toBe("Writer");

			// `setContentBylines` returns from locale-agnostic
			// `getContentBylines`, so the 1 junction row joins to every
			// sibling in the translation_group (2 here: en + fr). The
			// per-locale hydration in the content handler filters this
			// down to one row at the entry's locale.
			expect(credits).toHaveLength(2);
			expect(credits.map((c) => c.byline.locale).toSorted()).toEqual(["en", "fr"]);
		});

		it("schema enforces one row per (translation_group, locale)", async () => {
			const anchor = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane Doe",
				locale: "en",
			});

			// Same translation_group + same locale, different slug. The
			// (slug, locale) UNIQUE doesn't catch this — the (group, locale)
			// partial unique added in migration 040 does.
			await expect(
				bylineRepo.create({
					slug: "jane-alt",
					displayName: "Jane Alt",
					locale: "en",
					translationOf: anchor.id,
				}),
			).rejects.toThrow();
		});
	});
});
