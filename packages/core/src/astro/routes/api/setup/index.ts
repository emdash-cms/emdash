/**
 * POST /_emdash/api/setup
 *
 * Executes the setup wizard - applies seed file and marks setup complete
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getPublicOrigin } from "#api/public-url.js";
import { setupBody } from "#api/schemas.js";
import { getAuthMode } from "#auth/mode.js";
import { runMigrations } from "#db/migrations/runner.js";
import { OptionsRepository } from "#db/repositories/options.js";
import { applySeed } from "#seed/apply.js";
import { loadSeed } from "#seed/load.js";
import { validateSeed } from "#seed/validate.js";

export const POST: APIRoute = async ({ request, url, locals }) => {
	const { emdash } = locals;

	if (!emdash?.db) {
		return apiError("NOT_CONFIGURED", "EmDash is not initialized", 500);
	}

	try {
		// Guard: reject if setup has already been completed.
		// The options table may not exist on first-ever setup (pre-migration),
		// so a query failure means setup hasn't run yet — allow it to proceed.
		try {
			const options = new OptionsRepository(emdash.db);
			const setupComplete = await options.get("emdash:setup_complete");

			if (setupComplete === true || setupComplete === "true") {
				return apiError("ALREADY_CONFIGURED", "Setup has already been completed", 409);
			}
		} catch {
			// Options table doesn't exist yet — first-ever setup, allow it
		}

		// Parse request body
		const body = await parseBody(request, setupBody);
		if (isParseError(body)) return body;

		// 1. Run core migrations
		try {
			await runMigrations(emdash.db);
		} catch (error) {
			return handleError(error, "Failed to run database migrations", "MIGRATION_ERROR");
		}

		// 2. Load seed file (user seed or built-in default)
		const seed = await loadSeed();

		// 3. Override seed settings with form values
		seed.settings = {
			...seed.settings,
			title: body.title,
			tagline: body.tagline,
		};

		// 4. Apply seed
		const validation = validateSeed(seed);
		if (!validation.valid) {
			return apiError("INVALID_SEED", `Invalid seed file: ${validation.errors.join(", ")}`, 400);
		}

		let result;
		try {
			result = await applySeed(emdash.db, seed, {
				includeContent: body.includeContent,
				onConflict: "skip",
				storage: emdash.storage ?? undefined,
			});
		} catch (error) {
			return handleError(error, "Failed to apply seed", "SEED_ERROR");
		}

		// 5. Store setup state
		// In external auth mode, mark setup complete immediately (first user to login becomes admin)
		// In passkey mode, setup_complete is set after admin user is created
		const authMode = getAuthMode(emdash.config);
		const useExternalAuth = authMode.type === "external";

		try {
			const options = new OptionsRepository(emdash.db);

			// Store the canonical site URL from the setup request.
			// Write-once at the DB level so concurrent setup POSTs can't both
			// observe an empty value and race to write. A spoofed Host header
			// on a later call during the wizard window must not be able to
			// replace the first value.
			const siteUrl = getPublicOrigin(url, emdash.config);
			await options.setIfAbsent("emdash:site_url", siteUrl);

			if (useExternalAuth) {
				// External auth mode: mark setup complete now
				// First user to log in via external provider will become admin
				await options.set("emdash:setup_complete", true);
				await options.set("emdash:site_title", body.title);
				if (body.tagline) {
					await options.set("emdash:site_tagline", body.tagline);
				}
			} else {
				// Passkey mode: store state for next step (admin creation)
				await options.set("emdash:setup_state", {
					step: "site_complete",
					title: body.title,
					tagline: body.tagline,
				});
			}
		} catch (error) {
			console.error("Failed to save setup state:", error);
			// Non-fatal - continue anyway
		}

		// 6. Return success with result
		return apiSuccess({
			success: true,
			// In external auth mode, setup is complete - redirect to admin
			setupComplete: useExternalAuth,
			result,
		});
	} catch (error) {
		return handleError(error, "Setup failed", "SETUP_ERROR");
	}
};
