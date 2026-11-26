/**
 * Shared setup completion logic.
 *
 * Called by OAuth callbacks and the passkey verify step when the first user
 * is created during setup. Persists site title/tagline from setup state
 * and marks setup as complete.
 */

import { Role } from "@emdash-cms/auth";
import { sql, type Kysely } from "kysely";
import { ulid } from "ulidx";

import { isPostgres } from "../database/dialect-helpers.js";
import { OptionsRepository } from "../database/repositories/options.js";
import { UserRepository, type UserDataKey } from "../database/repositories/user.js";
import type { Database } from "../database/types.js";

export const FIRST_ADMIN_LOCK_KEY = 1_168_624_764;

const FIRST_ADMIN_CLAIM_KEY = "firstAdminClaim" satisfies UserDataKey;

export interface FirstAdmin {
	id: string;
	email: string;
	name: string | null;
	role: typeof Role.ADMIN;
}

/** The sign-in account that created the first admin and has yet to be linked to it. */
export interface FirstAdminClaim {
	provider: string;
	providerAccountId: string;
}

/**
 * Create the first admin only while the users table is empty.
 *
 * Returns null when a user already exists, including one created by a
 * concurrent call after the caller's own zero-users check. On Postgres the
 * insert runs under an advisory lock, because `NOT EXISTS` alone doesn't see
 * another transaction's uncommitted row under READ COMMITTED.
 *
 * A `claim` is stored on the new row in the same statement, so a sign-in
 * whose account link fails afterwards can still resume with
 * `findClaimedFirstAdmin`.
 */
export async function createFirstAdmin(
	db: Kysely<Database>,
	input: {
		email: string;
		name: string | null;
		avatarUrl?: string | null;
		emailVerified?: boolean;
		claim?: FirstAdminClaim;
	},
): Promise<FirstAdmin | null> {
	const admin: FirstAdmin = {
		id: ulid(),
		email: input.email.toLowerCase(),
		name: input.name,
		role: Role.ADMIN,
	};
	const now = new Date().toISOString();
	const data = input.claim
		? JSON.stringify({
				[FIRST_ADMIN_CLAIM_KEY]: {
					provider: input.claim.provider,
					providerAccountId: input.claim.providerAccountId,
				},
			})
		: null;
	const insert = async (executor: Kysely<Database>) =>
		sql<{ id: string }>`
			INSERT INTO users (id, email, name, avatar_url, role, email_verified, data, created_at, updated_at)
			SELECT ${admin.id}, ${admin.email}, ${admin.name}, ${input.avatarUrl ?? null},
				CAST(${admin.role} AS integer), CAST(${input.emailVerified ? 1 : 0} AS integer), ${data},
				${now}, ${now}
			WHERE NOT EXISTS (SELECT 1 FROM users)
			RETURNING id
		`.execute(executor);

	const result = isPostgres(db)
		? await db.transaction().execute(async (trx) => {
				await sql`SELECT pg_advisory_xact_lock(${FIRST_ADMIN_LOCK_KEY})`.execute(trx);
				return insert(trx);
			})
		: await insert(db);
	return result.rows.length > 0 ? admin : null;
}

function readClaimData(data: string | null): Record<string, unknown> | null {
	if (!data) return null;
	try {
		const parsed: unknown = JSON.parse(data);
		return parsed && typeof parsed === "object" && !Array.isArray(parsed)
			? // eslint-disable-next-line typescript/no-unsafe-type-assertion -- checked to be a plain object above
				(parsed as Record<string, unknown>)
			: null;
	} catch {
		return null;
	}
}

/**
 * Return the id of the first admin when it is the only user and still
 * carries an unlinked claim for this sign-in account, otherwise null.
 */
export async function findClaimedFirstAdmin(
	db: Kysely<Database>,
	claim: FirstAdminClaim,
): Promise<string | null> {
	const users = await db.selectFrom("users").select(["id", "data"]).limit(2).execute();
	if (users.length !== 1) return null;
	const [user] = users;
	const stored = readClaimData(user.data)?.[FIRST_ADMIN_CLAIM_KEY];
	if (!stored || typeof stored !== "object") return null;
	const { provider, providerAccountId } = stored as Partial<FirstAdminClaim>;
	return provider === claim.provider && providerAccountId === claim.providerAccountId
		? user.id
		: null;
}

/** Remove the first-admin claim once its sign-in account is linked. */
export async function clearFirstAdminClaim(db: Kysely<Database>, userId: string): Promise<void> {
	await new UserRepository(db).removeDataKey(userId, FIRST_ADMIN_CLAIM_KEY);
}

/**
 * Finalize setup after the first admin user is created.
 *
 * Reads the setup_state option (written by the setup wizard's step 1),
 * persists site_title and site_tagline, then marks setup complete.
 *
 * Safe to call multiple times — checks setup_complete first and no-ops
 * if already done.
 */
export async function finalizeSetup(db: Kysely<Database>): Promise<void> {
	const options = new OptionsRepository(db);

	const setupComplete = await options.get("emdash:setup_complete");
	if (setupComplete === true || setupComplete === "true") return;

	// Persist site title/tagline from setup state (stored in step 1)
	const setupState = await options.get<Record<string, unknown>>("emdash:setup_state");
	if (setupState?.title && typeof setupState.title === "string") {
		await options.set("emdash:site_title", setupState.title);
	}
	if (setupState?.tagline && typeof setupState.tagline === "string") {
		await options.set("emdash:site_tagline", setupState.tagline);
	}

	await options.set("emdash:setup_complete", true);
	await options.delete("emdash:setup_state");
}
