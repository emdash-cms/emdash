/**
 * GET /_emdash/api/setup/status
 *
 * Returns setup status and seed file information
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { getAuthMode } from "#auth/mode.js";
import { loadUserSeed } from "#seed/load.js";

export const GET: APIRoute = async ({ locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Check if setup is complete
		const setupComplete = await emdash.db
			.selectFrom("options")
			.select("value")
			.where("name", "=", "emdash:setup_complete")
			.executeTakeFirst();

		// Value is JSON-encoded, parse it. Accepts both boolean true and string "true"
		const isComplete =
			setupComplete &&
			(() => {
				try {
					const parsed = JSON.parse(setupComplete.value);
					return parsed === true || parsed === "true";
				} catch {
					return false;
				}
			})();

		// Also check if users exist
		let hasUsers = false;
		try {
			const userCount = await emdash.db
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
		const setupState = await emdash.db
			.selectFrom("options")
			.select("value")
			.where("name", "=", "emdash:setup_state")
			.executeTakeFirst();

		if (setupState) {
			try {
				const state = JSON.parse(setupState.value);
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
		const authMode = getAuthMode(emdash.config);
		const useExternalAuth = authMode.type === "external";

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
