import type { Kysely } from "kysely";

import {
	BylineRepository,
	type CreateBylineInput,
	type UpdateBylineInput,
} from "../../database/repositories/byline.js";
import { EmDashValidationError, type BylineSummary } from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import { getI18nConfig } from "../../i18n/config.js";
import type { ApiResult } from "../types.js";

/**
 * Reject locales the site doesn't configure. Returns `null` when the locale
 * is fine (omitted, or matches `locales` in the i18n config, or i18n isn't
 * configured at all).
 */
function rejectUnknownLocale(locale: string | undefined): ApiResult<never> | null {
	if (!locale) return null;
	const config = getI18nConfig();
	if (!config) return null;
	if (config.locales.includes(locale)) return null;
	return {
		success: false,
		error: {
			code: "VALIDATION_ERROR",
			message: `Locale "${locale}" is not configured for this site`,
		},
	};
}

/**
 * Business-logic helpers for the bylines admin API.
 *
 * Mirrors the shape of `packages/core/src/api/handlers/menus.ts`. Route files
 * stay thin: they parse input, call these handlers, and forward the result via
 * `unwrapResult`. The repository (`BylineRepository`) is strict per locale; the
 * handlers add validation and translation-flow guards on top.
 */

export interface BylineTranslationsResponse {
	items: BylineSummary[];
}

/**
 * List every translation of a byline (by row id). Returns NOT_FOUND when no
 * row with the given id exists.
 */
export async function handleBylineTranslations(
	db: Kysely<Database>,
	id: string,
): Promise<ApiResult<BylineTranslationsResponse>> {
	try {
		const repo = new BylineRepository(db);
		const anchor = await repo.findById(id);
		if (!anchor) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Byline not found" },
			};
		}
		const items = await repo.listTranslations(id);
		return { success: true, data: { items } };
	} catch {
		return {
			success: false,
			error: {
				code: "BYLINE_TRANSLATIONS_ERROR",
				message: "Failed to list byline translations",
			},
		};
	}
}

/**
 * Create a new byline. When `translationOf` is supplied, the new row joins the
 * source byline's translation_group (a sibling in the same logical identity).
 *
 * Translating from a source row only makes sense when the caller names the
 * target locale, otherwise we'd silently clone into the configured default,
 * which is almost never what's intended (and will collide if the source is
 * already the default-locale row). Mirrors `handleMenuCreate`.
 */
export async function handleBylineCreate(
	db: Kysely<Database>,
	input: CreateBylineInput,
): Promise<ApiResult<BylineSummary>> {
	try {
		if (input.translationOf && !input.locale) {
			return {
				success: false,
				error: {
					code: "VALIDATION_ERROR",
					message: "`locale` is required when `translationOf` is provided",
				},
			};
		}

		const localeErr = rejectUnknownLocale(input.locale);
		if (localeErr) return localeErr;

		const repo = new BylineRepository(db);

		// Existence check up front so the repo's "Source not found" throw
		// becomes a clean NOT_FOUND on the API.
		let sourceGroup: string | undefined;
		if (input.translationOf) {
			const source = await repo.findById(input.translationOf);
			if (!source) {
				return {
					success: false,
					error: {
						code: "NOT_FOUND",
						message: "Source byline for translation not found",
					},
				};
			}
			sourceGroup = source.translationGroup ?? source.id;
		}

		const effectiveLocale = input.locale ?? getI18nConfig()?.defaultLocale ?? "en";

		// Translation-group guard: the row-per-locale model (PR #916)
		// allows exactly one row per (translation_group, locale). Reject
		// here so callers get a clean 409 instead of a UNIQUE constraint
		// failure from the partial index. The DB constraint is the safety
		// net; this is the friendly error.
		if (sourceGroup) {
			const siblings = await repo.findByTranslationGroup(sourceGroup);
			if (siblings.some((b) => b.locale === effectiveLocale)) {
				return {
					success: false,
					error: {
						code: "CONFLICT",
						message: `Translation already exists in locale "${effectiveLocale}" for this byline`,
					},
				};
			}
		}

		// Duplicate guard: same (slug, locale) — matches the DB unique key
		// added in migration 040. Falls back to the configured defaultLocale
		// when the caller omits `locale`, mirroring the column DEFAULT.
		const existing = await repo.findBySlug(input.slug, { locale: effectiveLocale });
		if (existing) {
			return {
				success: false,
				error: {
					code: "CONFLICT",
					message: `Byline "${input.slug}" already exists${
						input.locale ? ` in locale "${input.locale}"` : ""
					}`,
				},
			};
		}

		const byline = await repo.create(input);
		return { success: true, data: byline };
	} catch {
		return {
			success: false,
			error: { code: "BYLINE_CREATE_ERROR", message: "Failed to create byline" },
		};
	}
}

/**
 * Update an existing byline. Forwards every field on `UpdateBylineInput`
 * to `BylineRepository.update`, including the Phase 3 `customFields`
 * map; per-field type validation lives in the repo, which throws
 * `EmDashValidationError` on unknown slugs, type mismatches, or
 * `select`-choice misses. This handler translates that into a clean
 * `VALIDATION_ERROR` (400 via `mapErrorStatus`).
 *
 * Returns `NOT_FOUND` when the byline id doesn't resolve. Generic
 * failures surface as `BYLINE_UPDATE_ERROR` (500) without leaking the
 * underlying message.
 */
export async function handleBylineUpdate(
	db: Kysely<Database>,
	id: string,
	input: UpdateBylineInput,
): Promise<ApiResult<BylineSummary>> {
	try {
		const repo = new BylineRepository(db);
		const byline = await repo.update(id, input);
		if (!byline) {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: "Byline not found" },
			};
		}
		return { success: true, data: byline };
	} catch (error) {
		// Unknown-key + type-mismatch + select-choice writes throw
		// EmDashValidationError (Phase 3, see BylineRepository.update).
		// Map to a clean 400 — the error message names the offending
		// slug/type, which is safe to surface to the admin client.
		if (error instanceof EmDashValidationError) {
			return {
				success: false,
				error: { code: "VALIDATION_ERROR", message: error.message },
			};
		}
		console.error("[BYLINE_UPDATE_ERROR]", error);
		return {
			success: false,
			error: { code: "BYLINE_UPDATE_ERROR", message: "Failed to update byline" },
		};
	}
}
