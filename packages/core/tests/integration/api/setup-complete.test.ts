import { sql } from "kysely";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { createFirstAdmin, FIRST_ADMIN_LOCK_KEY } from "../../../src/api/setup-complete.js";
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
