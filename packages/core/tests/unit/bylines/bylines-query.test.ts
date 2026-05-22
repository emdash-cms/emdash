import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SQL_BATCH_SIZE } from "../../../src/utils/chunks.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

// Mock the loader's getDb to return our test database
vi.mock("../../../src/loader.js", () => ({
	getDb: vi.fn(),
}));

import {
	getByline,
	getBylineBySlug,
	getEntryBylines,
	getBylinesForEntries,
} from "../../../src/bylines/index.js";
import { getDb } from "../../../src/loader.js";

describe("Byline query functions", () => {
	let db: Kysely<Database>;
	let bylineRepo: BylineRepository;
	let contentRepo: ContentRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		bylineRepo = new BylineRepository(db);
		contentRepo = new ContentRepository(db);
		vi.mocked(getDb).mockResolvedValue(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		vi.restoreAllMocks();
	});

	describe("getByline", () => {
		it("returns a byline by ID", async () => {
			const created = await bylineRepo.create({
				slug: "jane-doe",
				displayName: "Jane Doe",
			});

			const result = await getByline(created.id);

			expect(result).not.toBeNull();
			expect(result?.id).toBe(created.id);
			expect(result?.displayName).toBe("Jane Doe");
			expect(result?.slug).toBe("jane-doe");
		});

		it("returns null for non-existent ID", async () => {
			const result = await getByline("non-existent");
			expect(result).toBeNull();
		});
	});

	describe("getBylineBySlug", () => {
		it("returns a byline by slug", async () => {
			await bylineRepo.create({
				slug: "john-smith",
				displayName: "John Smith",
			});

			const result = await getBylineBySlug("john-smith");

			expect(result).not.toBeNull();
			expect(result?.displayName).toBe("John Smith");
		});

		it("returns null for non-existent slug", async () => {
			const result = await getBylineBySlug("nobody");
			expect(result).toBeNull();
		});

		it("walks the locale fallback chain when the requested locale has no row", async () => {
			// Identity lookup pattern — mirrors getTerm / getMenu in PR #916.
			// Locale fallback IS appropriate here ("show me this byline") in
			// contrast to credit hydration ("what should render on this
			// entry"), which stays strict.
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr", "de"] });
			try {
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
				// No de sibling. Requesting de falls back through the chain to
				// the configured defaultLocale (en).
				const result = await getBylineBySlug("jane", { locale: "de" });
				expect(result?.locale).toBe("en");
				expect(result?.displayName).toBe("Jane Doe");
			} finally {
				setI18nConfig(null);
			}
		});

		it("prefers the requested locale's row when it exists", async () => {
			setI18nConfig({ defaultLocale: "en", locales: ["en", "fr", "de"] });
			try {
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
				const result = await getBylineBySlug("jane", { locale: "fr" });
				expect(result?.locale).toBe("fr");
				expect(result?.displayName).toBe("Jeanne");
			} finally {
				setI18nConfig(null);
			}
		});
	});

	describe("getEntryBylines", () => {
		it("returns explicit byline credits for an entry", async () => {
			const lead = await bylineRepo.create({
				slug: "lead-author",
				displayName: "Lead Author",
			});
			const editor = await bylineRepo.create({
				slug: "editor",
				displayName: "Editor",
			});

			const post = await contentRepo.create({
				type: "post",
				slug: "my-post",
				data: { title: "My Post" },
			});

			await bylineRepo.setContentBylines("post", post.id, [
				{ bylineId: lead.id },
				{ bylineId: editor.id, roleLabel: "Contributing Editor" },
			]);

			const bylines = await getEntryBylines("post", post.id);

			expect(bylines).toHaveLength(2);
			expect(bylines[0]?.byline.displayName).toBe("Lead Author");
			expect(bylines[0]?.sortOrder).toBe(0);
			expect(bylines[0]?.source).toBe("explicit");
			expect(bylines[1]?.byline.displayName).toBe("Editor");
			expect(bylines[1]?.roleLabel).toBe("Contributing Editor");
			expect(bylines[1]?.source).toBe("explicit");
		});

		it("falls back to user-linked byline when no explicit credits", async () => {
			// Create a user
			const userRepo = new UserRepository(db);
			const user = await userRepo.create({
				email: "author@example.com",
				displayName: "Author User",
				role: "editor",
			});

			// Create a byline linked to the user
			await bylineRepo.create({
				slug: "author-user",
				displayName: "Author User",
				userId: user.id,
			});

			// Create a post with this user as author, no explicit bylines
			const post = await contentRepo.create({
				type: "post",
				slug: "authored-post",
				data: { title: "Authored Post" },
				authorId: user.id,
			});

			const bylines = await getEntryBylines("post", post.id);

			expect(bylines).toHaveLength(1);
			expect(bylines[0]?.byline.displayName).toBe("Author User");
			expect(bylines[0]?.source).toBe("inferred");
			expect(bylines[0]?.roleLabel).toBeNull();
		});

		it("returns empty array when no bylines and no author fallback", async () => {
			const post = await contentRepo.create({
				type: "post",
				slug: "no-author-post",
				data: { title: "No Author" },
			});

			const bylines = await getEntryBylines("post", post.id);
			expect(bylines).toHaveLength(0);
		});
	});

	describe("getBylinesForEntries", () => {
		it("batch-fetches byline credits for multiple entries", async () => {
			const author1 = await bylineRepo.create({
				slug: "author-one",
				displayName: "Author One",
			});
			const author2 = await bylineRepo.create({
				slug: "author-two",
				displayName: "Author Two",
			});

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
			const post3 = await contentRepo.create({
				type: "post",
				slug: "post-3",
				data: { title: "Post 3" },
			});

			await bylineRepo.setContentBylines("post", post1.id, [{ bylineId: author1.id }]);
			await bylineRepo.setContentBylines("post", post2.id, [
				{ bylineId: author1.id },
				{ bylineId: author2.id, roleLabel: "Contributor" },
			]);
			// post3 has no bylines

			const result = await getBylinesForEntries(
				"post",
				[post1, post2, post3].map((p) => ({ id: p.id, authorId: p.authorId })),
			);

			expect(result.get(post1.id)).toHaveLength(1);
			expect(result.get(post1.id)?.[0]?.byline.displayName).toBe("Author One");
			expect(result.get(post1.id)?.[0]?.source).toBe("explicit");

			expect(result.get(post2.id)).toHaveLength(2);
			expect(result.get(post2.id)?.[0]?.byline.displayName).toBe("Author One");
			expect(result.get(post2.id)?.[1]?.byline.displayName).toBe("Author Two");
			expect(result.get(post2.id)?.[1]?.roleLabel).toBe("Contributor");

			expect(result.get(post3.id)).toHaveLength(0);
		});

		it("returns inferred bylines for entries without explicit credits", async () => {
			const userRepo = new UserRepository(db);
			const user = await userRepo.create({
				email: "batch-author@example.com",
				displayName: "Batch Author",
				role: "editor",
			});

			await bylineRepo.create({
				slug: "batch-author",
				displayName: "Batch Author",
				userId: user.id,
			});

			const post = await contentRepo.create({
				type: "post",
				slug: "batch-post",
				data: { title: "Batch Post" },
				authorId: user.id,
			});

			const result = await getBylinesForEntries("post", [{ id: post.id, authorId: post.authorId }]);

			expect(result.get(post.id)).toHaveLength(1);
			expect(result.get(post.id)?.[0]?.source).toBe("inferred");
			expect(result.get(post.id)?.[0]?.byline.displayName).toBe("Batch Author");
		});

		it("handles batches larger than SQL_BATCH_SIZE across explicit and inferred bylines", async () => {
			const userRepo = new UserRepository(db);
			const explicitByline = await bylineRepo.create({
				slug: "large-batch-explicit",
				displayName: "Large Batch Explicit",
			});

			const explicitPost1 = await contentRepo.create({
				type: "post",
				slug: "large-batch-explicit-1",
				data: { title: "Large Batch Explicit 1" },
			});
			await bylineRepo.setContentBylines("post", explicitPost1.id, [
				{ bylineId: explicitByline.id },
			]);

			const inferredPosts: { id: string; authorId: string | null }[] = [];
			for (let i = 0; i < SQL_BATCH_SIZE + 2; i++) {
				const user = await userRepo.create({
					email: `large-batch-${i}@example.com`,
					displayName: `Large Batch ${i}`,
					role: "editor",
				});

				await bylineRepo.create({
					slug: `large-batch-${i}`,
					displayName: `Large Batch ${i}`,
					userId: user.id,
				});

				const post = await contentRepo.create({
					type: "post",
					slug: `large-batch-post-${i}`,
					data: { title: `Large Batch Post ${i}` },
					authorId: user.id,
				});
				inferredPosts.push({ id: post.id, authorId: post.authorId });
			}

			const explicitPost2 = await contentRepo.create({
				type: "post",
				slug: "large-batch-explicit-2",
				data: { title: "Large Batch Explicit 2" },
			});
			await bylineRepo.setContentBylines("post", explicitPost2.id, [
				{ bylineId: explicitByline.id },
			]);

			const inferredPostIds = inferredPosts.map((p) => p.id);
			const entries = [
				{ id: explicitPost1.id, authorId: explicitPost1.authorId },
				...inferredPosts,
				{ id: explicitPost2.id, authorId: explicitPost2.authorId },
			];
			const result = await getBylinesForEntries("post", entries);

			expect(result.size).toBe(entries.length);
			expect(result.get(explicitPost1.id)?.[0]?.source).toBe("explicit");
			expect(result.get(explicitPost1.id)?.[0]?.byline.displayName).toBe("Large Batch Explicit");
			expect(result.get(explicitPost2.id)?.[0]?.source).toBe("explicit");
			expect(result.get(explicitPost2.id)?.[0]?.byline.displayName).toBe("Large Batch Explicit");
			expect(result.get(inferredPostIds[0]!)?.[0]?.source).toBe("inferred");
			expect(result.get(inferredPostIds[0]!)?.[0]?.byline.displayName).toBe("Large Batch 0");
			expect(result.get(inferredPostIds[SQL_BATCH_SIZE + 1]!)?.[0]?.source).toBe("inferred");
			expect(result.get(inferredPostIds[SQL_BATCH_SIZE + 1]!)?.[0]?.byline.displayName).toBe(
				`Large Batch ${SQL_BATCH_SIZE + 1}`,
			);
		});

		it("returns empty map for empty input", async () => {
			const result = await getBylinesForEntries("post", []);
			expect(result.size).toBe(0);
		});
	});

	describe("i18n (migration 040) — strict per-locale runtime", () => {
		it("getEntryBylines({ locale }) returns the sibling at that locale", async () => {
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

			const post = await contentRepo.create({
				type: "post",
				slug: "i18n-post",
				data: { title: "Hi" },
			});
			await bylineRepo.setContentBylines("post", post.id, [{ bylineId: anchor.id }]);

			const enCredits = await getEntryBylines("post", post.id, { locale: "en" });
			const frCredits = await getEntryBylines("post", post.id, { locale: "fr" });

			expect(enCredits[0]?.byline.displayName).toBe("Jane Doe");
			expect(frCredits[0]?.byline.displayName).toBe("Jeanne");
		});

		it("getEntryBylines({ locale }) returns [] when no sibling exists at that locale", async () => {
			const anchor = await bylineRepo.create({
				slug: "marco",
				displayName: "Marco",
				locale: "en",
			});

			const post = await contentRepo.create({
				type: "post",
				slug: "marco-post",
				data: { title: "Hi" },
			});
			await bylineRepo.setContentBylines("post", post.id, [{ bylineId: anchor.id }]);

			const frCredits = await getEntryBylines("post", post.id, { locale: "fr" });
			expect(frCredits).toEqual([]);
		});

		it("getEntryBylines without locale returns every locale variant of the credit", async () => {
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

			const post = await contentRepo.create({
				type: "post",
				slug: "no-locale",
				data: { title: "Hi" },
			});
			await bylineRepo.setContentBylines("post", post.id, [{ bylineId: anchor.id }]);

			const all = await getEntryBylines("post", post.id);
			expect(all).toHaveLength(2);
			expect(all.map((c) => c.byline.locale).toSorted()).toEqual(["en", "fr"]);
		});

		it("getBylinesForEntries buckets by entry locale and returns each entry's locale match", async () => {
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
				slug: "en-jane",
				data: { title: "Hello" },
				locale: "en",
			});
			const frPost = await contentRepo.create({
				type: "post",
				slug: "fr-jane",
				data: { title: "Bonjour" },
				locale: "fr",
			});
			await bylineRepo.setContentBylines("post", enPost.id, [{ bylineId: anchor.id }]);
			await bylineRepo.setContentBylines("post", frPost.id, [{ bylineId: anchor.id }]);

			const result = await getBylinesForEntries("post", [
				{ id: enPost.id, authorId: null, locale: "en" },
				{ id: frPost.id, authorId: null, locale: "fr" },
			]);

			expect(result.get(enPost.id)?.[0]?.byline.locale).toBe("en");
			expect(result.get(enPost.id)?.[0]?.byline.displayName).toBe("Jane Doe");
			expect(result.get(frPost.id)?.[0]?.byline.locale).toBe("fr");
			expect(result.get(frPost.id)?.[0]?.byline.displayName).toBe("Jeanne");
		});

		it("getBylinesForEntries returns [] for entries whose credit has no sibling at the entry's locale", async () => {
			const anchor = await bylineRepo.create({
				slug: "solo",
				displayName: "Solo",
				locale: "en",
			});

			const frPost = await contentRepo.create({
				type: "post",
				slug: "fr-solo",
				data: { title: "Bonjour" },
				locale: "fr",
			});
			await bylineRepo.setContentBylines("post", frPost.id, [{ bylineId: anchor.id }]);

			const result = await getBylinesForEntries("post", [
				{ id: frPost.id, authorId: null, locale: "fr" },
			]);
			expect(result.get(frPost.id)).toEqual([]);
		});

		it("does not infer from authorId when entry has explicit credits at another locale", async () => {
			// Bug 1 regression at the runtime path. Entry credits an en-only
			// byline; same entry's author has a fr byline. At fr locale,
			// strict hydration returns []; we must NOT fall back to the
			// author byline because the editor explicitly named someone
			// else.
			const userRepo = new UserRepository(db);
			const user = await userRepo.create({
				email: "runtime-fallback@example.com",
				displayName: "Author",
				role: "editor",
			});
			await bylineRepo.create({
				slug: "author-fr",
				displayName: "Auteur",
				userId: user.id,
				locale: "fr",
			});

			const explicit = await bylineRepo.create({
				slug: "marco",
				displayName: "Marco",
				locale: "en",
			});

			const frPost = await contentRepo.create({
				type: "post",
				slug: "fr-post-explicit",
				data: { title: "Bonjour" },
				locale: "fr",
				authorId: user.id,
			});
			await bylineRepo.setContentBylines("post", frPost.id, [{ bylineId: explicit.id }]);

			// Single-entry path.
			const single = await getEntryBylines("post", frPost.id, { locale: "fr" });
			expect(single).toEqual([]);

			// Batch path.
			const batch = await getBylinesForEntries("post", [
				{ id: frPost.id, authorId: frPost.authorId, locale: "fr" },
			]);
			expect(batch.get(frPost.id)).toEqual([]);
		});

		it("inferred (user-linked) byline is strict per locale too", async () => {
			const userRepo = new UserRepository(db);
			const user = await userRepo.create({
				email: "inferred-i18n@example.com",
				displayName: "Inferred",
				role: "editor",
			});

			await bylineRepo.create({
				slug: "inferred",
				displayName: "Inferred EN",
				userId: user.id,
				locale: "en",
			});

			const frPost = await contentRepo.create({
				type: "post",
				slug: "fr-inferred",
				data: { title: "Bonjour" },
				locale: "fr",
				authorId: user.id,
			});

			// No fr sibling exists for the user's byline. Strict hydration
			// returns no inferred credit — same rule as explicit credits.
			const result = await getBylinesForEntries("post", [
				{ id: frPost.id, authorId: frPost.authorId, locale: "fr" },
			]);
			expect(result.get(frPost.id)).toEqual([]);

			// EN entry by the same author DOES get the inferred byline.
			const enPost = await contentRepo.create({
				type: "post",
				slug: "en-inferred",
				data: { title: "Hello" },
				locale: "en",
				authorId: user.id,
			});
			const enResult = await getBylinesForEntries("post", [
				{ id: enPost.id, authorId: enPost.authorId, locale: "en" },
			]);
			expect(enResult.get(enPost.id)?.[0]?.source).toBe("inferred");
			expect(enResult.get(enPost.id)?.[0]?.byline.locale).toBe("en");
		});
	});
});
