import { sql, type Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	getBylineFieldDefs,
	resetBylineFieldDefsCacheForTests,
} from "../../../../src/bylines/field-defs-cache.js";
import { BylineRepository } from "../../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../../src/database/repositories/content.js";
import { EmDashValidationError } from "../../../../src/database/repositories/types.js";
import type { Database } from "../../../../src/database/types.js";
import { peekRequestCache } from "../../../../src/request-cache.js";
import { runWithContext } from "../../../../src/request-context.js";
import { BylineSchemaRegistry } from "../../../../src/schema/byline-registry.js";
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

	describe("customFields hydration (Phase 3, #1174)", () => {
		let registry: BylineSchemaRegistry;

		beforeEach(() => {
			// Each test mutates the registry directly; the per-isolate
			// field-defs cache must start fresh so version-counter reads
			// see this test's mutations and not a leftover from a sibling.
			resetBylineFieldDefsCacheForTests();
			registry = new BylineSchemaRegistry(db);
		});

		it("populates customFields as {} when no fields are registered", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});

			const found = await bylineRepo.findById(byline.id);
			expect(found?.customFields).toEqual({});

			const list = await bylineRepo.findMany();
			expect(list.items[0]?.customFields).toEqual({});
		});

		it("hydrates translatable values per locale variant", async () => {
			const enRow = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			const frRow = await bylineRepo.create({
				slug: "jeanne",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: enRow.id,
			});

			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
				translatable: true,
			});
			const field = await registry.getField("job_title");

			// Seed translatable values via raw INSERT — Phase 3's write
			// path is exercised separately below.
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${enRow.id}, ${field?.id}, '"Editor"')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${frRow.id}, ${field?.id}, '"Rédacteur"')
			`.execute(db);
			resetBylineFieldDefsCacheForTests();

			const en = await bylineRepo.findById(enRow.id);
			const fr = await bylineRepo.findById(frRow.id);
			expect(en?.customFields?.job_title).toBe("Editor");
			expect(fr?.customFields?.job_title).toBe("Rédacteur");
		});

		it("hydrates group-shared values identically across every locale variant", async () => {
			const enRow = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			const frRow = await bylineRepo.create({
				slug: "jeanne",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: enRow.id,
			});
			const deRow = await bylineRepo.create({
				slug: "jane-de",
				displayName: "Jane (DE)",
				locale: "de",
				translationOf: enRow.id,
			});

			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});
			const field = await registry.getField("twitter_handle");

			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES (${enRow.translationGroup ?? enRow.id}, ${field?.id}, '"@jane"')
			`.execute(db);
			resetBylineFieldDefsCacheForTests();

			const en = await bylineRepo.findById(enRow.id);
			const fr = await bylineRepo.findById(frRow.id);
			const de = await bylineRepo.findById(deRow.id);
			expect(en?.customFields?.twitter_handle).toBe("@jane");
			expect(fr?.customFields?.twitter_handle).toBe("@jane");
			expect(de?.customFields?.twitter_handle).toBe("@jane");
		});

		it("mixes translatable and group-shared values on the same byline", async () => {
			const en = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jeanne",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: en.id,
			});

			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
				translatable: true,
			});
			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});
			const job = await registry.getField("job_title");
			const tw = await registry.getField("twitter_handle");

			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${en.id}, ${job?.id}, '"Editor"')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${fr.id}, ${job?.id}, '"Rédacteur"')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES (${en.translationGroup ?? en.id}, ${tw?.id}, '"@jane"')
			`.execute(db);
			resetBylineFieldDefsCacheForTests();

			const reloadedEn = await bylineRepo.findById(en.id);
			expect(reloadedEn?.customFields).toEqual({
				job_title: "Editor",
				twitter_handle: "@jane",
			});
			const reloadedFr = await bylineRepo.findById(fr.id);
			expect(reloadedFr?.customFields).toEqual({
				job_title: "Rédacteur",
				twitter_handle: "@jane",
			});
		});

		it("hydrates customFields across findMany / findByTranslationGroup / findByUserIds", async () => {
			await sql`
				INSERT INTO users (id, email, role) VALUES ('u1', 'u1@example.com', 50)
			`.execute(db);

			const en = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
				userId: "u1",
			});
			const fr = await bylineRepo.create({
				slug: "jeanne",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: en.id,
			});

			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
				translatable: true,
			});
			const job = await registry.getField("job_title");
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${en.id}, ${job?.id}, '"Editor"'),
				       (${fr.id}, ${job?.id}, '"Rédacteur"')
			`.execute(db);
			resetBylineFieldDefsCacheForTests();

			const many = await bylineRepo.findMany();
			for (const item of many.items) {
				expect(item.customFields).toBeDefined();
			}

			const siblings = await bylineRepo.findByTranslationGroup(en.translationGroup ?? en.id);
			expect(siblings.find((b) => b.locale === "en")?.customFields?.job_title).toBe("Editor");
			expect(siblings.find((b) => b.locale === "fr")?.customFields?.job_title).toBe("Rédacteur");

			const byUser = await bylineRepo.findByUserIds(["u1"], { locale: "en" });
			expect(byUser.get("u1")?.customFields?.job_title).toBe("Editor");
		});

		it("hydrates customFields onto ContentBylineCredit via getContentBylines", async () => {
			const content = await contentRepo.create({
				type: "post",
				slug: "hello",
				data: { title: "Hello" },
			});
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await bylineRepo.setContentBylines("post", content.id, [{ bylineId: byline.id }]);

			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
			});
			const field = await registry.getField("job_title");
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${byline.id}, ${field?.id}, '"Editor"')
			`.execute(db);
			resetBylineFieldDefsCacheForTests();

			const credits = await bylineRepo.getContentBylines("post", content.id);
			expect(credits[0]?.byline.customFields?.job_title).toBe("Editor");
		});

		it("hydrates customFields per-row when the same byline appears multiple times in one batch", async () => {
			// Regression for the Phase 3 review's "duplicate dedup" finding:
			// withCustomFields used to collapse `summaries` into a Map keyed
			// by byline.id, silently losing earlier duplicates' merge step.
			// `getContentBylinesMany` on a list view with repeated authors
			// hits this exact case — every duplicate must carry the values.
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
			});
			const field = await registry.getField("job_title");
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${byline.id}, ${field?.id}, '"Editor"')
			`.execute(db);
			resetBylineFieldDefsCacheForTests();

			// Two posts crediting the same author. getContentBylinesMany
			// will return rows for both posts referencing the same byline_id.
			const post1 = await contentRepo.create({
				type: "post",
				slug: "post-1",
				data: { title: "Post 1" },
			});
			const post2 = await contentRepo.create({
				type: "post",
				slug: "post-2",
				data: { title: "Post 2" },
			});
			await bylineRepo.setContentBylines("post", post1.id, [{ bylineId: byline.id }]);
			await bylineRepo.setContentBylines("post", post2.id, [{ bylineId: byline.id }]);

			const credits = await bylineRepo.getContentBylinesMany("post", [post1.id, post2.id]);
			const post1Credits = credits.get(post1.id) ?? [];
			const post2Credits = credits.get(post2.id) ?? [];

			// Both posts must see the byline with its customFields populated
			// — not just the last duplicate.
			expect(post1Credits[0]?.byline.customFields?.job_title).toBe("Editor");
			expect(post2Credits[0]?.byline.customFields?.job_title).toBe("Editor");
		});

		it("hydrateBylineCustomFields batches disjoint-group hydration in one pass", async () => {
			// Regression for the Phase 3 review's "disjoint-groups still
			// issue one query per locale bucket" finding. When sibling
			// locales reference *different* translation_groups (the case
			// where my earlier per-group cache fix degenerated to N
			// queries), batched hydration via `hydrateBylineCustomFields`
			// over the union of all bylines fires a SINGLE group-shared
			// query — meeting the AC envelope of "+1 per hydration pass".
			//
			// We assert behaviourally: skipHydration returns bylines with
			// customFields={}, hydrateBylineCustomFields populates them in
			// one shared call, and per-group cache entries land for every
			// disjoint group from the union.
			const aEn = await bylineRepo.create({ slug: "a-en", displayName: "A", locale: "en" });
			const bFr = await bylineRepo.create({ slug: "b-fr", displayName: "B", locale: "fr" });
			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});
			const field = await registry.getField("twitter_handle");

			// Two disjoint translation_groups, one per locale identity.
			const aGroup = aEn.translationGroup ?? aEn.id;
			const bGroup = bFr.translationGroup ?? bFr.id;
			expect(aGroup).not.toBe(bGroup);

			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES (${aGroup}, ${field?.id}, '"@a"'),
				       (${bGroup}, ${field?.id}, '"@b"')
			`.execute(db);
			resetBylineFieldDefsCacheForTests();

			const enContent = await contentRepo.create({
				type: "post",
				slug: "post-en",
				data: { title: "EN" },
				locale: "en",
			});
			const frContent = await contentRepo.create({
				type: "post",
				slug: "post-fr",
				data: { title: "FR" },
				locale: "fr",
			});
			await bylineRepo.setContentBylines("post", enContent.id, [{ bylineId: aEn.id }]);
			await bylineRepo.setContentBylines("post", frContent.id, [{ bylineId: bFr.id }]);

			await runWithContext({ db: undefined, dbIsIsolated: false, metrics: undefined }, async () => {
				// Per-bucket calls return un-hydrated bylines.
				const enMap = await bylineRepo.getContentBylinesMany("post", [enContent.id], {
					locale: "en",
					skipHydration: true,
				});
				const frMap = await bylineRepo.getContentBylinesMany("post", [frContent.id], {
					locale: "fr",
					skipHydration: true,
				});

				const enBylines = (enMap.get(enContent.id) ?? []).map((c) => c.byline);
				const frBylines = (frMap.get(frContent.id) ?? []).map((c) => c.byline);
				for (const b of [...enBylines, ...frBylines]) {
					expect(b.customFields).toEqual({});
				}

				// Before hydration, the request cache should have NO
				// group-value entries (skipHydration skips the fetch).
				expect(peekRequestCache(`byline-field-group-values:${aGroup}`)).toBeUndefined();
				expect(peekRequestCache(`byline-field-group-values:${bGroup}`)).toBeUndefined();

				// One batched hydration call over the union.
				await bylineRepo.hydrateBylineCustomFields([...enBylines, ...frBylines]);

				// Values populated, cache primed for both disjoint groups.
				expect(enBylines[0]?.customFields?.twitter_handle).toBe("@a");
				expect(frBylines[0]?.customFields?.twitter_handle).toBe("@b");
				expect(peekRequestCache(`byline-field-group-values:${aGroup}`)).toBeDefined();
				expect(peekRequestCache(`byline-field-group-values:${bGroup}`)).toBeDefined();
			});
		});

		it("dedupes group-shared queries across locale buckets within one request", async () => {
			// Regression for the Phase 3 review's "group-shared value query
			// per locale bucket" finding. PR plan AC #8: group-shared is
			// "+1 batched query per hydration pass" — meaning per request,
			// not per repository call. Mixed-locale list views share
			// translation_groups across sibling locales, so the second
			// bucket's hydration must reuse the first's group-shared fetch.

			const en = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jeanne",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: en.id,
			});

			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});
			const field = await registry.getField("twitter_handle");
			const group = en.translationGroup ?? en.id;
			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES (${group}, ${field?.id}, '"@jane"')
			`.execute(db);
			resetBylineFieldDefsCacheForTests();

			// Two separate findById calls within the same request context.
			// The request cache should ensure the group-shared values are
			// fetched once and reused on the second call.
			const results = await runWithContext(
				{ db: undefined, dbIsIsolated: false, metrics: undefined },
				async () => {
					const enResult = await bylineRepo.findById(en.id);
					// After the first call primed the cache, the second
					// call's loadGroupValues should hit `peekRequestCache`
					// for the same translation_group.
					const cached = peekRequestCache(`byline-field-group-values:${group}`);
					expect(cached).toBeDefined();
					const frResult = await bylineRepo.findById(fr.id);
					return { enResult, frResult };
				},
			);

			expect(results.enResult?.customFields?.twitter_handle).toBe("@jane");
			expect(results.frResult?.customFields?.twitter_handle).toBe("@jane");
		});

		it("tolerates orphaned value rows (definition deleted but value lingering)", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({ slug: "job_title", label: "Job title", type: "string" });
			const field = await registry.getField("job_title");
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${byline.id}, ${field?.id}, '"Editor"')
			`.execute(db);

			// Bypass the registry to leave the value row behind (the
			// registry's app-level cascade would normally clean it up).
			await sql`DELETE FROM _emdash_byline_fields WHERE id = ${field?.id}`.execute(db);
			resetBylineFieldDefsCacheForTests();

			const reloaded = await bylineRepo.findById(byline.id);
			// Orphan row's slug is no longer in the registry → it doesn't
			// surface in customFields. Hydration must not throw.
			expect(reloaded?.customFields).toEqual({});
		});
	});

	describe("field-defs cache + dbIsIsolated bypass (Phase 3, #1174)", () => {
		// Regression for the Phase 3 review's "global cache ignores
		// dbIsIsolated" finding. Playground/DO-preview requests set
		// `dbIsIsolated = true`; schema-derived caches must not be shared
		// with the singleton (loader.ts:74 precedent). We assert this by
		// populating the global cache from a non-isolated request, then
		// observing that an isolated request bypasses the cache and reads
		// fresh from its own DB.
		beforeEach(() => {
			resetBylineFieldDefsCacheForTests();
		});

		it("an isolated request never consults the global holder (matched-version case)", async () => {
			// Definitive test for the bypass: both DBs land at the same
			// version counter with DIFFERENT defs. Without the bypass, the
			// isolated request's version-keyed cache lookup would match
			// the main DB's cached entry and return the WRONG defs.
			const mainRegistry = new BylineSchemaRegistry(db);
			await mainRegistry.createField({ slug: "main_only", label: "Main", type: "string" });

			// Warm the global holder against the main DB.
			const mainDefs = await getBylineFieldDefs(db);
			expect(mainDefs.map((d) => d.slug)).toEqual(["main_only"]);
			expect(await mainRegistry.getVersion()).toBe(2); // 1 create × 2 bumps

			const isolatedDb = await setupTestDatabaseWithCollections();
			try {
				const isolatedRegistry = new BylineSchemaRegistry(isolatedDb);
				await isolatedRegistry.createField({
					slug: "isolated_only",
					label: "Isolated",
					type: "string",
				});
				// Both DBs are at version 2 — a version-keyed cache without
				// the dbIsIsolated bypass would return `main_only` here.
				expect(await isolatedRegistry.getVersion()).toBe(2);

				const result = await runWithContext({ db: isolatedDb, dbIsIsolated: true }, async () =>
					getBylineFieldDefs(isolatedDb),
				);
				expect(result.map((d) => d.slug)).toEqual(["isolated_only"]);
				expect(result.map((d) => d.slug)).not.toContain("main_only");
			} finally {
				await teardownTestDatabase(isolatedDb);
			}
		});

		it("an isolated request does not poison the global holder", async () => {
			const isolatedDb = await setupTestDatabaseWithCollections();
			try {
				const isolatedRegistry = new BylineSchemaRegistry(isolatedDb);
				await isolatedRegistry.createField({
					slug: "isolated_only",
					label: "Isolated",
					type: "string",
				});

				const isolatedDefs = await runWithContext(
					{ db: isolatedDb, dbIsIsolated: true },
					async () => getBylineFieldDefs(isolatedDb),
				);
				expect(isolatedDefs.map((d) => d.slug)).toEqual(["isolated_only"]);
			} finally {
				await teardownTestDatabase(isolatedDb);
			}

			// Main DB has nothing registered. The global holder should be
			// empty — the isolated read above must not have written to it.
			// We verify by reading from main and asserting nothing leaks.
			const mainDefs = await getBylineFieldDefs(db);
			expect(mainDefs).toEqual([]);
			expect(mainDefs.map((d) => d.slug)).not.toContain("isolated_only");
		});
	});

	describe("delete with custom-field cleanup (Phase 3, #1174)", () => {
		let registry: BylineSchemaRegistry;

		beforeEach(() => {
			resetBylineFieldDefsCacheForTests();
			registry = new BylineSchemaRegistry(db);
		});

		it("removes group-shared values when the last sibling of an identity is deleted", async () => {
			// Regression for the Phase 3 review's "_emdash_byline_field_group_values
			// has no FK to bylines" finding. Deleting the last byline in a
			// translation group must explicitly remove group-shared values —
			// FK cascade can't reach them because the key column is just
			// `translation_group TEXT`.
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});
			const field = await registry.getField("twitter_handle");
			const group = byline.translationGroup ?? byline.id;
			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES (${group}, ${field?.id}, '"@jane"')
			`.execute(db);

			await bylineRepo.delete(byline.id);

			const remaining = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_group_values
				WHERE translation_group = ${group}
			`.execute(db);
			expect(Number(remaining.rows[0]?.count ?? -1)).toBe(0);
		});

		it("preserves group-shared values when a non-last sibling is deleted", async () => {
			// The shared metadata must outlive the deletion of one locale —
			// only the *last* sibling's removal should drop the group values.
			const en = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await bylineRepo.create({
				slug: "jeanne",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: en.id,
			});
			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});
			const field = await registry.getField("twitter_handle");
			const group = en.translationGroup ?? en.id;
			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES (${group}, ${field?.id}, '"@jane"')
			`.execute(db);

			await bylineRepo.delete(en.id);

			const remaining = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_group_values
				WHERE translation_group = ${group}
			`.execute(db);
			// Still 1 — the French sibling lives, the group value lives.
			expect(Number(remaining.rows[0]?.count ?? -1)).toBe(1);
		});

		it("clears per-row translatable values via app-level cleanup (works without FK pragma)", async () => {
			// Regression for the Phase 3 review's "BylineRepository.delete
			// still relies on FK cascade for _emdash_byline_field_values"
			// finding. The byline domain has standardised on app-level
			// cleanup so deletion doesn't depend on `PRAGMA foreign_keys`.
			// Explicitly disable the pragma to prove the cleanup is
			// app-level, not FK-mediated.
			await sql`PRAGMA foreign_keys = OFF`.execute(db);

			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
				translatable: true,
			});
			const field = await registry.getField("job_title");
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${byline.id}, ${field?.id}, '"Editor"')
			`.execute(db);

			await bylineRepo.delete(byline.id);

			const remaining = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
				WHERE byline_id = ${byline.id}
			`.execute(db);
			expect(Number(remaining.rows[0]?.count ?? -1)).toBe(0);
		});

		it("FK ON DELETE CASCADE on _emdash_byline_field_values still serves as defense-in-depth", async () => {
			// Companion to the test above: with FK ON, bypassing the
			// repository and deleting the byline row directly should still
			// trigger the FK cascade. Keeps both layers of cleanup
			// asserted so neither rots.
			await sql`PRAGMA foreign_keys = ON`.execute(db);

			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
				translatable: true,
			});
			const field = await registry.getField("job_title");
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${byline.id}, ${field?.id}, '"Editor"')
			`.execute(db);

			await sql`DELETE FROM _emdash_bylines WHERE id = ${byline.id}`.execute(db);

			const remaining = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
				WHERE byline_id = ${byline.id}
			`.execute(db);
			expect(Number(remaining.rows[0]?.count ?? -1)).toBe(0);
		});

		it("cascades per-row translatable values via FK when any sibling is deleted", async () => {
			// Translatable values are keyed by byline_id and have FK ON
			// DELETE CASCADE (migration 041). Deleting a byline row drops
			// its own values regardless of last-sibling status.
			const en = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jeanne",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: en.id,
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
				translatable: true,
			});
			const field = await registry.getField("job_title");
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${en.id}, ${field?.id}, '"Editor"'),
				       (${fr.id}, ${field?.id}, '"Rédacteur"')
			`.execute(db);

			await bylineRepo.delete(en.id);

			// en's value is gone (FK cascade). fr's value remains.
			const remainingEn = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
				WHERE byline_id = ${en.id}
			`.execute(db);
			const remainingFr = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
				WHERE byline_id = ${fr.id}
			`.execute(db);
			expect(Number(remainingEn.rows[0]?.count ?? -1)).toBe(0);
			expect(Number(remainingFr.rows[0]?.count ?? -1)).toBe(1);
		});
	});

	describe("update with customFields write path (Phase 3, #1174)", () => {
		let registry: BylineSchemaRegistry;

		beforeEach(() => {
			resetBylineFieldDefsCacheForTests();
			registry = new BylineSchemaRegistry(db);
		});

		it("writes a translatable value and round-trips via findById", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
				translatable: true,
			});

			const updated = await bylineRepo.update(byline.id, {
				customFields: { job_title: "Editor" },
			});
			expect(updated?.customFields?.job_title).toBe("Editor");

			const reloaded = await bylineRepo.findById(byline.id);
			expect(reloaded?.customFields?.job_title).toBe("Editor");
		});

		it("writes a non-translatable value to the group-shared table", async () => {
			const en = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			const fr = await bylineRepo.create({
				slug: "jeanne",
				displayName: "Jeanne",
				locale: "fr",
				translationOf: en.id,
			});
			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});

			await bylineRepo.update(en.id, { customFields: { twitter_handle: "@jane" } });

			// Same value visible on every sibling.
			const enRel = await bylineRepo.findById(en.id);
			const frRel = await bylineRepo.findById(fr.id);
			expect(enRel?.customFields?.twitter_handle).toBe("@jane");
			expect(frRel?.customFields?.twitter_handle).toBe("@jane");

			// Storage went to the group table, not the per-row table.
			const tr = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
			`.execute(db);
			const grp = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_group_values
			`.execute(db);
			expect(Number(tr.rows[0]?.count ?? -1)).toBe(0);
			expect(Number(grp.rows[0]?.count ?? -1)).toBe(1);
		});

		it("upsert is idempotent — re-applying the same write yields the same row", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
			});

			await bylineRepo.update(byline.id, { customFields: { job_title: "Editor" } });
			await bylineRepo.update(byline.id, { customFields: { job_title: "Editor" } });

			const rows = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
				WHERE byline_id = ${byline.id}
			`.execute(db);
			expect(Number(rows.rows[0]?.count ?? -1)).toBe(1);
		});

		it("overwrites an existing value on subsequent updates", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
			});

			await bylineRepo.update(byline.id, { customFields: { job_title: "Editor" } });
			await bylineRepo.update(byline.id, { customFields: { job_title: "Senior Editor" } });

			const reloaded = await bylineRepo.findById(byline.id);
			expect(reloaded?.customFields?.job_title).toBe("Senior Editor");
		});

		it("clears a value when written as null (deletes the row)", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
			});

			await bylineRepo.update(byline.id, { customFields: { job_title: "Editor" } });
			await bylineRepo.update(byline.id, { customFields: { job_title: null } });

			const reloaded = await bylineRepo.findById(byline.id);
			// Cleared field is absent from the map (not present as null) —
			// the row is deleted, so hydration finds no entry.
			expect(reloaded?.customFields?.job_title).toBeUndefined();
			expect(reloaded?.customFields).toEqual({});
		});

		it("throws EmDashValidationError on unknown slugs (no partial write)", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
			});

			await expect(
				bylineRepo.update(byline.id, {
					customFields: { job_title: "Editor", unknown_field: "value" },
				}),
			).rejects.toBeInstanceOf(EmDashValidationError);

			// Validation runs before any DB write, so the registered field
			// also did not get written.
			const rows = await sql<{ count: number }>`
				SELECT COUNT(*) AS count FROM _emdash_byline_field_values
			`.execute(db);
			expect(Number(rows.rows[0]?.count ?? -1)).toBe(0);
		});

		it("rejects type mismatches with EmDashValidationError", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({ slug: "active", label: "Active", type: "boolean" });

			await expect(
				bylineRepo.update(byline.id, { customFields: { active: "not a boolean" } }),
			).rejects.toBeInstanceOf(EmDashValidationError);
		});

		it("rejects select values outside the registered options", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "role",
				label: "Role",
				type: "select",
				validation: { options: ["editor", "author"] },
			});

			await expect(
				bylineRepo.update(byline.id, { customFields: { role: "owner" } }),
			).rejects.toBeInstanceOf(EmDashValidationError);

			// Accepted choices land.
			const ok = await bylineRepo.update(byline.id, { customFields: { role: "editor" } });
			expect(ok?.customFields?.role).toBe("editor");
		});

		it("rejects url values that don't parse as a URL", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "portfolio",
				label: "Portfolio",
				type: "url",
			});

			await expect(
				bylineRepo.update(byline.id, { customFields: { portfolio: "not a url" } }),
			).rejects.toBeInstanceOf(EmDashValidationError);

			// Valid absolute URLs land.
			const ok = await bylineRepo.update(byline.id, {
				customFields: { portfolio: "https://example.com" },
			});
			expect(ok?.customFields?.portfolio).toBe("https://example.com");
		});

		it("rejects url values with non-http(s) schemes (javascript:, data:, mailto:, ftp:)", async () => {
			// Mirrors `httpUrl` in `api/schemas/common.ts` — `new URL`
			// alone accepts XSS-shaped schemes.
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "portfolio",
				label: "Portfolio",
				type: "url",
			});

			for (const dangerous of [
				"javascript:alert(1)",
				"data:text/html,<script>alert(1)</script>",
				"mailto:foo@bar.com",
				"ftp://example.com/file",
				"file:///etc/passwd",
			]) {
				await expect(
					bylineRepo.update(byline.id, { customFields: { portfolio: dangerous } }),
				).rejects.toBeInstanceOf(EmDashValidationError);
			}
		});

		it("hydration ignores rows written to the wrong owner table", async () => {
			// Regression: applyCustomFieldsTo used to apply rows from both
			// value tables regardless of `field.translatable`, so a stale
			// row from a translatable flip could leak in.
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});

			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
				translatable: true,
			});
			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});
			const job = await registry.getField("job_title");
			const tw = await registry.getField("twitter_handle");

			// "Right" rows — should hydrate.
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${byline.id}, ${job?.id}, '"Editor"')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES (${byline.translationGroup ?? byline.id}, ${tw?.id}, '"@jane"')
			`.execute(db);
			// "Wrong" rows — translatable field with a group-shared row,
			// and group-shared field with a per-locale row. Both must
			// be ignored by hydration.
			await sql`
				INSERT INTO _emdash_byline_field_group_values (translation_group, field_id, value)
				VALUES (${byline.translationGroup ?? byline.id}, ${job?.id}, '"WRONG: group row for translatable field"')
			`.execute(db);
			await sql`
				INSERT INTO _emdash_byline_field_values (byline_id, field_id, value)
				VALUES (${byline.id}, ${tw?.id}, '"WRONG: per-locale row for group field"')
			`.execute(db);
			resetBylineFieldDefsCacheForTests();

			const reloaded = await bylineRepo.findById(byline.id);
			expect(reloaded?.customFields).toEqual({
				job_title: "Editor",
				twitter_handle: "@jane",
			});
		});

		it("invalidates the per-request group-shared cache after a non-translatable write", async () => {
			// Regression for the Phase 3 review's finding that update()
			// primes the group-shared request cache via its opening
			// findById, then writes to _emdash_byline_field_group_values
			// later in the same method. Without explicit invalidation,
			// the closing findById (and any later reads in the same
			// request) would return stale customFields. `update` calls
			// `clearRequestCacheEntry` after group-shared writes so
			// subsequent reads in the request see the fresh value.
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "twitter_handle",
				label: "Twitter",
				type: "string",
				translatable: false,
			});

			const result = await runWithContext(
				{ db: undefined, dbIsIsolated: false, metrics: undefined },
				async () => {
					// Prime the cache by reading first — exactly what an API
					// route does (load the resource before mutating it).
					const before = await bylineRepo.findById(byline.id);
					expect(before?.customFields).toEqual({});

					// Write the group-shared value.
					const after = await bylineRepo.update(byline.id, {
						customFields: { twitter_handle: "@jane" },
					});
					// update's closing findById must reflect the write, not the
					// stale cache from the opening findById.
					expect(after?.customFields?.twitter_handle).toBe("@jane");

					// A LATER findById in the same request must also see the
					// new value — proves the cache is fully cleared.
					const later = await bylineRepo.findById(byline.id);
					return later?.customFields?.twitter_handle;
				},
			);

			expect(result).toBe("@jane");
		});

		it("does not write customFields when the input omits the key entirely", async () => {
			const byline = await bylineRepo.create({
				slug: "jane",
				displayName: "Jane",
				locale: "en",
			});
			await registry.createField({
				slug: "job_title",
				label: "Job title",
				type: "string",
			});
			await bylineRepo.update(byline.id, { customFields: { job_title: "Editor" } });

			// Plain update without customFields key must leave existing values
			// alone (no implicit clear, no implicit re-write).
			await bylineRepo.update(byline.id, { displayName: "Jane Doe" });

			const reloaded = await bylineRepo.findById(byline.id);
			expect(reloaded?.displayName).toBe("Jane Doe");
			expect(reloaded?.customFields?.job_title).toBe("Editor");
		});
	});
});
