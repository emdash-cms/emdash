/**
 * Walks the TOTP login state machine against a real SQLite database
 * and the real adapter, covering every transition the route handler
 * drives: success, wrong code, replay, lockout, recovery, and
 * single-use recovery token deletion.
 *
 * Does not hit the HTTP layer — it simulates the route's logic by
 * calling verifyTOTPCode and the adapter methods in the same order
 * the handler does. That's enough to catch bugs in the data model,
 * the verify primitive, and the state transitions without fighting
 * Astro's context shape.
 */

import type { AuthAdapter, User } from "@emdash-cms/auth";
import { Role, encryptWithHKDF, generateAuthSecret } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import {
	LOCKOUT_DURATION_MS,
	LOCKOUT_THRESHOLD,
	generateRecoveryCode,
	generateTOTPSecret,
	hashRecoveryCode,
	verifyTOTPCode,
} from "@emdash-cms/auth/totp";
import { generateHOTP } from "@oslojs/otp";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { Database } from "../../../src/database/types.js";
import { setupTestDatabase } from "../../utils/test-db.js";

let db: Kysely<Database>;
let adapter: AuthAdapter;
let user: User;
let keyBytes: Uint8Array;
let authSecret: string;

const FIXED_NOW_MS = 1700000000000;
const currentStep = () => Math.floor(FIXED_NOW_MS / 30_000);
const codeFor = (step: number) => generateHOTP(keyBytes, BigInt(step), 6);

beforeEach(async () => {
	db = await setupTestDatabase();
	adapter = createKyselyAdapter(db);
	authSecret = generateAuthSecret();

	user = await adapter.createUser({
		email: "alice@example.com",
		name: "Alice",
		role: Role.ADMIN,
	});

	const generated = generateTOTPSecret();
	keyBytes = generated.keyBytes;
	await adapter.createTOTP({
		userId: user.id,
		encryptedSecret: await encryptWithHKDF(generated.base32Secret, authSecret),
		verified: true,
	});
});

afterEach(async () => {
	await db.destroy();
});

describe("TOTP login — happy path", () => {
	it("accepts the current code and bumps lastUsedStep", async () => {
		const step = currentStep();
		const code = codeFor(step);
		const result = verifyTOTPCode(keyBytes, code, { now: FIXED_NOW_MS });

		expect(result.valid).toBe(true);
		expect(result.usedStep).toBe(step);

		await adapter.updateTOTP(user.id, {
			lastUsedStep: result.usedStep!,
			failedAttempts: 0,
			lockedUntil: null,
		});

		const after = await adapter.getTOTPByUserId(user.id);
		expect(after?.lastUsedStep).toBe(step);
		expect(after?.failedAttempts).toBe(0);
		expect(after?.lockedUntil).toBeNull();
	});
});

describe("TOTP login — wrong code", () => {
	it("leaves lastUsedStep unchanged and increments failedAttempts", async () => {
		const result = verifyTOTPCode(keyBytes, "000000", { now: FIXED_NOW_MS });
		expect(result.valid).toBe(false);

		const before = await adapter.getTOTPByUserId(user.id);
		await adapter.updateTOTP(user.id, {
			failedAttempts: before!.failedAttempts + 1,
		});

		const after = await adapter.getTOTPByUserId(user.id);
		expect(after?.failedAttempts).toBe(1);
		expect(after?.lastUsedStep).toBe(before!.lastUsedStep);
	});
});

describe("TOTP login — replay protection", () => {
	it("rejects a code whose matched step equals the stored lastUsedStep", async () => {
		const step = currentStep();
		const code = codeFor(step);

		await adapter.updateTOTP(user.id, { lastUsedStep: step });

		const result = verifyTOTPCode(keyBytes, code, { now: FIXED_NOW_MS });
		expect(result.valid).toBe(true);
		expect(result.usedStep).toBe(step);

		const totp = await adapter.getTOTPByUserId(user.id);
		const isReplay = result.usedStep !== null && result.usedStep <= totp!.lastUsedStep;
		expect(isReplay).toBe(true);
	});

	it("accepts a code whose matched step is greater than lastUsedStep", async () => {
		const step = currentStep();
		await adapter.updateTOTP(user.id, { lastUsedStep: step - 2 });

		const code = codeFor(step);
		const result = verifyTOTPCode(keyBytes, code, { now: FIXED_NOW_MS });
		expect(result.valid).toBe(true);

		const totp = await adapter.getTOTPByUserId(user.id);
		const isReplay = result.usedStep !== null && result.usedStep <= totp!.lastUsedStep;
		expect(isReplay).toBe(false);
	});
});

