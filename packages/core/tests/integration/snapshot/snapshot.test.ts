import { sql } from "kysely";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Snapshot } from "../../../src/api/handlers/snapshot.js";
import { generateSnapshot } from "../../../src/api/handlers/snapshot.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabaseWithCollections } from "../../utils/test-db.js";

describe("generateSnapshot", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("returns empty tables when no content exists", async () => {
		const snapshot = await generateSnapshot(db);

		expect(snapshot.generatedAt).toBeTruthy();
		expect(typeof snapshot.generatedAt).toBe("string");

		// Schema should include ec_post and ec_page (even with no rows)
		expect(snapshot.schema).toHaveProperty("ec_post");
		expect(snapshot.schema).toHaveProperty("ec_page");
		expect(snapshot.schema.ec_post.columns).toContain("id");
		expect(snapshot.schema.ec_post.columns).toContain("title");
		expect(snapshot.schema.ec_post.columns).toContain("slug");
		expect(snapshot.schema.ec_post.columns).toContain("status");

		// System tables with data should appear
		expect(snapshot.schema).toHaveProperty("_emdash_collections");
		expect(snapshot.schema).toHaveProperty("_emdash_fields");

		// _emdash_collections should have 2 rows (post + page)
		expect(snapshot.tables._emdash_collections).toHaveLength(2);
	});

	it("includes published content and excludes drafts by default", async () => {
		// Insert a published post
		await sql`
			INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, version)
			VALUES ('pub1', 'hello-world', 'published', 'Hello World', 'Content here', datetime('now'), datetime('now'), 1)
		`.execute(db);

		// Insert a draft post
		await sql`
			INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, version)
			VALUES ('draft1', 'draft-post', 'draft', 'Draft Post', 'Draft content', datetime('now'), datetime('now'), 1)
		`.execute(db);

		const snapshot = await generateSnapshot(db);

		// Only published content should appear
		expect(snapshot.tables.ec_post).toHaveLength(1);
		expect(snapshot.tables.ec_post[0].slug).toBe("hello-world");
	});

	it("includes drafts when includeDrafts is true", async () => {
		// Insert a published post
		await sql`
			INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, version)
			VALUES ('pub1', 'hello-world', 'published', 'Hello World', 'Content', datetime('now'), datetime('now'), 1)
		`.execute(db);

		// Insert a draft post
		await sql`
			INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, version)
			VALUES ('draft1', 'draft-post', 'draft', 'Draft Post', 'Draft', datetime('now'), datetime('now'), 1)
		`.execute(db);

		const snapshot = await generateSnapshot(db, { includeDrafts: true });

		// Both should appear
		expect(snapshot.tables.ec_post).toHaveLength(2);
	});

	it("includes scheduled posts whose scheduled_at has passed (#917)", async () => {
		const pastIso = new Date(Date.now() - 1000).toISOString();
		await sql`
			INSERT INTO ec_post (id, slug, status, title, content, scheduled_at, created_at, updated_at, version)
			VALUES ('sch1', 'past-schedule', 'scheduled', 'Past', 'c', ${pastIso}, datetime('now'), datetime('now'), 1)
		`.execute(db);

		const snapshot = await generateSnapshot(db);
		const slugs = (snapshot.tables.ec_post ?? []).map((r) => r.slug);

		expect(slugs).toContain("past-schedule");
	});

	it("excludes soft-deleted content", async () => {
		// Insert a published post
		await sql`
			INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, version)
			VALUES ('pub1', 'live-post', 'published', 'Live', 'Content', datetime('now'), datetime('now'), 1)
		`.execute(db);

		// Insert a soft-deleted post
		await sql`
			INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, deleted_at, version)
			VALUES ('del1', 'deleted-post', 'published', 'Deleted', 'Gone', datetime('now'), datetime('now'), datetime('now'), 1)
		`.execute(db);

		const snapshot = await generateSnapshot(db);

		expect(snapshot.tables.ec_post).toHaveLength(1);
		expect(snapshot.tables.ec_post[0].slug).toBe("live-post");
	});

	it("excludes auth and security tables", async () => {
		const snapshot = await generateSnapshot(db);

		// These should not appear in schema or tables
		expect(snapshot.schema).not.toHaveProperty("users");
		expect(snapshot.schema).not.toHaveProperty("sessions");
		expect(snapshot.schema).not.toHaveProperty("credentials");
		expect(snapshot.schema).not.toHaveProperty("challenges");
		expect(snapshot.schema).not.toHaveProperty("_emdash_api_tokens");
		expect(snapshot.schema).not.toHaveProperty("_emdash_oauth_tokens");
	});

	it("includes system tables needed for rendering", async () => {
		const snapshot = await generateSnapshot(db);

		// These system tables should have schema entries
		expect(snapshot.schema).toHaveProperty("_emdash_collections");
		expect(snapshot.schema).toHaveProperty("_emdash_fields");
		expect(snapshot.schema).toHaveProperty("_emdash_migrations");
		expect(snapshot.schema).toHaveProperty("options");
	});

	it("includes column type info in schema", async () => {
		const snapshot = await generateSnapshot(db);

		const postSchema = snapshot.schema.ec_post;
		expect(postSchema).toBeDefined();
		expect(postSchema.types).toBeDefined();
		// PRAGMA table_info returns types as declared (case-sensitive)
		// Kysely creates tables with lowercase types
		expect(postSchema.types!.id.toLowerCase()).toBe("text");
		expect(postSchema.types!.version.toLowerCase()).toBe("integer");
	});

	it("snapshot shape matches DO expectation", async () => {
		await sql`
			INSERT INTO ec_post (id, slug, status, title, content, created_at, updated_at, version)
			VALUES ('p1', 'test', 'published', 'Test', 'Body', datetime('now'), datetime('now'), 1)
		`.execute(db);

		const snapshot: Snapshot = await generateSnapshot(db);

		// Verify shape matches what EmDashPreviewDB.applySnapshot expects
		expect(snapshot).toHaveProperty("tables");
		expect(snapshot).toHaveProperty("schema");
		expect(snapshot).toHaveProperty("generatedAt");
		expect(typeof snapshot.generatedAt).toBe("string");

		// Tables are Record<string, Record<string, unknown>[]>
		for (const [tableName, rows] of Object.entries(snapshot.tables)) {
			expect(typeof tableName).toBe("string");
			expect(Array.isArray(rows)).toBe(true);
			for (const row of rows) {
				expect(typeof row).toBe("object");
			}
		}

		// Schema has columns and types
		for (const [tableName, info] of Object.entries(snapshot.schema)) {
			expect(typeof tableName).toBe("string");
			expect(Array.isArray(info.columns)).toBe(true);
			if (info.types) {
				expect(typeof info.types).toBe("object");
			}
		}
	});

	it("filters options table to safe rendering prefixes only", async () => {
		// Insert site settings (safe — should be included)
		await sql`INSERT INTO options (name, value) VALUES ('site:title', '"My Site"')`.execute(db);
		await sql`INSERT INTO options (name, value) VALUES ('site:tagline', '"Welcome"')`.execute(db);

		// Insert plugin secrets (unsafe — should be excluded)
		await sql`INSERT INTO options (name, value) VALUES ('plugin:smtp:api_key', '"sk-secret-123"')`.execute(
			db,
		);
		await sql`INSERT INTO options (name, value) VALUES ('plugin:seo:license', '"lic-456"')`.execute(
			db,
		);

		// Insert setup/auth data (unsafe — should be excluded)
		await sql`INSERT INTO options (name, value) VALUES ('emdash:setup_complete', 'true')`.execute(
			db,
		);
		await sql`INSERT INTO options (name, value) VALUES ('emdash:passkey_pending:user1', '{"challenge":"abc"}')`.execute(
			db,
		);

		const snapshot = await generateSnapshot(db);

		const optionsRows = snapshot.tables.options;
		expect(optionsRows).toBeDefined();
		expect(optionsRows).toHaveLength(2);

		const names = optionsRows.map((r) => r.name);
		expect(names).toContain("site:title");
		expect(names).toContain("site:tagline");
		expect(names).not.toContain("plugin:smtp:api_key");
		expect(names).not.toContain("plugin:seo:license");
		expect(names).not.toContain("emdash:setup_complete");
		expect(names).not.toContain("emdash:passkey_pending:user1");
	});

	it("discovers content tables dynamically", async () => {
		// The test setup creates ec_post and ec_page
		const snapshot = await generateSnapshot(db);

		expect(snapshot.schema).toHaveProperty("ec_post");
		expect(snapshot.schema).toHaveProperty("ec_page");

		// Verify column discovery matches what we created
		expect(snapshot.schema.ec_post.columns).toContain("title");
		expect(snapshot.schema.ec_post.columns).toContain("content");
		expect(snapshot.schema.ec_page.columns).toContain("title");
		expect(snapshot.schema.ec_page.columns).toContain("content");
	});
});
