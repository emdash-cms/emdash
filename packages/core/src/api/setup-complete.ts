/**
 * Shared setup completion logic.
 *
 * Called by OAuth callbacks and the passkey verify step when the first user
 * is created during setup. Persists site title/tagline from setup state
 * and marks setup as complete.
 */

import type { Kysely } from "kysely";

import { OptionsRepository } from "../database/repositories/options.js";
import type { Database } from "../database/types.js";

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
