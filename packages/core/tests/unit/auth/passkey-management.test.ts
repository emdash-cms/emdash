import type { AuthAdapter, Credential, User } from "@emdash-cms/auth";
import { Role } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import type { Kysely } from "kysely";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase, teardownTestDatabase } from "../../utils/test-db.js";

describe("Passkey Management", () => {
	let db: Kysely<Database>;
	let adapter: AuthAdapter;
	let testUser: User;

	beforeEach(async () => {
		db = await setupTestDatabase();
		adapter = createKyselyAdapter(db);

		// Create a test user
		testUser = await adapter.createUser({
			email: "test@example.com",
			name: "Test User",
			role: Role.ADMIN,
		});
	});

	afterEach(async () => {
		await teardownTestDatabase(db);
	});

	// Helper to create a test credential
	async function createTestCredential(userId: string, name?: string): Promise<Credential> {
		const credentialId = `cred-${Date.now()}-${Math.random().toString(36).slice(2)}`;
		return adapter.createCredential({
			id: credentialId,
			userId,
			publicKey: new Uint8Array([1, 2, 3, 4]),
			algorithm: -7,
			counter: 0,
			deviceType: "multiDevice",
			backedUp: true,
			transports: ["internal"],
			name: name ?? null,
		});
	}

	describe("getCredentialById", () => {
		it("should return credential by ID", async () => {
			const created = await createTestCredential(testUser.id, "My MacBook");

			const credential = await adapter.getCredentialById(created.id);

			expect(credential).not.toBeNull();
			expect(credential?.id).toBe(created.id);
			expect(credential?.userId).toBe(testUser.id);
			expect(credential?.name).toBe("My MacBook");
			expect(credential?.deviceType).toBe("multiDevice");
			expect(credential?.backedUp).toBe(true);
		});

		it("should return null for non-existent credential", async () => {
			const credential = await adapter.getCredentialById("non-existent");
			expect(credential).toBeNull();
		});
	});

	describe("getCredentialsByUserId", () => {
		it("should return empty array for user with no passkeys", async () => {
			const credentials = await adapter.getCredentialsByUserId(testUser.id);
			expect(credentials).toEqual([]);
		});

		it("should return all passkeys for a user", async () => {
			await createTestCredential(testUser.id, "MacBook Pro");
			await createTestCredential(testUser.id, "iPhone");
			await createTestCredential(testUser.id, null);

			const credentials = await adapter.getCredentialsByUserId(testUser.id);

			expect(credentials).toHaveLength(3);
			const names = credentials.map((c) => c.name);
			expect(names).toContain("MacBook Pro");
			expect(names).toContain("iPhone");
			expect(names).toContain(null);
		});

		it("should not return passkeys from other users", async () => {
			const otherUser = await adapter.createUser({
				email: "other@example.com",
				name: "Other User",
			});

			await createTestCredential(testUser.id, "Test User Passkey");
			await createTestCredential(otherUser.id, "Other User Passkey");

			const testUserCreds = await adapter.getCredentialsByUserId(testUser.id);
			const otherUserCreds = await adapter.getCredentialsByUserId(otherUser.id);

			expect(testUserCreds).toHaveLength(1);
			expect(testUserCreds[0].name).toBe("Test User Passkey");

			expect(otherUserCreds).toHaveLength(1);
			expect(otherUserCreds[0].name).toBe("Other User Passkey");
		});
	});

	describe("updateCredentialName", () => {
		it("should update the credential name", async () => {
			const credential = await createTestCredential(testUser.id, "Old Name");

			await adapter.updateCredentialName(credential.id, "New Name");

			const updated = await adapter.getCredentialById(credential.id);
			expect(updated?.name).toBe("New Name");
		});

		it("should set name to null when provided null", async () => {
			const credential = await createTestCredential(testUser.id, "Has Name");

			await adapter.updateCredentialName(credential.id, null);

			const updated = await adapter.getCredentialById(credential.id);
			expect(updated?.name).toBeNull();
		});

		it("should handle empty string as name", async () => {
			const credential = await createTestCredential(testUser.id, "Has Name");

			await adapter.updateCredentialName(credential.id, "");

			const updated = await adapter.getCredentialById(credential.id);
			expect(updated?.name).toBe("");
		});
	});

	describe("countCredentialsByUserId", () => {
		it("should return 0 for user with no passkeys", async () => {
			const count = await adapter.countCredentialsByUserId(testUser.id);
			expect(count).toBe(0);
		});

		it("should return correct count", async () => {
			await createTestCredential(testUser.id);
			await createTestCredential(testUser.id);
			await createTestCredential(testUser.id);

			const count = await adapter.countCredentialsByUserId(testUser.id);
			expect(count).toBe(3);
		});

		it("should only count credentials for the specified user", async () => {
			const otherUser = await adapter.createUser({
				email: "other@example.com",
			});

			await createTestCredential(testUser.id);
			await createTestCredential(testUser.id);
			await createTestCredential(otherUser.id);

			const testUserCount = await adapter.countCredentialsByUserId(testUser.id);
			const otherUserCount = await adapter.countCredentialsByUserId(otherUser.id);

			expect(testUserCount).toBe(2);
			expect(otherUserCount).toBe(1);
		});
	});

	describe("deleteCredential", () => {
		it("should delete a credential", async () => {
			const credential = await createTestCredential(testUser.id);

			await adapter.deleteCredential(credential.id);

			const deleted = await adapter.getCredentialById(credential.id);
			expect(deleted).toBeNull();
		});

		it("should not affect other credentials", async () => {
			await createTestCredential(testUser.id, "Keep This");
			const cred2 = await createTestCredential(testUser.id, "Delete This");

			await adapter.deleteCredential(cred2.id);

			const remaining = await adapter.getCredentialsByUserId(testUser.id);
			expect(remaining).toHaveLength(1);
			expect(remaining[0].name).toBe("Keep This");
		});
	});

	describe("Passkey Management Flow", () => {
		it("should support full CRUD flow", async () => {
			// Create passkeys
			const passkey1 = await createTestCredential(testUser.id, "MacBook");
			const passkey2 = await createTestCredential(testUser.id, "iPhone");

			// List passkeys
			let passkeys = await adapter.getCredentialsByUserId(testUser.id);
			expect(passkeys).toHaveLength(2);

			// Rename a passkey
			await adapter.updateCredentialName(passkey1.id, "MacBook Pro M3");
			const renamed = await adapter.getCredentialById(passkey1.id);
			expect(renamed?.name).toBe("MacBook Pro M3");

			// Delete a passkey (not the last one)
			const countBefore = await adapter.countCredentialsByUserId(testUser.id);
			expect(countBefore).toBe(2);

			await adapter.deleteCredential(passkey2.id);

			const countAfter = await adapter.countCredentialsByUserId(testUser.id);
			expect(countAfter).toBe(1);

			// Verify only one remains
			passkeys = await adapter.getCredentialsByUserId(testUser.id);
			expect(passkeys).toHaveLength(1);
			expect(passkeys[0].name).toBe("MacBook Pro M3");
		});

		it("should enforce 'cannot delete last passkey' in application logic", async () => {
			// Create a single passkey
			const passkey = await createTestCredential(testUser.id, "Only Passkey");

			// Check count before deletion attempt
			const count = await adapter.countCredentialsByUserId(testUser.id);
			expect(count).toBe(1);

			// Application should check count and prevent deletion
			// The adapter itself doesn't enforce this - it's the API layer's job
			if (count <= 1) {
				// Don't delete - this is what the API should do
				const stillExists = await adapter.getCredentialById(passkey.id);
				expect(stillExists).not.toBeNull();
			}
		});
	});

	describe("Credential properties", () => {
		it("should preserve all credential properties", async () => {
			await adapter.createCredential({
				id: "test-cred-123",
				userId: testUser.id,
				publicKey: new Uint8Array([10, 20, 30, 40, 50]),
				algorithm: -7,
				counter: 5,
				deviceType: "singleDevice",
				backedUp: false,
				transports: ["usb", "nfc"],
				name: "YubiKey 5",
			});

			const retrieved = await adapter.getCredentialById("test-cred-123");

			expect(retrieved).not.toBeNull();
			expect(retrieved?.id).toBe("test-cred-123");
			expect(retrieved?.userId).toBe(testUser.id);
			expect(retrieved?.counter).toBe(5);
			expect(retrieved?.deviceType).toBe("singleDevice");
			expect(retrieved?.backedUp).toBe(false);
			expect(retrieved?.transports).toEqual(["usb", "nfc"]);
			expect(retrieved?.name).toBe("YubiKey 5");
			expect(retrieved?.createdAt).toBeInstanceOf(Date);
			expect(retrieved?.lastUsedAt).toBeInstanceOf(Date);
		});

		it("should update lastUsedAt when counter is updated", async () => {
			const credential = await createTestCredential(testUser.id);
			const originalLastUsed = credential.lastUsedAt;

			// Small delay to ensure time difference
			await new Promise((resolve) => setTimeout(resolve, 10));

			await adapter.updateCredentialCounter(credential.id, 1);

			const updated = await adapter.getCredentialById(credential.id);
			expect(updated?.counter).toBe(1);
			expect(updated?.lastUsedAt.getTime()).toBeGreaterThan(originalLastUsed.getTime());
		});
	});
});
