import type { AuthAdapter, User } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("TOTP adapter — kysely", () => {
	let db: Kysely<Database>;
	let adapter: AuthAdapter;
	let testUser: User;

	beforeEach(async () => {
		db = await setupTestDatabase();
		adapter = createKyselyAdapter(db);
		testUser = await adapter.createUser({
			email: "alice@example.com",
			name: "Alice",
			role: Role.ADMIN,
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	describe("createTOTP + getTOTPByUserId", () => {
		it("persists a row and reads it back with all defaults", async () => {
			await adapter.createTOTP({
				userId: testUser.id,
				encryptedSecret: "stub-encrypted-blob",
				verified: true,
			});

			const got = await adapter.getTOTPByUserId(testUser.id);
			expect(got).not.toBeNull();
			expect(got?.userId).toBe(testUser.id);
			expect(got?.encryptedSecret).toBe("stub-encrypted-blob");
			expect(got?.algorithm).toBe("SHA1");
			expect(got?.digits).toBe(6);
			expect(got?.period).toBe(30);
			expect(got?.lastUsedStep).toBe(0);
			expect(got?.failedAttempts).toBe(0);
			expect(got?.lockedUntil).toBeNull();
			expect(got?.verified).toBe(true);
			expect(got?.createdAt).toBeInstanceOf(Date);
			expect(got?.updatedAt).toBeInstanceOf(Date);
		});

		it("createTOTP returns the persisted row without a re-read", async () => {
			const created = await adapter.createTOTP({
				userId: testUser.id,
				encryptedSecret: "stub",
				verified: true,
			});
			expect(created.userId).toBe(testUser.id);
			expect(created.failedAttempts).toBe(0);
			expect(created.lockedUntil).toBeNull();
		});

		it("getTOTPByUserId returns null when no row exists", async () => {
			const got = await adapter.getTOTPByUserId(testUser.id);
			expect(got).toBeNull();
		});

		it("rejects a duplicate user_id (PK constraint)", async () => {
			await adapter.createTOTP({ userId: testUser.id, encryptedSecret: "first", verified: true });
			await expect(
				adapter.createTOTP({ userId: testUser.id, encryptedSecret: "second", verified: true }),
			).rejects.toThrow();
		});
	});

	describe("updateTOTP", () => {
		beforeEach(async () => {
			await adapter.createTOTP({
				userId: testUser.id,
				encryptedSecret: "stub",
				verified: true,
			});
		});

		it("bumps lastUsedStep (replay protection state)", async () => {
			await adapter.updateTOTP(testUser.id, { lastUsedStep: 56666666 });
			const after = await adapter.getTOTPByUserId(testUser.id);
			expect(after?.lastUsedStep).toBe(56666666);
		});

		it("increments failedAttempts and sets lockedUntil together", async () => {
			const lockedUntil = new Date(Date.now() + 15 * 60 * 1000).toISOString();
			await adapter.updateTOTP(testUser.id, { failedAttempts: 10, lockedUntil });
			const after = await adapter.getTOTPByUserId(testUser.id);
			expect(after?.failedAttempts).toBe(10);
			expect(after?.lockedUntil).toBe(lockedUntil);
		});

		it("clears lockedUntil with explicit null", async () => {
			await adapter.updateTOTP(testUser.id, {
				failedAttempts: 10,
				lockedUntil: new Date().toISOString(),
			});
			await adapter.updateTOTP(testUser.id, { failedAttempts: 0, lockedUntil: null });
			const after = await adapter.getTOTPByUserId(testUser.id);
			expect(after?.failedAttempts).toBe(0);
			expect(after?.lockedUntil).toBeNull();
		});

		it("partial updates leave other columns alone", async () => {
			const before = await adapter.getTOTPByUserId(testUser.id);
			await adapter.updateTOTP(testUser.id, { lastUsedStep: 42 });
			const after = await adapter.getTOTPByUserId(testUser.id);
			expect(after?.lastUsedStep).toBe(42);
			expect(after?.failedAttempts).toBe(before?.failedAttempts);
			expect(after?.encryptedSecret).toBe(before?.encryptedSecret);
		});
	});

	describe("deleteTOTP", () => {
		it("removes the row", async () => {
			await adapter.createTOTP({
				userId: testUser.id,
				encryptedSecret: "stub",
				verified: true,
			});
			await adapter.deleteTOTP(testUser.id);
			expect(await adapter.getTOTPByUserId(testUser.id)).toBeNull();
		});

		it("is idempotent — deleting a non-existent row is a no-op", async () => {
			await expect(adapter.deleteTOTP(testUser.id)).resolves.not.toThrow();
		});
	});

	describe("foreign key cascade", () => {
		it("deletes the totp_secrets row when the user is deleted", async () => {
			await adapter.createTOTP({
				userId: testUser.id,
				encryptedSecret: "stub",
				verified: true,
			});
			await adapter.deleteUser(testUser.id);
			expect(await adapter.getTOTPByUserId(testUser.id)).toBeNull();
		});
	});
});
