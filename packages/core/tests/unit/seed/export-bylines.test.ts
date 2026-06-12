import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { exportSeed } from "../../../src/cli/commands/export-seed.js";
import { BylineRepository } from "../../../src/database/repositories/byline.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import type { Database } from "../../../src/database/types.js";
import { setI18nConfig } from "../../../src/i18n/config.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { applySeed } from "../../../src/seed/apply.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("exportSeed: bylines", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		setI18nConfig(null);
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
		setI18nConfig(null);
	});

	it("exports byline profiles as root bylines[]", async () => {
		const bylineRepo = new BylineRepository(db);
		await bylineRepo.create({
			slug: "editorial",
			displayName: "Editorial",
			bio: "The editorial team",
			websiteUrl: "https://example.com",
		});
		await bylineRepo.create({
			slug: "guest-writer",
			displayName: "Guest Writer",
			isGuest: true,
		});

		const seed = await exportSeed(db);

		expect(seed.bylines).toBeDefined();
		const bylines = seed.bylines ?? [];
		expect(bylines).toHaveLength(2);

		const editorial = bylines.find((b) => b.slug === "editorial");
		expect(editorial).toMatchObject({
			slug: "editorial",
			displayName: "Editorial",
			bio: "The editorial team",
			websiteUrl: "https://example.com",
		});
		expect(editorial?.id).toBeTruthy();

		const guest = bylines.find((b) => b.slug === "guest-writer");
		expect(guest).toMatchObject({
			slug: "guest-writer",
			displayName: "Guest Writer",
			isGuest: true,
		});
	});

	it("exports ordered byline credits on content entries referencing root byline ids", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const bylineRepo = new BylineRepository(db);
		const editorial = await bylineRepo.create({ slug: "editorial", displayName: "Editorial" });
		const guest = await bylineRepo.create({
			slug: "guest-writer",
			displayName: "Guest Writer",
			isGuest: true,
		});

		const contentRepo = new ContentRepository(db);
		const post = await contentRepo.create({
			type: "posts",
			slug: "hello",
			status: "published",
			data: { title: "Hello World" },
		});

		await bylineRepo.setContentBylines("posts", post.id, [
			{ bylineId: editorial.id },
			{ bylineId: guest.id, roleLabel: "Guest essay" },
		]);

		const seed = await exportSeed(db, "posts");

		// The root byline seed ids and the credit references must match so the
		// exported seed round-trips through applySeed.
		const bylines = seed.bylines ?? [];
		const editorialSeedId = bylines.find((b) => b.slug === "editorial")?.id;
		const guestSeedId = bylines.find((b) => b.slug === "guest-writer")?.id;
		expect(editorialSeedId).toBeTruthy();
		expect(guestSeedId).toBeTruthy();

		const entry = seed.content?.posts?.find((e) => e.slug === "hello");
		expect(entry).toBeDefined();
		expect(entry?.bylines).toEqual([
			{ byline: editorialSeedId },
			{ byline: guestSeedId, roleLabel: "Guest essay" },
		]);
	});

	it("omits bylines key when there are no bylines", async () => {
		const seed = await exportSeed(db);
		expect(seed.bylines).toBeUndefined();
	});

	it("round-trips bylines and credits through applySeed into a fresh database", async () => {
		const registry = new SchemaRegistry(db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createField("posts", { slug: "title", label: "Title", type: "string" });

		const bylineRepo = new BylineRepository(db);
		const editorial = await bylineRepo.create({
			slug: "editorial",
			displayName: "Editorial",
			bio: "The team",
		});
		const guest = await bylineRepo.create({
			slug: "guest-writer",
			displayName: "Guest Writer",
			isGuest: true,
		});

		const contentRepo = new ContentRepository(db);
		const post = await contentRepo.create({
			type: "posts",
			slug: "hello",
			status: "published",
			data: { title: "Hello World" },
		});
		await bylineRepo.setContentBylines("posts", post.id, [
			{ bylineId: editorial.id },
			{ bylineId: guest.id, roleLabel: "Guest essay" },
		]);

		const seed = await exportSeed(db, "posts");

		// Apply the exported seed into a separate, empty database.
		const fresh = await setupTestDatabase();
		try {
			const result = await applySeed(fresh, seed, { includeContent: true });
			expect(result.bylines.created).toBe(2);
			expect(result.content.created).toBe(1);

			const freshBylineRepo = new BylineRepository(fresh);
			const freshContentRepo = new ContentRepository(fresh);
			const entry = await freshContentRepo.findBySlug("posts", "hello");
			expect(entry).not.toBeNull();

			const credits = await freshBylineRepo.getContentBylines("posts", entry!.id);
			expect(credits).toHaveLength(2);
			expect(credits[0]?.byline.slug).toBe("editorial");
			expect(credits[1]?.byline.slug).toBe("guest-writer");
			expect(credits[1]?.roleLabel).toBe("Guest essay");
		} finally {
			await teardownTestDatabase(fresh);
		}
	});
});
