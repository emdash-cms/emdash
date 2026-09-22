/** Tests for cleanup subsystems and scheduled cleanup orchestration. */

import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";
import { ulid } from "ulidx";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { runSystemCleanup } from "../../src/cleanup.js";
import { runMigrations } from "../../src/database/migrations/runner.js";
import { MediaRepository } from "../../src/database/repositories/media.js";
import { RevisionRepository } from "../../src/database/repositories/revision.js";
import type { Database } from "../../src/database/types.js";
import { setupTestDatabase, setupTestDatabaseWithCollections } from "../utils/test-db.js";

describe("Revision Pruning", () => {
	let db: Kysely<Database>;
	let revisionRepo: RevisionRepository;

	beforeEach(async () => {
		db = await setupTestDatabaseWithCollections();
		revisionRepo = new RevisionRepository(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("prunes old revisions keeping the most recent N", async () => {
		const entryId = ulid();

		// Create a content entry
		const { sql } = await import("kysely");
		await sql`
			INSERT INTO ec_post (id, slug, status, created_at, updated_at, version)
			VALUES (${entryId}, ${"test-post"}, ${"draft"}, ${new Date().toISOString()}, ${new Date().toISOString()}, ${1})
		`.execute(db);

		// Create 200 revisions
		for (let i = 0; i < 200; i++) {
			await revisionRepo.create({
				collection: "post",
				entryId,
				data: { title: `Version ${i + 1}` },
			});
		}

		const countBefore = await revisionRepo.countByEntry("post", entryId);
		expect(countBefore).toBe(200);

		// Prune to keep 50
		const pruned = await revisionRepo.pruneOldRevisions("post", entryId, 50);

		expect(pruned).toBe(150);

		const countAfter = await revisionRepo.countByEntry("post", entryId);
		expect(countAfter).toBe(50);

		// Verify the remaining 50 are the newest
		const remaining = await revisionRepo.findByEntry("post", entryId);
		expect(remaining[0]?.data.title).toBe("Version 200");
		expect(remaining[49]?.data.title).toBe("Version 151");
	});

	it("is a no-op when revision count is at or below keepCount", async () => {
		const entryId = ulid();

		const { sql } = await import("kysely");
		await sql`
			INSERT INTO ec_post (id, slug, status, created_at, updated_at, version)
			VALUES (${entryId}, ${"test-post-2"}, ${"draft"}, ${new Date().toISOString()}, ${new Date().toISOString()}, ${1})
		`.execute(db);

		// Create 10 revisions
		for (let i = 0; i < 10; i++) {
			await revisionRepo.create({
				collection: "post",
				entryId,
				data: { title: `Version ${i + 1}` },
			});
		}

		const pruned = await revisionRepo.pruneOldRevisions("post", entryId, 50);
		expect(pruned).toBe(0);

		const countAfter = await revisionRepo.countByEntry("post", entryId);
		expect(countAfter).toBe(10);
	});

	it("prunes eligible history while preserving old live and current draft revisions", async () => {
		const entryId = ulid();
		const { sql } = await import("kysely");
		await sql`
			INSERT INTO ec_post (id, slug, status, created_at, updated_at, version)
			VALUES (${entryId}, ${"referenced-revisions"}, ${"published"}, ${new Date().toISOString()}, ${new Date().toISOString()}, ${1})
		`.execute(db);
		const live = await revisionRepo.create({
			collection: "post",
			entryId,
			data: { title: "Old live" },
		});
		for (let i = 0; i < 55; i++) {
			await revisionRepo.create({
				collection: "post",
				entryId,
				data: { title: `History ${i}` },
			});
		}
		const draft = await revisionRepo.create({
			collection: "post",
			entryId,
			data: { title: "Current draft" },
		});
		await sql`
			UPDATE ec_post
			SET live_revision_id = ${live.id}, draft_revision_id = ${draft.id}
			WHERE id = ${entryId}
		`.execute(db);

		const pruned = await revisionRepo.pruneOldRevisions("post", entryId, 10);

		expect(pruned).toBe(46);
		expect(await revisionRepo.findById(live.id)).not.toBeNull();
		expect(await revisionRepo.findById(draft.id)).not.toBeNull();
		expect(await revisionRepo.countByEntry("post", entryId)).toBe(11);
	});
});

describe("Scheduled system cleanup", () => {
	it("prunes revision entries queued by revision writes", async () => {
		const db = await setupTestDatabaseWithCollections();
		const revisionRepo = new RevisionRepository(db);
		const entryId = ulid();
		const { sql } = await import("kysely");

		try {
			await sql`
				INSERT INTO ec_post (id, slug, status, created_at, updated_at, version)
				VALUES (${entryId}, ${"queued-history"}, ${"draft"}, ${new Date().toISOString()}, ${new Date().toISOString()}, ${1})
			`.execute(db);
			for (let i = 0; i < 51; i++) {
				await revisionRepo.create({
					collection: "post",
					entryId,
					data: { title: `Version ${i + 1}` },
				});
			}

			const result = await runSystemCleanup(db);

			expect(result.revisionsPruned).toBe(1);
			expect(await revisionRepo.countByEntry("post", entryId)).toBe(50);
			expect(
				await db.selectFrom("_emdash_revision_prune_queue").select("entry_id").execute(),
			).toEqual([]);
		} finally {
			await db.destroy();
		}
	});

	it("processes the oldest queued revision entries first", async () => {
		const db = await setupTestDatabaseWithCollections();
		const revisionRepo = new RevisionRepository(db);
		const { sql } = await import("kysely");
		const entryIds = ["z-old", ...Array.from({ length: 10 }, (_, index) => `a0${index}`)];

		try {
			for (const entryId of entryIds) {
				await sql`
					INSERT INTO ec_post (id, slug, status, created_at, updated_at, version)
					VALUES (${entryId}, ${entryId}, ${"draft"}, ${new Date().toISOString()}, ${new Date().toISOString()}, ${1})
				`.execute(db);
				await revisionRepo.create({
					collection: "post",
					entryId,
					data: { title: entryId },
				});
			}

			await runSystemCleanup(db);

			const remaining = await db
				.selectFrom("_emdash_revision_prune_queue")
				.select("entry_id")
				.execute();
			expect(remaining).toHaveLength(1);
			expect(remaining[0]?.entry_id).toMatch(/^a/);
			expect(remaining).not.toContainEqual({ entry_id: "z-old" });
		} finally {
			await db.destroy();
		}
	});

	it("does not query the full revision history", async () => {
		const sqlite = new BetterSqlite3(":memory:");
		const queries: string[] = [];
		const db = new Kysely<Database>({
			dialect: new SqliteDialect({ database: sqlite }),
			log: (event) => {
				if (event.level === "query") queries.push(event.query.sql);
			},
		});

		try {
			await runMigrations(db);
			queries.length = 0;
			await runSystemCleanup(db);

			const revisionQueries = queries.filter((query) =>
				/\b(?:from|delete from)\s+["`]?revisions\b/i.test(query),
			);
			expect(revisionQueries).toHaveLength(0);
		} finally {
			await db.destroy();
		}
	});
});

describe("MediaRepository.cleanupPendingUploads", () => {
	let db: Kysely<Database>;
	let mediaRepo: MediaRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		mediaRepo = new MediaRepository(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("deletes pending uploads older than the default 1 hour", async () => {
		vi.useFakeTimers();

		// Create pending uploads
		for (let i = 0; i < 10; i++) {
			await mediaRepo.createPending({
				filename: `pending-${i}.jpg`,
				mimeType: "image/jpeg",
				storageKey: `uploads/pending-${i}.jpg`,
			});
		}

		// Advance past 1 hour
		vi.advanceTimersByTime(61 * 60 * 1000);

		const deletedKeys = await mediaRepo.cleanupPendingUploads();
		expect(deletedKeys).toHaveLength(10);
		// Verify actual storage keys are returned
		for (let i = 0; i < 10; i++) {
			expect(deletedKeys).toContain(`uploads/pending-${i}.jpg`);
		}

		vi.useRealTimers();
	});

	it("does not delete recent pending uploads", async () => {
		// Create pending uploads (current time -- not yet expired)
		for (let i = 0; i < 5; i++) {
			await mediaRepo.createPending({
				filename: `recent-${i}.jpg`,
				mimeType: "image/jpeg",
				storageKey: `uploads/recent-${i}.jpg`,
			});
		}

		const deletedKeys = await mediaRepo.cleanupPendingUploads();
		expect(deletedKeys).toHaveLength(0);
	});

	it("does not delete ready or failed items", async () => {
		vi.useFakeTimers();

		// Create items with different statuses
		await mediaRepo.create({
			filename: "ready.jpg",
			mimeType: "image/jpeg",
			storageKey: "uploads/ready.jpg",
			status: "ready",
		});

		const pending = await mediaRepo.createPending({
			filename: "pending.jpg",
			mimeType: "image/jpeg",
			storageKey: "uploads/pending.jpg",
		});
		await mediaRepo.markFailed(pending.id);

		// Advance past 1 hour
		vi.advanceTimersByTime(61 * 60 * 1000);

		const deletedKeys = await mediaRepo.cleanupPendingUploads();
		expect(deletedKeys).toHaveLength(0); // failed + ready should not be deleted

		vi.useRealTimers();

		const remaining = await db.selectFrom("media").select("id").execute();
		expect(remaining).toHaveLength(2);
	});

	it("respects custom maxAgeMs parameter", async () => {
		vi.useFakeTimers();

		await mediaRepo.createPending({
			filename: "short-lived.jpg",
			mimeType: "image/jpeg",
			storageKey: "uploads/short-lived.jpg",
		});

		// Advance 10 minutes
		vi.advanceTimersByTime(10 * 60 * 1000);

		// Cleanup with 5 min max age
		const deletedKeys = await mediaRepo.cleanupPendingUploads(5 * 60 * 1000);
		expect(deletedKeys).toHaveLength(1);
		expect(deletedKeys[0]).toBe("uploads/short-lived.jpg");

		vi.useRealTimers();
	});
});

describe("Expired token cleanup", () => {
	let db: Kysely<Database>;

	beforeEach(async () => {
		db = await setupTestDatabase();
	});

	afterEach(async () => {
		await db.destroy();
	});

	it("deletes expired tokens while keeping valid ones", async () => {
		const now = new Date();
		const expired = new Date(now.getTime() - 60 * 1000).toISOString(); // 1 min ago

		// Create a test user first (tokens reference users)
		const userId = ulid();
		await db
			.insertInto("users")
			.values({
				id: userId,
				email: "test@example.com",
				name: "Test",
				avatar_url: null,
				role: 50,
				email_verified: 1,
				disabled: 0,
				data: null,
				created_at: now.toISOString(),
				updated_at: now.toISOString(),
			})
			.execute();

		// Create 100 expired tokens
		for (let i = 0; i < 100; i++) {
			await db
				.insertInto("auth_tokens")
				.values({
					hash: `expired-hash-${i}`,
					user_id: userId,
					email: "test@example.com",
					type: "magic_link",
					role: null,
					invited_by: null,
					expires_at: expired,
					created_at: now.toISOString(),
				})
				.execute();
		}

		// Create 5 valid tokens
		const validExpiry = new Date(now.getTime() + 15 * 60 * 1000).toISOString();
		for (let i = 0; i < 5; i++) {
			await db
				.insertInto("auth_tokens")
				.values({
					hash: `valid-hash-${i}`,
					user_id: userId,
					email: "test@example.com",
					type: "magic_link",
					role: null,
					invited_by: null,
					expires_at: validExpiry,
					created_at: now.toISOString(),
				})
				.execute();
		}

		// Use the DB directly to simulate what deleteExpiredTokens does
		await db.deleteFrom("auth_tokens").where("expires_at", "<", new Date().toISOString()).execute();

		// Verify only valid ones remain
		const remaining = await db.selectFrom("auth_tokens").select("hash").execute();

		expect(remaining).toHaveLength(5);
		expect(remaining.every((r) => r.hash.startsWith("valid-"))).toBe(true);
	});
});
