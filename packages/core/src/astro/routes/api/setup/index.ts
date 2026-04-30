/**
 * POST /_emdash/api/setup
 *
 * Executes the setup wizard - applies seed file and marks setup complete
 */

import type { APIRoute } from "astro";
import { sql } from "kysely";
import virtualConfig from "virtual:emdash/config";
import { createStorage as virtualCreateStorage } from "virtual:emdash/storage";

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

import { getDb } from "../../../../loader.js";

async function shouldRunSetupCoreMigrations(db) {
	try {
		const applied = await db.selectFrom("_emdash_migrations").select("name").limit(1).execute();
		if (applied.length > 0) {
			return false;
		}
	} catch {
		// Missing EmDash ledger can still be valid on Mini-owned schemas.
	}

	try {
		const miniMigrations = await db
			.selectFrom("kysely_migration")
			.select("name")
			.limit(1)
			.execute();
		return miniMigrations.length === 0;
	} catch {
		return true;
	}
}

async function ensureSetupCompatibilitySchema(db) {
	// Each ALTER TABLE is wrapped in its own try/catch so a single
	// missing-table or duplicate-column error doesn't block the rest.
	// "IF NOT EXISTS" is omitted for SQLite <= 3.34 compatibility.
	const alter = async (stmt: string) => {
		try {
			await sql.raw(stmt).execute(db);
		} catch {}
	};

	await alter("ALTER TABLE _emdash_collections ADD COLUMN search_config TEXT");
	await alter("ALTER TABLE _emdash_collections ADD COLUMN has_seo INTEGER NOT NULL DEFAULT 0");
	await alter("ALTER TABLE _emdash_collections ADD COLUMN url_pattern TEXT");
	await alter("ALTER TABLE _emdash_collections ADD COLUMN comments_enabled INTEGER DEFAULT 0");
	await alter(
		"ALTER TABLE _emdash_collections ADD COLUMN comments_moderation TEXT DEFAULT 'first_time'",
	);
	await alter(
		"ALTER TABLE _emdash_collections ADD COLUMN comments_closed_after_days INTEGER DEFAULT 90",
	);
	await alter(
		"ALTER TABLE _emdash_collections ADD COLUMN comments_auto_approve_users INTEGER DEFAULT 1",
	);
	await alter("ALTER TABLE _emdash_fields ADD COLUMN searchable INTEGER DEFAULT 0");
}

async function hasExistingSetupCollections(db) {
	try {
		const result = await sql`SELECT COUNT(*)::int AS count FROM _emdash_collections`.execute(db);
		return Number(result.rows[0]?.count ?? 0) > 0;
	} catch {
		return false;
	}
}

function buildSkippedSeedResult(seed) {
	return {
		collections: { created: 0, skipped: seed.collections?.length ?? 0, updated: 0 },
		fields: {
			created: 0,
			skipped:
				seed.collections?.reduce((count, collection) => count + collection.fields.length, 0) ?? 0,
			updated: 0,
		},
		taxonomies: { created: 0, terms: 0 },
		bylines: { created: 0, skipped: 0, updated: 0 },
		menus: { created: 0, items: 0 },
		redirects: { created: 0, skipped: 0, updated: 0 },
		widgetAreas: { created: 0, widgets: 0 },
		sections: { created: 0, skipped: 0, updated: 0 },
		settings: { applied: 0 },
		content: { created: 0, skipped: 0, updated: 0 },
		media: { created: 0, skipped: 0 },
	};
}

export const POST: APIRoute = async ({ request, url, locals }) => {
	const { emdash } = locals;

	try {
		const db = emdash?.db ?? (await getDb());
		const config = emdash?.config ?? virtualConfig;
		const storage =
			emdash?.storage ??
			(config?.storage && virtualCreateStorage
				? virtualCreateStorage(config.storage.config)
				: undefined);

		// Guard: reject if setup has already been completed.
		// The options table may not exist on first-ever setup (pre-migration),
		// so a query failure means setup hasn't run yet — allow it to proceed.
		try {
			const options = new OptionsRepository(db);
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
			if (await shouldRunSetupCoreMigrations(db)) {
				await runMigrations(db);
			}
			await ensureSetupCompatibilitySchema(db);
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
			result = (await hasExistingSetupCollections(db))
				? buildSkippedSeedResult(seed)
				: await applySeed(
						db,
						{
							...seed,
							settings: {
								...seed.settings,
								title: body.title,
								tagline: body.tagline,
							},
						},
						{
							includeContent: body.includeContent,
							onConflict: "skip",
							storage,
						},
					);
		} catch (error) {
			return handleError(error, "Failed to apply seed", "SEED_ERROR");
		}

		// 5. Store setup state
		// In external auth mode, mark setup complete immediately (first user to login becomes admin)
		// Otherwise, setup_complete is set after admin user is created (passkey or auth provider)
		const authMode = getAuthMode(config);
		const useExternalAuth = authMode.type === "external";

		try {
			const options = new OptionsRepository(db);

			// Store the canonical site URL from the setup request.
			// Write-once at the DB level so concurrent setup POSTs can't both
			// observe an empty value and race to write. A spoofed Host header
			// on a later call during the wizard window must not be able to
			// replace the first value.
			const siteUrl = getPublicOrigin(url, config);
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
				// Passkey/provider mode: store state for next step (admin creation)
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
