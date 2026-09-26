/**
 * POST /_emdash/api/setup
 *
 * Executes the setup wizard - applies seed file and marks setup complete
 */

import type { APIRoute } from "astro";

export const prerender = false;

import { apiError, apiSuccess, handleError } from "#api/error.js";
import { isParseError, parseBody } from "#api/parse.js";
import { getConfiguredOrigin } from "#api/public-url.js";
import { setupBody } from "#api/schemas.js";
import { getAuthMode } from "#auth/mode.js";
import { OptionsRepository } from "#db/repositories/options.js";
import { applySeedWithinBudget, type SeedApplyBudget } from "#seed/apply.js";
import { loadSeed } from "#seed/load.js";
import { validateSeed } from "#seed/validate.js";

/**
 * What one setup request may spend on the seed before the rest continues in
 * the next request. Cloudflare Workers Free allows 1,000 calls to D1, KV and R2
 * and 50 external fetches per request. A `$media` download takes at least three
 * fetches (two DNS-over-HTTPS lookups in `ssrfSafeFetch`, then the file) and
 * three more per redirect. The margin covers a redirect per download, the entry
 * that crosses the budget with its images, the phases after content and the
 * object-cache writes at the end.
 */
const SEED_BUDGET_PER_REQUEST: SeedApplyBudget = { queries: 500, mediaDownloads: 5 };

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

		const configuredSiteUrl = getConfiguredOrigin(emdash.config);
		const loopbackHost =
			url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
		const siteUrl =
			configuredSiteUrl ?? (import.meta.env.DEV && loopbackHost ? url.origin : undefined);
		if (!siteUrl) {
			return apiError(
				"SITE_URL_REQUIRED",
				"Set siteUrl or EMDASH_SITE_URL before running production setup",
				500,
			);
		}

		// Parse request body
		const body = await parseBody(request, setupBody);
		if (isParseError(body)) return body;

		// Load seed file (user seed or built-in default)
		const seed = await loadSeed();

		// Override seed settings with form values
		seed.settings = {
			...seed.settings,
			title: body.title,
			tagline: body.tagline,
		};

		// Apply seed
		const validation = validateSeed(seed);
		if (!validation.valid) {
			return apiError("INVALID_SEED", `Invalid seed file: ${validation.errors.join(", ")}`, 400);
		}

		let seeded;
		try {
			seeded = await applySeedWithinBudget(
				emdash.db,
				seed,
				{
					includeContent: body.includeContent,
					onConflict: "skip",
					storage: emdash.storage ?? undefined,
				},
				SEED_BUDGET_PER_REQUEST,
			);
		} catch (error) {
			return handleError(error, "Failed to apply seed", "SEED_ERROR");
		}
		const { result, complete: seedComplete, progress: seedProgress } = seeded;

		// Store setup state
		// In external auth mode, mark setup complete immediately (first user to login becomes admin)
		// Otherwise, setup_complete is set after admin user is created (passkey or auth provider)
		const authMode = getAuthMode(emdash.config);
		const useExternalAuth = authMode.type === "external";

		try {
			const options = new OptionsRepository(emdash.db);

			// Store the canonical site URL from the setup request.
			// Write-once at the DB level so concurrent setup POSTs can't both
			// observe an empty value and race to write. A spoofed Host header
			// on a later call during the wizard window must not be able to
			// replace the first value.
			await options.setIfAbsent("emdash:site_url", siteUrl);

			if (seedComplete) {
				if (useExternalAuth) {
					// External auth mode: mark setup complete now
					// First user to log in via external provider will become admin
					await options.set("emdash:setup_complete", true);
					await options.set("emdash:site_title", body.title);
					if (body.tagline) {
						await options.set("emdash:site_tagline", body.tagline);
					}
				} else {
					// Passkey/provider mode: store state for next step (admin creation)
					await options.set("emdash:setup_state", {
						step: "site_complete",
						title: body.title,
						tagline: body.tagline,
					});
				}
			}
		} catch (error) {
			console.error("Failed to save setup state:", error);
			// Non-fatal - continue anyway
		}

		if (!seedComplete) {
			// The wizard posts again; items already created are skipped.
			return apiSuccess({
				success: true,
				setupComplete: false,
				seedComplete: false,
				seedProgress,
				result,
			});
		}

		// Return success with result
		return apiSuccess({
			success: true,
			// In external auth mode, setup is complete - redirect to admin
			setupComplete: useExternalAuth,
			seedComplete: true,
			result,
		});
	} catch (error) {
		return handleError(error, "Setup failed", "SETUP_ERROR");
	}
};
