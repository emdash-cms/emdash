import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";

import {
	createChallengeStore,
	cleanupExpiredChallenges,
} from "../../../src/auth/challenge-store.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

describe("ChallengeStore", () => {
	let db: Kysely<Database>;
	let store: ReturnType<typeof createChallengeStore>;

	beforeEach(async () => {
		db = await setupTestDatabase();
		store = createChallengeStore(db);
	});

	afterEach(async () => {
		await db.destroy();
	});

	describe("set()", () => {
		it("stores challenge with expiry", async () => {
			const challenge = "test-challenge-123";
			const expiresAt = Date.now() + 5 * 60 * 1000; // 5 minutes

			await store.set(challenge, {
				type: "registration",
				userId: "user-1",
				expiresAt,
			});

			const result = await store.get(challenge);
			expect(result).not.toBeNull();
			expect(result?.type).toBe("registration");
			expect(result?.userId).toBe("user-1");
			expect(result?.expiresAt).toBe(expiresAt);
		});

		it("stores challenge without userId", async () => {
			const challenge = "auth-challenge-456";
			const expiresAt = Date.now() + 5 * 60 * 1000;

			await store.set(challenge, {
				type: "authentication",
				expiresAt,
			});

			const result = await store.get(challenge);
			expect(result).not.toBeNull();
			expect(result?.type).toBe("authentication");
			expect(result?.userId).toBeUndefined();
		});

		it("round-trips typed challenge context", async () => {
			const challenge = "context-challenge-789";
			const expiresAt = Date.now() + 5 * 60 * 1000;
			const context = '{"type":"passkey-enrolment","version":1,"value":{"role":"approver"}}';

			await store.set(challenge, {
				type: "registration",
				userId: "user-1",
				expiresAt,
				context,
			});

			await expect(store.get(challenge)).resolves.toEqual({
				type: "registration",
				userId: "user-1",
				expiresAt,
				context,
			});
		});

		it("updates existing challenge on conflict", async () => {
			const challenge = "update-test";
			const expiresAt1 = Date.now() + 5 * 60 * 1000;
			const expiresAt2 = Date.now() + 10 * 60 * 1000;

			await store.set(challenge, {
				type: "registration",
				userId: "user-1",
				expiresAt: expiresAt1,
			});

			await store.set(challenge, {
				type: "authentication",
				userId: "user-2",
				expiresAt: expiresAt2,
			});

			const result = await store.get(challenge);
			expect(result?.type).toBe("authentication");
			expect(result?.userId).toBe("user-2");
			expect(result?.expiresAt).toBe(expiresAt2);
		});
	});

	describe("get()", () => {
		it("returns stored challenge", async () => {
			const challenge = "get-test";
			const expiresAt = Date.now() + 5 * 60 * 1000;

			await store.set(challenge, {
				type: "registration",
				userId: "user-abc",
				expiresAt,
			});

			const result = await store.get(challenge);
			expect(result).toEqual({
				type: "registration",
				userId: "user-abc",
				expiresAt,
			});
		});

		it("returns null for non-existent challenge", async () => {
			const result = await store.get("does-not-exist");
			expect(result).toBeNull();
		});

		it("returns null for expired challenges and deletes them", async () => {
			vi.useFakeTimers();

			const challenge = "expired-test";
			const expiresAt = Date.now() + 60 * 1000; // 1 minute

			await store.set(challenge, {
				type: "registration",
				expiresAt,
			});

			// Advance time past expiry
			vi.advanceTimersByTime(61 * 1000);

			const result = await store.get(challenge);
			expect(result).toBeNull();

			// Verify it was deleted
			vi.useRealTimers();
			const afterDelete = await db
				.selectFrom("auth_challenges")
				.selectAll()
				.where("challenge", "=", challenge)
				.executeTakeFirst();
			expect(afterDelete).toBeUndefined();
		});
	});

	describe("delete()", () => {
		it("removes challenge", async () => {
			const challenge = "delete-test";
			const expiresAt = Date.now() + 5 * 60 * 1000;

			await store.set(challenge, {
				type: "authentication",
				expiresAt,
			});

			// Verify it exists
			const before = await store.get(challenge);
			expect(before).not.toBeNull();

			// Delete it
			await store.delete(challenge);

			// Verify it's gone
			const after = await store.get(challenge);
			expect(after).toBeNull();
		});

		it("does not throw when deleting non-existent challenge", async () => {
			await expect(store.delete("non-existent")).resolves.not.toThrow();
		});
	});

	describe("cleanupExpiredChallenges()", () => {
		it("removes only expired entries", async () => {
			vi.useFakeTimers();

			const now = Date.now();

			// Create some challenges with different expiry times
			await store.set("expired-1", {
				type: "registration",
				expiresAt: now + 30 * 1000, // expires in 30s
			});
			await store.set("expired-2", {
				type: "authentication",
				expiresAt: now + 60 * 1000, // expires in 60s
			});
			await store.set("valid-1", {
				type: "registration",
				expiresAt: now + 5 * 60 * 1000, // expires in 5 minutes
			});
			await store.set("valid-2", {
				type: "authentication",
				expiresAt: now + 10 * 60 * 1000, // expires in 10 minutes
			});

			// Advance time by 90 seconds (past first two, but not last two)
			vi.advanceTimersByTime(90 * 1000);

			const deleted = await cleanupExpiredChallenges(db);
			expect(deleted).toBe(2);

			// Verify only valid ones remain
			vi.useRealTimers();
			const remaining = await db.selectFrom("auth_challenges").select("challenge").execute();

			expect(remaining.map((r) => r.challenge).toSorted()).toEqual(["valid-1", "valid-2"]);
		});

		it("returns 0 when no expired challenges", async () => {
			const expiresAt = Date.now() + 10 * 60 * 1000;

			await store.set("valid", {
				type: "registration",
				expiresAt,
			});

			const deleted = await cleanupExpiredChallenges(db);
			expect(deleted).toBe(0);
		});

		it("handles empty table", async () => {
			const deleted = await cleanupExpiredChallenges(db);
			expect(deleted).toBe(0);
		});
	});
});
