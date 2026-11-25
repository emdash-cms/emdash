import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
	clearFirstAdminClaim,
	createFirstAdmin,
	findClaimedFirstAdmin,
	FIRST_ADMIN_LOCK_KEY,
} from "../../../src/api/setup-complete.js";
import {
	describeEachDialect,
	setupForDialect,
	teardownForDialect,
	type DialectTestContext,
} from "../../utils/test-db.js";

describeEachDialect("createFirstAdmin", (dialect) => {
	let ctx: DialectTestContext;

	beforeEach(async () => {
		ctx = await setupForDialect(dialect);
	});

	afterEach(async () => {
		await teardownForDialect(ctx);
	});

	async function users() {
		return ctx.db.selectFrom("users").select(["email", "role"]).orderBy("email").execute();
	}

	it("creates the admin only while no user exists", async () => {
		const first = await createFirstAdmin(ctx.db, { email: "Owner@Example.com", name: "Owner" });
		expect(first).toMatchObject({ email: "owner@example.com", name: "Owner", role: 50 });

		expect(await createFirstAdmin(ctx.db, { email: "other@example.com", name: null })).toBeNull();
		expect(await users()).toEqual([{ email: "owner@example.com", role: 50 }]);
	});

	it("stores the avatar and verified email of an admin who signed in with a provider", async () => {
		await createFirstAdmin(ctx.db, {
			email: "owner@example.com",
			name: null,
			avatarUrl: "https://example.com/owner.png",
			emailVerified: true,
		});

		const owner = await ctx.db
			.selectFrom("users")
			.select(["avatar_url", "email_verified"])
			.executeTakeFirstOrThrow();
		expect(owner).toEqual({ avatar_url: "https://example.com/owner.png", email_verified: 1 });
	});

	it("finds the first admin only by the sign-in account that created it, until cleared", async () => {
		const claim = { provider: "github", providerAccountId: "1" };
		const admin = await createFirstAdmin(ctx.db, { email: "owner@example.com", name: null, claim });

		expect(await findClaimedFirstAdmin(ctx.db, claim)).toBe(admin?.id);
		expect(
			await findClaimedFirstAdmin(ctx.db, { provider: "github", providerAccountId: "2" }),
		).toBeNull();
		expect(
			await findClaimedFirstAdmin(ctx.db, { provider: "google", providerAccountId: "1" }),
		).toBeNull();

		await clearFirstAdminClaim(ctx.db, admin!.id);
		expect(await findClaimedFirstAdmin(ctx.db, claim)).toBeNull();
	});

	it.runIf(dialect === "postgres")(
		"waits for a concurrent admin creation and then refuses",
		async () => {
			let committed!: () => void;
			const commit = new Promise<void>((resolve) => (committed = resolve));
			let locked!: () => void;
			const holding = new Promise<void>((resolve) => (locked = resolve));

			const concurrent = ctx.db.transaction().execute(async (trx) => {
				await sql`SELECT pg_advisory_xact_lock(${FIRST_ADMIN_LOCK_KEY})`.execute(trx);
				await trx
					.insertInto("users")
					.values({
						id: "concurrent-admin",
						email: "concurrent@example.com",
						name: null,
						avatar_url: null,
						role: 50,
						email_verified: 0,
						data: null,
					})
					.execute();
				locked();
				await commit;
			});
			await holding;

			const attempt = createFirstAdmin(ctx.db, { email: "late@example.com", name: null });
			await vi.waitFor(async () => {
				const { rows } = await sql<{ n: number }>`
					SELECT count(*)::int AS n FROM pg_locks
					WHERE locktype = 'advisory' AND objid::bigint = ${FIRST_ADMIN_LOCK_KEY} AND NOT granted
				`.execute(ctx.db);
				expect(rows[0]?.n).toBe(1);
			});
			committed();
			await concurrent;

			expect(await attempt).toBeNull();
			expect(await users()).toEqual([{ email: "concurrent@example.com", role: 50 }]);
		},
	);
});
