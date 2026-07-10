import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";

import { GET, POST } from "../../../src/astro/routes/api/auth/me.js";
import { UserRepository } from "../../../src/database/repositories/user.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("GET/POST /_emdash/api/auth/me – welcome dismiss", () => {
	let db: Kysely<Database>;
	let userRepo: UserRepository;

	beforeEach(async () => {
		db = await setupTestDatabase();
		userRepo = new UserRepository(db);
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	/**
	 * Regression: the welcome-dismissed flag was stored in the Astro session,
	 * which is ephemeral. When the session expired the flag was lost and the
	 * modal appeared again on every login. The fix persists the flag in the
	 * user's `data` JSON column so it survives session rotation.
	 */
	it("persists welcomeDismissed in the database, not the session", async () => {
		const user = await userRepo.create({
			email: "scott@example.com",
			name: "Scott",
			role: "admin",
		});

		// 1. GET should report isFirstLogin = true for a brand-new user
		const getRes1 = await GET({
			locals: { emdash: { db }, user },
			session: { get: vi.fn().mockResolvedValue(undefined), set: vi.fn() },
		} as unknown as Parameters<typeof GET>[0]);

		expect(getRes1.status).toBe(200);
		const body1 = await getRes1.json();
		expect(body1.data.isFirstLogin).toBe(true);

		// 2. POST dismissWelcome should persist the flag
		const sessionSet = vi.fn();
		const postRes = await POST({
			request: new Request("http://localhost/_emdash/api/auth/me", {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({ action: "dismissWelcome" }),
			}),
			locals: { emdash: { db }, user },
			session: { get: vi.fn(), set: sessionSet },
		} as unknown as Parameters<typeof POST>[0]);

		expect(postRes.status).toBe(200);

		// 3. GET ignores the session entirely: even with a stale session flag
		//    claiming the welcome hasn't been seen, the DB-persisted flag wins.
		const staleSession = {
			get: vi.fn().mockResolvedValue(false),
			set: vi.fn(),
		};

		const getRes2 = await GET({
			locals: { emdash: { db }, user: await userRepo.findById(user.id) },
			session: staleSession,
		} as unknown as Parameters<typeof GET>[0]);

		const body2 = await getRes2.json();
		expect(body2.data.isFirstLogin).toBe(false);
		expect(staleSession.get).not.toHaveBeenCalled();
	});
});
