/**
 * Pending TOTP setup state, stored in auth_challenges with type='totp_setup'
 * and a 15-minute TTL. Uses a random challenge ID so concurrent setup
 * attempts don't stomp on each other.
 */

import { generateToken } from "@emdash-cms/auth";
import { RECOVERY_CODE_COUNT } from "@emdash-cms/auth/totp";
import type { Kysely } from "kysely";

import type { Database } from "../database/types.js";

const TOTP_SETUP_TTL_MS = 15 * 60 * 1000;
const TOTP_SETUP_TYPE = "totp_setup";

export interface TOTPSetupChallengeData {
	email: string;
	name: string | null;
	encryptedSecret: string;
	recoveryCodeHashes: string[];
}

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

/** Returns null for missing or expired rows (and deletes expired rows as a side effect). */
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
		await deleteTOTPSetupChallenge(db, challengeId);
		return null;
	}

	if (!row.data) return null;

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
	// Reject any payload that lost (or gained) recovery code hashes so
	// a corrupted row can't silently produce fewer codes than the user
	// was shown at enrollment.
	if (value.recoveryCodeHashes.length !== RECOVERY_CODE_COUNT) return false;
	return value.recoveryCodeHashes.every((h: unknown) => typeof h === "string");
}

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
