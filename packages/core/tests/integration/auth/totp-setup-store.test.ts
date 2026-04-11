/**
 * Integration tests for the TOTP setup challenge store.
 *
 * Exercises the three helpers in core/src/auth/totp-setup-store.ts
 * against a real in-memory SQLite database with real auth_challenges
 * rows. Covers: the happy-path round trip, TTL-based expiry, type
 * isolation from WebAuthn challenges, and corrupt-data guards.
 */

import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
	createTOTPSetupChallenge,
	deleteTOTPSetupChallenge,
	getTOTPSetupChallenge,
} from "../../../src/auth/totp-setup-store.js";
import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

let db: Kysely<Database>;

beforeEach(async () => {
	db = await setupTestDatabase();
});

afterEach(async () => {
	await db.destroy();
});

const stubChallenge = {
	email: "alice@example.com",
	name: "Alice" as string | null,
	encryptedSecret: "stub-encrypted-blob",
	recoveryCodeHashes: ["hash-1", "hash-2", "hash-3"],
};

describe("createTOTPSetupChallenge + getTOTPSetupChallenge", () => {
	it("round-trips a challenge with all fields intact", async () => {
		const id = await createTOTPSetupChallenge(db, stubChallenge);

		expect(id).toBeTruthy();
		expect(typeof id).toBe("string");

		const got = await getTOTPSetupChallenge(db, id);
		expect(got).not.toBeNull();
		expect(got?.email).toBe(stubChallenge.email);
		expect(got?.name).toBe(stubChallenge.name);
		expect(got?.encryptedSecret).toBe(stubChallenge.encryptedSecret);
		expect(got?.recoveryCodeHashes).toEqual(stubChallenge.recoveryCodeHashes);
	});

	it("handles null name", async () => {
		const id = await createTOTPSetupChallenge(db, {
			...stubChallenge,
			name: null,
		});
		const got = await getTOTPSetupChallenge(db, id);
		expect(got?.name).toBeNull();
	});

	it("returns null for an unknown challenge id", async () => {
		const got = await getTOTPSetupChallenge(db, "does-not-exist");
		expect(got).toBeNull();
	});

	it("generates distinct ids across calls (concurrency-safe)", async () => {
		const ids = new Set<string>();
		for (let i = 0; i < 50; i++) {
			ids.add(await createTOTPSetupChallenge(db, stubChallenge));
		}
		expect(ids.size).toBe(50);
	});
});

describe("TTL expiry", () => {
	it("returns null and deletes the row when the row has expired", async () => {
		const id = await createTOTPSetupChallenge(db, stubChallenge);

		// Force the row into the past so the getter's expiry check fires.
		await db
			.updateTable("auth_challenges")
			.set({ expires_at: new Date(Date.now() - 1000).toISOString() })
			.where("challenge", "=", id)
			.execute();

		const got = await getTOTPSetupChallenge(db, id);
		expect(got).toBeNull();

		// The getter should have deleted the expired row as a side effect,
		// so a subsequent lookup is still null (not because of expiry
		// re-check, but because the row is gone).
		const rowCount = await db
			.selectFrom("auth_challenges")
			.select((eb) => eb.fn.countAll<number>().as("count"))
			.where("challenge", "=", id)
			.executeTakeFirstOrThrow();
		expect(Number(rowCount.count)).toBe(0);
	});
});

describe("type isolation", () => {
	it("does not return WebAuthn challenges that happen to share an id", async () => {
		// Insert a challenge row with type='registration' manually
		// (as the passkey challenge store would) and verify that
		// getTOTPSetupChallenge does not return it even for a matching id.
		const id = "shared-id";
		await db
			.insertInto("auth_challenges")
			.values({
				challenge: id,
				type: "registration",
				user_id: null,
				data: null,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();

		const got = await getTOTPSetupChallenge(db, id);
		expect(got).toBeNull();
	});
});

describe("corrupt data guard", () => {
	it("returns null when the data column is null", async () => {
		const id = "corrupt-null";
		await db
			.insertInto("auth_challenges")
			.values({
				challenge: id,
				type: "totp_setup",
				user_id: null,
				data: null,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();
		const got = await getTOTPSetupChallenge(db, id);
		expect(got).toBeNull();
	});

	it("returns null when the data column is not valid JSON", async () => {
		const id = "corrupt-garbled";
		await db
			.insertInto("auth_challenges")
			.values({
				challenge: id,
				type: "totp_setup",
				user_id: null,
				data: "not json at all",
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();
		const got = await getTOTPSetupChallenge(db, id);
		expect(got).toBeNull();
	});

	it("returns null when the data payload is missing required fields", async () => {
		const id = "corrupt-partial";
		await db
			.insertInto("auth_challenges")
			.values({
				challenge: id,
				type: "totp_setup",
				user_id: null,
				data: JSON.stringify({ email: "only-email@example.com" }),
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();
		const got = await getTOTPSetupChallenge(db, id);
		expect(got).toBeNull();
	});
});

describe("deleteTOTPSetupChallenge", () => {
	it("removes the row", async () => {
		const id = await createTOTPSetupChallenge(db, stubChallenge);
		await deleteTOTPSetupChallenge(db, id);
		expect(await getTOTPSetupChallenge(db, id)).toBeNull();
	});

	it("is idempotent — deleting an unknown id is a no-op", async () => {
		await expect(deleteTOTPSetupChallenge(db, "does-not-exist")).resolves.not.toThrow();
	});

	it("does not delete WebAuthn challenges that share an id", async () => {
		const id = "shared-id";
		await db
			.insertInto("auth_challenges")
			.values({
				challenge: id,
				type: "registration",
				user_id: null,
				data: null,
				expires_at: new Date(Date.now() + 60_000).toISOString(),
			})
			.execute();

		await deleteTOTPSetupChallenge(db, id);

		// The registration row should still exist.
		const row = await db
			.selectFrom("auth_challenges")
			.selectAll()
			.where("challenge", "=", id)
			.executeTakeFirst();
		expect(row).toBeDefined();
		expect(row?.type).toBe("registration");
	});
});