describe("TOTP login — lockout", () => {
	it("flags the account as locked when failedAttempts reaches the threshold", async () => {
		for (let i = 0; i < LOCKOUT_THRESHOLD; i++) {
			const before = await adapter.getTOTPByUserId(user.id);
			const next = before!.failedAttempts + 1;
			const shouldLock = next >= LOCKOUT_THRESHOLD;
			await adapter.updateTOTP(user.id, {
				failedAttempts: next,
				lockedUntil: shouldLock
					? new Date(FIXED_NOW_MS + LOCKOUT_DURATION_MS).toISOString()
					: null,
			});
		}

		const after = await adapter.getTOTPByUserId(user.id);
		expect(after?.failedAttempts).toBe(LOCKOUT_THRESHOLD);
		expect(after?.lockedUntil).not.toBeNull();
		expect(Date.parse(after!.lockedUntil!)).toBeGreaterThan(FIXED_NOW_MS);
	});

	it("reports locked state for 15 minutes after the threshold", async () => {
		const lockedUntilMs = FIXED_NOW_MS + LOCKOUT_DURATION_MS;
		await adapter.updateTOTP(user.id, {
			failedAttempts: LOCKOUT_THRESHOLD,
			lockedUntil: new Date(lockedUntilMs).toISOString(),
		});

		const totp = await adapter.getTOTPByUserId(user.id);
		const midLockoutNow = FIXED_NOW_MS + LOCKOUT_DURATION_MS / 2;
		const postLockoutNow = FIXED_NOW_MS + LOCKOUT_DURATION_MS + 1;

		expect(Date.parse(totp!.lockedUntil!) > midLockoutNow).toBe(true);
		expect(Date.parse(totp!.lockedUntil!) > postLockoutNow).toBe(false);
	});

	it("resets failedAttempts when the lockout has expired before the next attempt", async () => {
		// Seed a stale lockout that expired 1ms ago.
		const pastLockout = new Date(FIXED_NOW_MS - 1).toISOString();
		await adapter.updateTOTP(user.id, {
			failedAttempts: LOCKOUT_THRESHOLD,
			lockedUntil: pastLockout,
		});

		// Simulate what the route does: observe the row, compute that
		// the lockout just expired, and use a reset base for the next
		// wrong-code write.
		const totp = await adapter.getTOTPByUserId(user.id);
		const lockedUntilMs = totp!.lockedUntil ? Date.parse(totp!.lockedUntil) : 0;
		const isLocked = lockedUntilMs > FIXED_NOW_MS;
		const lockoutJustExpired = totp!.lockedUntil !== null && !isLocked;
		const baseFailedAttempts = lockoutJustExpired ? 0 : totp!.failedAttempts;

		expect(isLocked).toBe(false);
		expect(lockoutJustExpired).toBe(true);
		expect(baseFailedAttempts).toBe(0);

		// Write a fresh-start failure: failedAttempts should be 1, not 11.
		await adapter.updateTOTP(user.id, {
			failedAttempts: baseFailedAttempts + 1,
			lockedUntil: null,
		});

		const after = await adapter.getTOTPByUserId(user.id);
		expect(after?.failedAttempts).toBe(1);
		expect(after?.lockedUntil).toBeNull();
	});
});

describe("TOTP login — recovery codes", () => {
	const plaintextCode = generateRecoveryCode();

	beforeEach(async () => {
		const farFuture = new Date();
		farFuture.setFullYear(farFuture.getFullYear() + 100);
		await adapter.createToken({
			hash: hashRecoveryCode(plaintextCode),
			userId: user.id,
			email: user.email,
			type: "recovery",
			expiresAt: farFuture,
		});
	});

	it("finds the token by hash and clears the lockout state", async () => {
		await adapter.updateTOTP(user.id, {
			failedAttempts: LOCKOUT_THRESHOLD,
			lockedUntil: new Date(FIXED_NOW_MS + LOCKOUT_DURATION_MS).toISOString(),
		});

		const hash = hashRecoveryCode(plaintextCode);
		const token = await adapter.getToken(hash, "recovery");
		expect(token).not.toBeNull();
		expect(token?.userId).toBe(user.id);

		await adapter.deleteToken(hash);
		await adapter.updateTOTP(user.id, { failedAttempts: 0, lockedUntil: null });

		const after = await adapter.getTOTPByUserId(user.id);
		expect(after?.failedAttempts).toBe(0);
		expect(after?.lockedUntil).toBeNull();
	});

	it("is single-use — second lookup returns null", async () => {
		const hash = hashRecoveryCode(plaintextCode);
		const first = await adapter.getToken(hash, "recovery");
		expect(first).not.toBeNull();

		await adapter.deleteToken(hash);

		const second = await adapter.getToken(hash, "recovery");
		expect(second).toBeNull();
	});

	it("rejects a recovery code with the wrong format (not found as a hash)", async () => {
		const bogus = hashRecoveryCode("WRNG-9999");
		const token = await adapter.getToken(bogus, "recovery");
		expect(token).toBeNull();
	});
});

describe("TOTP login — user not found", () => {
	it("getUserByEmail returns null for an unknown email", async () => {
		const found = await adapter.getUserByEmail("nobody@example.com");
		expect(found).toBeNull();
	});

	it("getTOTPByUserId returns null for a user without a credential", async () => {
		const other = await adapter.createUser({
			email: "bob@example.com",
			name: null,
			role: Role.ADMIN,
		});
		const totp = await adapter.getTOTPByUserId(other.id);
		expect(totp).toBeNull();
	});
});
