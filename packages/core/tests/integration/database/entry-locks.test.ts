import { beforeEach, afterEach, expect, it } from "vitest";

import { EntryLockRepository } from "../../../src/database/repositories/entry-locks.js";
import { SchemaRegistry } from "../../../src/schema/registry.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

const LEASE_SECONDS = 420;
const ENTRY_ID = "01JXENTRY0000000000000000";

describeEachDialect("entry lock repository", (dialect) => {
	let ctx: DialectTestContext;
	let repo: EntryLockRepository;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
		repo = new EntryLockRepository(ctx.db);
		await ctx.db
			.insertInto("users")
			.values([
				{ id: "user-ada", email: "ada@example.com", name: "Ada", role: 40, email_verified: 1 },
				{ id: "user-linus", email: "linus@example.com", name: null, role: 40, email_verified: 1 },
			])
			.execute();
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	function acquire(
		userId: string,
		overrides: {
			collection?: string;
			entryId?: string;
			token?: string;
			leaseSeconds?: number;
			takeover?: boolean;
		} = {},
	) {
		return repo.acquire({
			collection: overrides.collection ?? "posts",
			entryId: overrides.entryId ?? ENTRY_ID,
			userId,
			token: overrides.token ?? `tab-${userId}`,
			leaseSeconds: overrides.leaseSeconds ?? LEASE_SECONDS,
			takeover: overrides.takeover,
		});
	}

	async function expire(entryId: string): Promise<void> {
		await ctx.db
			.updateTable("_emdash_entry_locks")
			.set({ expires_at: "2020-01-01T00:00:00.000Z" })
			.where("collection", "=", "posts")
			.where("entry_id", "=", entryId)
			.execute();
	}

	it("acquires a lock for a free entry and reports the holder", async () => {
		const claim = await acquire("user-ada");

		expect(claim.outcome).toBe("acquired");
		expect(claim.lock.userId).toBe("user-ada");
		expect(claim.lock.userName).toBe("Ada");
		expect(claim.lock.expiresAt > claim.lock.acquiredAt).toBe(true);
	});

	it("refuses a second holder while the lease is live", async () => {
		await acquire("user-ada");

		const claim = await acquire("user-linus");

		expect(claim.outcome).toBe("held");
		expect(claim.lock.userId).toBe("user-ada");
		expect(claim.lock.userName).toBe("Ada");
	});

	it("reports a null name for a holder who has not set one", async () => {
		await acquire("user-linus");

		const claim = await acquire("user-ada");

		expect(claim.outcome).toBe("held");
		expect(claim.lock.userName).toBeNull();
	});

	it("lets another holder acquire once the lease has expired", async () => {
		await acquire("user-ada");
		await expire(ENTRY_ID);

		const claim = await acquire("user-linus");

		expect(claim.outcome).toBe("acquired");
		expect(claim.lock.userId).toBe("user-linus");
	});

	it("takes over a live lease only when asked to", async () => {
		const first = await acquire("user-ada");

		const claim = await acquire("user-linus", { takeover: true });

		expect(claim.outcome).toBe("acquired");
		expect(claim.lock.userId).toBe("user-linus");
		expect(claim.lock.acquiredAt >= first.lock.acquiredAt).toBe(true);
		expect(await repo.findLive("posts", ENTRY_ID)).toMatchObject({ userId: "user-linus" });
	});

	it("keeps the original acquisition time when the holder re-acquires", async () => {
		const first = await acquire("user-ada");

		const second = await acquire("user-ada", { leaseSeconds: LEASE_SECONDS * 2 });

		expect(second.outcome).toBe("acquired");
		expect(second.lock.acquiredAt).toBe(first.lock.acquiredAt);
		expect(second.lock.expiresAt > first.lock.expiresAt).toBe(true);
	});

	it("extends only the caller's own live lease on refresh", async () => {
		const first = await acquire("user-ada");

		expect(
			await repo.refreshHeld({
				collection: "posts",
				entryId: ENTRY_ID,
				userId: "user-linus",
				leaseSeconds: LEASE_SECONDS * 2,
			}),
		).toBe(false);
		expect((await repo.findLive("posts", ENTRY_ID))!.expiresAt).toBe(first.lock.expiresAt);

		expect(
			await repo.refreshHeld({
				collection: "posts",
				entryId: ENTRY_ID,
				userId: "user-ada",
				leaseSeconds: LEASE_SECONDS * 2,
			}),
		).toBe(true);
		expect((await repo.findLive("posts", ENTRY_ID))!.expiresAt > first.lock.expiresAt).toBe(true);
	});

	it("does not resurrect an expired lease on refresh", async () => {
		await acquire("user-ada");
		await expire(ENTRY_ID);

		expect(
			await repo.refreshHeld({
				collection: "posts",
				entryId: ENTRY_ID,
				userId: "user-ada",
				leaseSeconds: LEASE_SECONDS,
			}),
		).toBe(false);
		expect(await repo.findLive("posts", ENTRY_ID)).toBeNull();
	});

	it("hides an expired lease from findLive", async () => {
		await acquire("user-ada");
		expect(await repo.findLive("posts", ENTRY_ID)).not.toBeNull();

		await expire(ENTRY_ID);
		expect(await repo.findLive("posts", ENTRY_ID)).toBeNull();
	});

	it("releases only the caller's own lock", async () => {
		await acquire("user-ada");

		expect(
			await repo.release({ collection: "posts", entryId: ENTRY_ID, userId: "user-linus" }),
		).toBe(false);
		expect(await repo.findLive("posts", ENTRY_ID)).not.toBeNull();

		expect(await repo.release({ collection: "posts", entryId: ENTRY_ID, userId: "user-ada" })).toBe(
			true,
		);
		expect(await repo.findLive("posts", ENTRY_ID)).toBeNull();
	});

	it("releases only for the session token that last claimed the lock", async () => {
		await acquire("user-ada", { token: "tab-1" });

		expect(
			await repo.release({
				collection: "posts",
				entryId: ENTRY_ID,
				userId: "user-ada",
				token: "tab-2",
			}),
		).toBe(false);
		expect(await repo.findLive("posts", ENTRY_ID)).not.toBeNull();

		expect(
			await repo.release({
				collection: "posts",
				entryId: ENTRY_ID,
				userId: "user-ada",
				token: "tab-1",
			}),
		).toBe(true);
		expect(await repo.findLive("posts", ENTRY_ID)).toBeNull();
	});

	it("lets a second tab of one account share the entry without the first tab dropping it", async () => {
		await acquire("user-ada", { token: "tab-1" });

		const second = await acquire("user-ada", { token: "tab-2" });
		expect(second.outcome).toBe("acquired");

		expect(
			await repo.release({
				collection: "posts",
				entryId: ENTRY_ID,
				userId: "user-ada",
				token: "tab-1",
			}),
		).toBe(false);
		expect(await repo.findLive("posts", ENTRY_ID)).toMatchObject({ userId: "user-ada" });

		expect(
			await repo.release({
				collection: "posts",
				entryId: ENTRY_ID,
				userId: "user-ada",
				token: "tab-2",
			}),
		).toBe(true);
		expect(await repo.findLive("posts", ENTRY_ID)).toBeNull();
	});

	it("stops reporting an enforceable lock once the collection switches locking off", async () => {
		const registry = new SchemaRegistry(ctx.db);
		await registry.createCollection({ slug: "posts", label: "Posts" });
		await registry.createCollection({ slug: "pages", label: "Pages" });
		await acquire("user-ada");
		expect(await repo.findEnforceable("posts", ENTRY_ID)).toMatchObject({ userId: "user-ada" });

		await ctx.db
			.updateTable("_emdash_collections")
			.set({ edit_locking: 0 })
			.where("slug", "=", "posts")
			.execute();

		expect(await repo.findEnforceable("posts", ENTRY_ID)).toBeNull();
		expect(await repo.findLive("posts", ENTRY_ID)).not.toBeNull();
	});

	it("keeps locks on different entries independent", async () => {
		const other = "01JXENTRY0000000000000001";
		await acquire("user-ada");

		const claim = await acquire("user-linus", { entryId: other });

		expect(claim.outcome).toBe("acquired");
		expect(await repo.findLive("posts", ENTRY_ID)).toMatchObject({ userId: "user-ada" });
		expect(await repo.findLive("posts", other)).toMatchObject({ userId: "user-linus" });
	});

	it("keeps locks on different collections with the same entry id apart", async () => {
		await acquire("user-ada");

		const claim = await acquire("user-linus", { collection: "pages" });

		expect(claim.outcome).toBe("acquired");
		expect(await repo.findLive("posts", ENTRY_ID)).toMatchObject({ userId: "user-ada" });
		expect(await repo.findLive("pages", ENTRY_ID)).toMatchObject({ userId: "user-linus" });

		expect(
			await repo.refreshHeld({
				collection: "pages",
				entryId: ENTRY_ID,
				userId: "user-ada",
				leaseSeconds: LEASE_SECONDS,
			}),
		).toBe(false);
		expect(await repo.release({ collection: "pages", entryId: ENTRY_ID, userId: "user-ada" })).toBe(
			false,
		);
		expect(await repo.findLive("posts", ENTRY_ID)).toMatchObject({ userId: "user-ada" });
		expect(await repo.findLive("pages", ENTRY_ID)).toMatchObject({ userId: "user-linus" });
	});
});
