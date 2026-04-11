/**
 * Store for pending TOTP setup state during first-run admin enrollment.
 *
 * The flow is two-step: the /admin-totp route generates a TOTP secret,
 * returns the otpauth URI and recovery codes to the client, and stores
 * the to-be-persisted state here keyed by a random challenge ID. The
 * /admin-totp-verify route then reads that state back, validates the
 * user's first code against the stored secret, and only then persists
 * the totp_secrets row and the recovery token hashes.
 *
 * Why auth_challenges and not a fixed options row (like passkey setup
 * uses): auth_challenges already carries a TTL via `expires_at`, and
 * storing by random challenge ID means two browsers racing on setup
 * each get their own state rather than stomping on one global row.
 * The table is cleaned up on verify success, on TTL expiry, and via
 * the existing cleanupExpiredChallenges helper.
 *
 * Why not reuse createChallengeStore from challenge-store.ts: that
 * store is narrowly typed to WebAuthn challenge types (`registration`
 * | `authentication`) and widening it would mean changing the
 * @emdash-cms/auth ChallengeStore interface. The TOTP setup state has
 * different shape anyway (it carries the encrypted secret and a list
 * of pre-hashed recovery codes), so a small dedicated helper is
 * cleaner than a generic store.
 */

import { generateToken } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

/** How long a pending TOTP setup challenge is valid, in milliseconds. */
const TOTP_SETUP_TTL_MS = 15 * 60 * 1000;

/** The `type` value we use on auth_challenges rows for TOTP setup state. */
const TOTP_SETUP_TYPE = "totp_setup";

/**
 * Shape of the JSON payload stored in auth_challenges.data for a pending
 * TOTP setup. The encrypted secret is the HKDF-encrypted TOTP key bytes
 * (base64url-encoded via encryptWithHKDF). The recovery code hashes are
 * pre-computed at create time so the verify route doesn't have to re-do
 * the work.
 */
export interface TOTPSetupChallengeData {
	email: string;
	name: string | null;
	encryptedSecret: string;
	recoveryCodeHashes: string[];
}

/**
 * Create a pending TOTP setup challenge row.
 *
 * Returns the random challenge ID the caller should send back to the
 * client in the response — the client echoes it on the verify request.
 */
export async function createTOTPSetupChallenge(
	db: Kysely<Database>,
	data: TOTPSetupChallengeData,
): Promise<string> {
	const challengeId = generateToken();
	const expiresAt = new Date(Date.now() + TOTP_SETUP_TTL_MS).toISOString();

	await db
		.insertInto("auth_challenges")
		.values({
			challenge: challengeId,
			type: TOTP_SETUP_TYPE,
			user_id: null,
			data: JSON.stringify(data),
			expires_at: expiresAt,
		})
		.execute();

	return challengeId;
}

/**
 * Read a pending TOTP setup challenge by ID. Returns null if the row
 * doesn't exist OR if it has already expired (expired rows are also
 * deleted as a side-effect, so they don't linger).
 */
export async function getTOTPSetupChallenge(
	db: Kysely<Database>,
	challengeId: string,
): Promise<TOTPSetupChallengeData | null> {
	const row = await db
		.selectFrom("auth_challenges")
		.selectAll()
		.where("challenge", "=", challengeId)
		.where("type", "=", TOTP_SETUP_TYPE)
		.executeTakeFirst();

	if (!row) return null;

	if (new Date(row.expires_at).getTime() < Date.now()) {
		// Expired — delete and return null so the verify route surfaces
		// the same "setup expired, restart" error as a missing row.
		await deleteTOTPSetupChallenge(db, challengeId);
		return null;
	}

	if (!row.data) {
		// Shouldn't happen — the create path always sets data — but
		// treating missing data as a corrupt row is safer than crashing.
		return null;
	}

	try {
		const parsed: unknown = JSON.parse(row.data);
		if (!isTOTPSetupChallengeData(parsed)) {
			return null;
		}
		return parsed;
	} catch {
		return null;
	}
}

function isTOTPSetupChallengeData(value: unknown): value is TOTPSetupChallengeData {
	if (typeof value !== "object" || value === null) return false;
	if (!("email" in value) || typeof value.email !== "string") return false;
	if (!("name" in value) || (value.name !== null && typeof value.name !== "string")) return false;
	if (!("encryptedSecret" in value) || typeof value.encryptedSecret !== "string") return false;
	if (!("recoveryCodeHashes" in value) || !Array.isArray(value.recoveryCodeHashes)) return false;
	return value.recoveryCodeHashes.every((h: unknown) => typeof h === "string");
}

/**
 * Remove a pending TOTP setup challenge. Called after successful verify
 * (so the challenge can't be replayed) and after expiry in getTOTPSetupChallenge.
 */
export async function deleteTOTPSetupChallenge(
	db: Kysely<Database>,
	challengeId: string,
): Promise<void> {
	await db
		.deleteFrom("auth_challenges")
		.where("challenge", "=", challengeId)
		.where("type", "=", TOTP_SETUP_TYPE)
		.execute();
}
