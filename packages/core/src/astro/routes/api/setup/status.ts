/**
 * GET /_emdash/api/setup/status
 *
 * Returns setup status and seed file information
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiSuccess, handleError } from "#api/error.js";
import { getAuthMode } from "#auth/mode.js";
import { loadUserSeed } from "#seed/load.js";
import { getDb } from "../../../../loader.js";

function withTimeout(promise, timeoutMs = 3000) {
	let timer;

	return Promise.race([
		promise.finally(() => clearTimeout(timer)),
		new Promise((_, reject) => {
			timer = setTimeout(() => reject(new Error("Timed out waiting for EmDash database initialization")), timeoutMs);
		}),
	]);
}

export const GET: APIRoute = async ({ locals }) => {
	const { emdash } = locals;

	try {
		const db = emdash?.db ?? (await withTimeout(getDb()));
		let setupCompleteValue = null;
		let setupStateValue = null;
		let hasUsers = false;

		// Check if setup is complete
		try {
			const setupComplete = await db
				.selectFrom("options")
				.select("value")
				.where("name", "=", "emdash:setup_complete")
				.executeTakeFirst();
			setupCompleteValue = setupComplete?.value ?? null;

			const setupState = await db
				.selectFrom("options")
				.select("value")
				.where("name", "=", "emdash:setup_state")
				.executeTakeFirst();
			setupStateValue = setupState?.value ?? null;
		} catch {
			// Fresh environments may not have the options table yet.
		}

		// Value is JSON-encoded, parse it. Accepts both boolean true and string "true"
		const isComplete =
			setupCompleteValue &&
			(() => {
				try {
					const parsed = JSON.parse(setupCompleteValue);
					return parsed === true || parsed === "true";
				} catch {
					return false;
				}
			})();

		// Also check if users exist
		try {
			const userCount = await db
				.selectFrom("users")
				.select((eb) => eb.fn.countAll<number>().as("count"))
				.executeTakeFirstOrThrow();
			hasUsers = userCount.count > 0;
		} catch {
			// Users table might not exist yet
		}

		// Setup is complete only if flag is set AND users exist
		if (isComplete && hasUsers) {
			return apiSuccess({
				needsSetup: false,
			});
		}

		// Determine current step
		// step: "start" | "site" | "admin" | "complete"
		let step: "start" | "site" | "admin" = "start";

		// Get setup state if it exists
		if (setupStateValue) {
			try {
				const state = JSON.parse(setupStateValue);
				if (state.step === "admin") {
					step = "admin";
				} else if (state.step === "site") {
					step = "site";
				}
			} catch {
				// Invalid state, stay at start
			}
		}

		// If setup_complete but no users, jump to admin step
		if (isComplete && !hasUsers) {
			step = "admin";
		}

		// Check auth mode
		const authMode = emdash?.config ? getAuthMode(emdash.config) : null;
		const useExternalAuth = authMode?.type === "external";

		// In external auth mode (not atproto), setup is complete if flag is set (no users required initially)
		if (useExternalAuth && isComplete) {
			return apiSuccess({
				needsSetup: false,
			});
		}

		// Setup needed - try to load seed file info
		const seed = await loadUserSeed();
		const seedInfo = seed
			? {
					name: seed.meta?.name || "Unknown Template",
					description: seed.meta?.description || "",
					collections: seed.collections?.length || 0,
					hasContent: !!(seed.content && Object.keys(seed.content).length > 0),
					title: seed.settings?.title,
					tagline: seed.settings?.tagline,
				}
			: null;

		return apiSuccess({
			needsSetup: true,
			step,
			seedInfo,
			// Tell the wizard which auth mode is active
			authMode: useExternalAuth ? authMode.providerType : "passkey",
		});
	} catch (error) {
		return handleError(error, "Failed to check setup status", "SETUP_STATUS_ERROR");
	}
};
