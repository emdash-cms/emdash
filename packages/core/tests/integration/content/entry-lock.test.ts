import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { handleContentPermanentDelete } from "../../../src/api/handlers/content.js";
import {
	claimEntryLockForWrite,
	handleEntryLockAcquire,
	handleEntryLockRead,
	handleEntryLockRelease,
} from "../../../src/api/handlers/entry-lock.js";
import { createDatabase } from "../../../src/database/connection.js";
import { runMigrations } from "../../../src/database/migrations/runner.js";
import { ContentRepository } from "../../../src/database/repositories/content.js";
import { EntryLockRepository } from "../../../src/database/repositories/entry-locks.js";
import type { Database } from "../../../src/database/types.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";

const ADA = "user-ada";
const LINUS = "user-linus";

describe("entry edit lock", () => {
	let db: Kysely<Database>;
	let repo: ContentRepository;
	let entryId: string;

	beforeEach(async () => {
		db = createDatabase({ url: ":memory:" });
		await runMigrations(db);
		repo = new ContentRepository(db);
		const registry = new SchemaRegistry(db);

		await registry.createCollection({ slug: "post", label: "Posts", labelSingular: "Post" });
		await registry.createField("post", { slug: "title", label: "Title", type: "string" });
		await db
			.insertInto("users")
			.values([
				{ id: ADA, email: "ada@example.com", name: "Ada", role: 40, email_verified: 1 },
				{ id: LINUS, email: "linus@example.com", name: "Linus", role: 40, email_verified: 1 },
			])
			.execute();

		entryId = (await repo.create({ type: "post", data: { title: "Draft" } })).id;
	});

	afterEach(async () => {
		await db.destroy();
	});

	async function disableLocking(): Promise<void> {
		await db
			.updateTable("_emdash_collections")
			.set({ edit_locking: 0 })
			.where("slug", "=", "post")
			.execute();
	}

	it("reports the caller as the holder after acquiring", async () => {
		const result = await handleEntryLockAcquire(db, "post", entryId, ADA);

		expect(result).toMatchObject({
			success: true,
			data: {
				enabled: true,
				heldByCaller: true,
				holder: { userId: ADA, userName: "Ada" },
			},
		});
	});

	it("names the current holder to the second editor without granting the lock", async () => {
		await handleEntryLockAcquire(db, "post", entryId, ADA);

		const result = await handleEntryLockAcquire(db, "post", entryId, LINUS);

		expect(result).toMatchObject({
			success: true,
			data: { enabled: true, heldByCaller: false, holder: { userId: ADA, userName: "Ada" } },
		});
	});

	it("hands the lock to the second editor on an explicit take-over", async () => {
		await handleEntryLockAcquire(db, "post", entryId, ADA);

		const result = await handleEntryLockAcquire(db, "post", entryId, LINUS, { takeover: true });

		expect(result).toMatchObject({
			success: true,
			data: { heldByCaller: true, holder: { userId: LINUS } },
		});
	});

	it("takes no lock for a collection with locking switched off", async () => {
		await disableLocking();

		const result = await handleEntryLockAcquire(db, "post", entryId, ADA);

		expect(result).toMatchObject({
			success: true,
			data: { enabled: false, holder: null, heldByCaller: false },
		});
		expect(await new EntryLockRepository(db).findLive("post", entryId)).toBeNull();
	});

	it("reports an unknown collection rather than locking nothing", async () => {
		const result = await handleEntryLockAcquire(db, "ghosts", entryId, ADA);

		expect(result).toMatchObject({
			success: false,
			error: { code: "COLLECTION_NOT_FOUND" },
		});
	});

	it("reads back the holder without changing the lease", async () => {
		const acquired = await handleEntryLockAcquire(db, "post", entryId, ADA);
		const expiresAt = acquired.success ? acquired.data.holder?.expiresAt : undefined;

		const read = await handleEntryLockRead(db, "post", entryId, LINUS);

		expect(read).toMatchObject({
			success: true,
			data: { enabled: true, heldByCaller: false, holder: { userId: ADA, expiresAt } },
		});
	});

	it("frees the entry for the next editor on release", async () => {
		await handleEntryLockAcquire(db, "post", entryId, ADA);

		expect(await handleEntryLockRelease(db, "post", entryId, ADA)).toMatchObject({
			success: true,
			data: { released: true },
		});

		const result = await handleEntryLockAcquire(db, "post", entryId, LINUS);
		expect(result).toMatchObject({ success: true, data: { heldByCaller: true } });
	});

	it("ignores a release from someone who is not the holder", async () => {
		await handleEntryLockAcquire(db, "post", entryId, ADA);

		expect(await handleEntryLockRelease(db, "post", entryId, LINUS)).toMatchObject({
			success: true,
			data: { released: false },
		});
		expect(await new EntryLockRepository(db).findLive("post", entryId)).toMatchObject({
			userId: ADA,
		});
	});

	it("releases only for the session that last claimed the lock, when a token is given", async () => {
		await handleEntryLockAcquire(db, "post", entryId, ADA, { token: "tab-1" });

		expect(
			await handleEntryLockRelease(db, "post", entryId, ADA, { token: "tab-2" }),
		).toMatchObject({ success: true, data: { released: false } });
		expect(
			await handleEntryLockRelease(db, "post", entryId, ADA, { token: "tab-1" }),
		).toMatchObject({ success: true, data: { released: true } });
	});

	describe("write path", () => {
		it("allows a write against an entry nobody has opened", async () => {
			expect(await claimEntryLockForWrite(db, "post", entryId, ADA)).toBeNull();
		});

		it("never takes a lock on behalf of a writer", async () => {
			await claimEntryLockForWrite(db, "post", entryId, ADA);

			expect(await new EntryLockRepository(db).findLive("post", entryId)).toBeNull();
		});

		it("extends the holder's own lease so a save keeps the entry open", async () => {
			await handleEntryLockAcquire(db, "post", entryId, ADA);
			const nearlyExpired = isoIn(30_000);
			await db
				.updateTable("_emdash_entry_locks")
				.set({ expires_at: nearlyExpired })
				.where("entry_id", "=", entryId)
				.execute();

			expect(await claimEntryLockForWrite(db, "post", entryId, ADA)).toBeNull();

			const after = await new EntryLockRepository(db).findLive("post", entryId);
			expect(after!.expiresAt > nearlyExpired).toBe(true);
		});

		it("refuses a write against another editor's live lock", async () => {
			await handleEntryLockAcquire(db, "post", entryId, ADA);

			const refusal = await claimEntryLockForWrite(db, "post", entryId, LINUS);

			expect(refusal).toMatchObject({
				code: "ENTRY_LOCKED",
				message: "Ada is holding this entry",
				details: { userId: ADA, userName: "Ada" },
			});
		});

		it("lets a caller that opts out write through another editor's lock", async () => {
			await handleEntryLockAcquire(db, "post", entryId, ADA);

			expect(
				await claimEntryLockForWrite(db, "post", entryId, LINUS, { override: true }),
			).toBeNull();
			expect(await new EntryLockRepository(db).findLive("post", entryId)).toMatchObject({
				userId: ADA,
			});
		});

		it("stops refusing writes once the collection switches locking off", async () => {
			await handleEntryLockAcquire(db, "post", entryId, ADA);
			expect(await claimEntryLockForWrite(db, "post", entryId, LINUS)).not.toBeNull();

			await disableLocking();

			expect(await claimEntryLockForWrite(db, "post", entryId, LINUS)).toBeNull();
		});

		it("stops refusing writes once the lease has expired", async () => {
			await handleEntryLockAcquire(db, "post", entryId, ADA);
			await db
				.updateTable("_emdash_entry_locks")
				.set({ expires_at: "2020-01-01T00:00:00.000Z" })
				.where("entry_id", "=", entryId)
				.execute();

			expect(await claimEntryLockForWrite(db, "post", entryId, LINUS)).toBeNull();
		});
	});

	it("drops the lock when the entry is permanently deleted", async () => {
		await handleEntryLockAcquire(db, "post", entryId, ADA);
		await repo.delete("post", entryId);

		expect(await handleContentPermanentDelete(db, "post", entryId)).toMatchObject({
			success: true,
		});
		expect(
			await db
				.selectFrom("_emdash_entry_locks")
				.selectAll()
				.where("entry_id", "=", entryId)
				.execute(),
		).toEqual([]);
	});
});

function isoIn(milliseconds: number): string {
	return new Date(Date.now() + milliseconds).toISOString();
}
