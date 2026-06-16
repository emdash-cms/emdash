import type { Kysely } from "kysely";
import { sql } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import {
	checkUniqueFieldConflicts,
	getUniqueFields,
} from "../../../src/api/handlers/unique-check.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import { setupTestDatabaseWithCollections, teardownTestDatabase } from "../../utils/test-db.js";

describe("checkUniqueFieldConflicts", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		registry = new SchemaRegistry(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("should return null when collection has no unique fields", async () => {
		const result = await checkUniqueFieldConflicts(db, "post", "id1", { title: "Test" });
		expect(result).toBeNull();
	});

	it("should return null for unknown collection", async () => {
		const result = await checkUniqueFieldConflicts(db, "nonexistent", "id1", { title: "Test" });
		expect(result).toBeNull();
	});

	it("should return null when unique field value is null", async () => {
		await registry.createField("post", {
			slug: "email",
			label: "Email",
			type: "string",
			unique: true,
		});

		const result = await checkUniqueFieldConflicts(db, "post", "id1", { email: null });
		expect(result).toBeNull();
	});

	it("should detect conflict in content table", async () => {
		await registry.createField("post", {
			slug: "email",
			label: "Email",
			type: "string",
			unique: true,
		});

		await sql`INSERT INTO ec_post (id, slug, status, locale, translation_group, email) VALUES ('id1', 'post-1', 'published', 'en', 'tg1', 'dup@test.com')`.execute(
			db,
		);
		await sql`INSERT INTO ec_post (id, slug, status, locale, translation_group, email) VALUES ('id2', 'post-2', 'published', 'en', 'tg2', 'other@test.com')`.execute(
			db,
		);

		const result = await checkUniqueFieldConflicts(db, "post", "id2", {
			email: "dup@test.com",
		});
		expect(result).not.toBeNull();
		expect(result!.code).toBe("CONFLICT");
	});

	it("should not conflict with the entry's own value", async () => {
		await registry.createField("post", {
			slug: "email",
			label: "Email",
			type: "string",
			unique: true,
		});

		await sql`INSERT INTO ec_post (id, slug, status, locale, translation_group, email) VALUES ('id1', 'post-1', 'published', 'en', 'tg1', 'same@test.com')`.execute(
			db,
		);

		const result = await checkUniqueFieldConflicts(db, "post", "id1", {
			email: "same@test.com",
		});
		expect(result).toBeNull();
	});

	it("should not conflict with soft-deleted entries", async () => {
		await registry.createField("post", {
			slug: "email",
			label: "Email",
			type: "string",
			unique: true,
		});

		await sql`INSERT INTO ec_post (id, slug, status, locale, translation_group, email, deleted_at) VALUES ('id1', 'post-1', 'published', 'en', 'tg1', 'dup@test.com', '2024-01-01')`.execute(
			db,
		);

		const result = await checkUniqueFieldConflicts(db, "post", "id2", {
			email: "dup@test.com",
		});
		expect(result).toBeNull();
	});

	it("should detect conflict in draft revision data", async () => {
		await registry.createField("post", {
			slug: "email",
			label: "Email",
			type: "string",
			unique: true,
		});

		// Insert revision first to satisfy FK, then link it to the entry
		await sql`INSERT INTO ec_post (id, slug, status, locale, translation_group) VALUES ('id1', 'post-1', 'draft', 'en', 'tg1')`.execute(
			db,
		);
		await sql`INSERT INTO revisions (id, collection, entry_id, data) VALUES ('rev1', 'post', 'id1', '{"email":"draft@test.com"}')`.execute(
			db,
		);
		await sql`UPDATE ec_post SET draft_revision_id = 'rev1' WHERE id = 'id1'`.execute(db);

		const result = await checkUniqueFieldConflicts(db, "post", "id2", {
			email: "draft@test.com",
		});
		expect(result).not.toBeNull();
		expect(result!.code).toBe("CONFLICT");
	});

	it("should not conflict with own entry's draft revision", async () => {
		await registry.createField("post", {
			slug: "email",
			label: "Email",
			type: "string",
			unique: true,
		});

		await sql`INSERT INTO ec_post (id, slug, status, locale, translation_group) VALUES ('id1', 'post-1', 'draft', 'en', 'tg1')`.execute(
			db,
		);
		await sql`INSERT INTO revisions (id, collection, entry_id, data) VALUES ('rev1', 'post', 'id1', '{"email":"self@test.com"}')`.execute(
			db,
		);
		await sql`UPDATE ec_post SET draft_revision_id = 'rev1' WHERE id = 'id1'`.execute(db);

		const result = await checkUniqueFieldConflicts(db, "post", "id1", {
			email: "self@test.com",
		});
		expect(result).toBeNull();
	});

	it("should scope conflicts by locale", async () => {
		await registry.createField("post", {
			slug: "email",
			label: "Email",
			type: "string",
			unique: true,
		});

		await sql`INSERT INTO ec_post (id, slug, status, locale, translation_group, email) VALUES ('id1', 'post-1', 'published', 'en', 'tg1', 'dup@test.com')`.execute(
			db,
		);

		// Same locale should conflict
		const sameLocale = await checkUniqueFieldConflicts(
			db,
			"post",
			"id2",
			{ email: "dup@test.com" },
			"en",
		);
		expect(sameLocale).not.toBeNull();

		// Different locale should not conflict
		const diffLocale = await checkUniqueFieldConflicts(
			db,
			"post",
			"id2",
			{ email: "dup@test.com" },
			"fr",
		);
		expect(diffLocale).toBeNull();
	});
});

describe("getUniqueFields", () => {
	let db: Kysely<Database>;
	let registry: SchemaRegistry;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		registry = new SchemaRegistry(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	it("should return empty array for collection with no unique fields", async () => {
		const fields = await getUniqueFields(db, "post");
		expect(fields).toEqual([]);
	});

	it("should return unique fields with required flag", async () => {
		await registry.createField("post", {
			slug: "email",
			label: "Email",
			type: "string",
			unique: true,
			required: true,
		});

		const fields = await getUniqueFields(db, "post");
		expect(fields).toHaveLength(1);
		expect(fields[0]).toEqual({ slug: "email", required: true });
	});

	it("should return empty array for unknown collection", async () => {
		const fields = await getUniqueFields(db, "nonexistent");
		expect(fields).toEqual([]);
	});
});
