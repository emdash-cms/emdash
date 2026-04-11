/**
 * Integration test for the full TOTP setup flow end-to-end.
 *
 * Simulates what the /setup/admin-totp and /setup/admin-totp-verify
 * routes do, in order, using the real adapter, real DB, real HKDF
 * encryption, and a real TOTP secret. The only thing this test does
 * not exercise is the Astro HTTP layer (rate limiting, session cookie,
 * request parsing). That's covered by unit tests of the primitives
 * and (eventually) agent-browser tests of the full UI flow.
 *
 * What this catches that unit tests miss:
 *   - The encrypt/decrypt round trip via the store (wire format)
 *   - The base32 → bytes → verify chain is symmetric
 *   - The create-user → create-totp → create-recovery-tokens sequence
 *     produces the correct DB state at every step
 *   - The matched epoch counter from verifyTOTPCode lands in
 *     last_used_step correctly (replay protection wiring)
 */

import type { AuthAdapter } from "@emdash-cms/auth";
import { Role, encryptWithHKDF, generateAuthSecret, decryptWithHKDF } from "@emdash-cms/auth";
import { createKyselyAdapter } from "@emdash-cms/auth/adapters/kysely";
import {
	buildOtpAuthURI,
	generateRecoveryCodes,
	generateTOTPSecret,
	hashRecoveryCode,
	verifyTOTPCode,
} from "@emdash-cms/auth/totp";
import { decodeBase32IgnorePadding } from "@oslojs/encoding";
import { generateHOTP } from "@oslojs/otp";
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
let adapter: AuthAdapter;
let authSecret: string;

beforeEach(async () => {
	db = await setupTestDatabase();
	adapter = createKyselyAdapter(db);
	authSecret = generateAuthSecret();
});

afterEach(async () => {
	await db.destroy();
});

describe("TOTP setup flow end-to-end", () => {
	it("round-trips a full setup from generate → encrypt → store → decrypt → verify → persist", async () => {
		// ── Simulate what POST /setup/admin-totp does ─────────────────
		const email = "alice@example.com";
		const name = "Alice";
		const { keyBytes, base32Secret } = generateTOTPSecret();
		const encryptedSecret = await encryptWithHKDF(base32Secret, authSecret);

		const otpauthUri = buildOtpAuthURI({
			issuer: "Test Site",
			accountName: email,
			keyBytes,
		});
		expect(otpauthUri).toMatch(/^otpauth:\/\/totp\//);

		const recoveryCodes = generateRecoveryCodes();
		expect(recoveryCodes).toHaveLength(10);
		const recoveryCodeHashes = recoveryCodes.map(hashRecoveryCode);

		const challengeId = await createTOTPSetupChallenge(db, {
			email,
			name,
			encryptedSecret,
			recoveryCodeHashes,
		});

		// ── Simulate what POST /setup/admin-totp-verify does ──────────
		const challenge = await getTOTPSetupChallenge(db, challengeId);
		expect(challenge).not.toBeNull();

		// Decrypt and decode the secret from the stored blob back into
		// usable key bytes — this is the path a real login would take.
		const decryptedBase32 = await decryptWithHKDF(challenge!.encryptedSecret, authSecret);
		expect(decryptedBase32).toBe(base32Secret);

		const decryptedKeyBytes = decodeBase32IgnorePadding(decryptedBase32);

		// Generate the current code from the decrypted key bytes and
		// verify it — this proves the round trip is lossless.
		const fixedNow = 1700000000000;
		const currentStep = Math.floor(fixedNow / 30000);
		const code = generateHOTP(decryptedKeyBytes, BigInt(currentStep), 6);

		const result = verifyTOTPCode(decryptedKeyBytes, code, { now: fixedNow });
		expect(result.valid).toBe(true);
		expect(result.usedStep).toBe(currentStep);

		// Persist the admin user, the totp_secrets row, and the
		// recovery tokens in the same order the real verify route does.
		const user = await adapter.createUser({
			email: challenge!.email,
			name: challenge!.name,
			role: Role.ADMIN,
			emailVerified: false,
		});

		await adapter.createTOTP({
			userId: user.id,
			encryptedSecret: challenge!.encryptedSecret,
			verified: true,
		});
		await adapter.updateTOTP(user.id, { lastUsedStep: result.usedStep! });

		const farFuture = new Date();
		farFuture.setFullYear(farFuture.getFullYear() + 100);
		for (const hash of challenge!.recoveryCodeHashes) {
			await adapter.createToken({
				hash,
				userId: user.id,
				email: challenge!.email,
				type: "recovery",
				expiresAt: farFuture,
			});
		}

		await deleteTOTPSetupChallenge(db, challengeId);

		// ── Assert final state ────────────────────────────────────────
		// The user exists and is an admin
		const storedUser = await adapter.getUserByEmail(email);
		expect(storedUser).not.toBeNull();
		expect(storedUser?.role).toBe(Role.ADMIN);

		// The TOTP credential exists and carries the matched replay step
		const totp = await adapter.getTOTPByUserId(user.id);
		expect(totp).not.toBeNull();
		expect(totp?.verified).toBe(true);
		expect(totp?.lastUsedStep).toBe(currentStep);
		expect(totp?.failedAttempts).toBe(0);
		expect(totp?.lockedUntil).toBeNull();
		expect(totp?.encryptedSecret).toBe(encryptedSecret);

		// All 10 recovery code hashes are persisted and scoped to the user
		for (const hash of recoveryCodeHashes) {
			const token = await adapter.getToken(hash, "recovery");
			expect(token).not.toBeNull();
			expect(token?.userId).toBe(user.id);
		}

		// The pending challenge is gone
		expect(await getTOTPSetupChallenge(db, challengeId)).toBeNull();
	});

	it("a different auth secret cannot decrypt the stored blob", async () => {
		const email = "bob@example.com";
		const { base32Secret } = generateTOTPSecret();
		const encryptedSecret = await encryptWithHKDF(base32Secret, authSecret);

		const challengeId = await createTOTPSetupChallenge(db, {
			email,
			name: null,
			encryptedSecret,
			recoveryCodeHashes: Array.from({ length: 10 }, (_, i) => `stub-${i}`),
		});

		const challenge = await getTOTPSetupChallenge(db, challengeId);
		expect(challenge).not.toBeNull();

		const wrongSecret = generateAuthSecret();
		await expect(decryptWithHKDF(challenge!.encryptedSecret, wrongSecret)).rejects.toThrow();
	});

	it("preserves the email casing after lowercase normalization", async () => {
		const { base32Secret } = generateTOTPSecret();
		const encryptedSecret = await encryptWithHKDF(base32Secret, authSecret);
		const email = "Carol@Example.com";

		const challengeId = await createTOTPSetupChallenge(db, {
			// The route normalizes before storing; mirror that here.
			email: email.toLowerCase(),
			name: "Carol",
			encryptedSecret,
			recoveryCodeHashes: Array.from({ length: 10 }, (_, i) => `stub-${i}`),
		});

		const got = await getTOTPSetupChallenge(db, challengeId);
		expect(got?.email).toBe("carol@example.com");
	});
});
