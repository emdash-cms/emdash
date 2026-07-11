/**
 * Core update check (Discussion #1889).
 *
 * WordPress-style "a new version is available" awareness for the admin
 * dashboard. The server knows its own version (`VERSION`); the latest
 * published version comes from the public npm registry, fetched at most
 * once per day and cached in the options table. The registry request is
 * always deferred via `after()` so it never blocks a request — a stale
 * (or missing) cache serves the previous result and refreshes in the
 * background.
 *
 * Deliberately NOT here: an "update now" button. An EmDash update is an
 * npm bump + rebuild + redeploy, which the admin cannot and should not
 * trigger. The value is the awareness.
 */

import type { Kysely } from "kysely";

import { after } from "../../after.js";
import { OptionsRepository } from "../../database/repositories/options.js";
import type { Database } from "../../database/types.js";
import { VERSION } from "../../version.js";
import { ErrorCode } from "../errors.js";
import type { ApiResult } from "../types.js";

/** Options-table key for the cached registry result. */
export const CORE_UPDATE_OPTION = "emdash:core_update_check";

/** Re-check the registry at most once per day. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** npm registry endpoint for the latest published `emdash` version. */
const REGISTRY_URL = "https://registry.npmjs.org/emdash/latest";

const REGISTRY_TIMEOUT_MS = 10_000;

/** Cached registry state, stored in the options table. */
interface CoreUpdateCache {
	/** Latest version the registry reported. */
	latest: string;
	/** ISO timestamp of the last successful registry check. */
	checkedAt: string;
}

export interface CoreUpdateStatus {
	/** The running EmDash version (`"dev"` in uncompiled dev/test runs). */
	current: string;
	/** Latest published version, or null when no check has completed yet. */
	latest: string | null;
	updateAvailable: boolean;
	/** ISO timestamp of the last successful registry check, if any. */
	checkedAt: string | null;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(?:-.+)?$/;

/**
 * True when `latest` is a strictly newer release than `current`.
 *
 * Handles plain `major.minor.patch` versions (what npm's `latest` dist-tag
 * carries). Anything unparsable — including the `"dev"` fallback version —
 * compares as "not newer", so dev/test runs never show the banner.
 * ponytail: prerelease identifiers are ignored (compared as their base
 * release); fine for npm `latest`, which never points at a prerelease.
 */
export function isNewerVersion(latest: string, current: string): boolean {
	const l = SEMVER_RE.exec(latest);
	const c = SEMVER_RE.exec(current);
	if (!l || !c) return false;
	for (let i = 1; i <= 3; i++) {
		const a = Number(l[i]);
		const b = Number(c[i]);
		if (a !== b) return a > b;
	}
	return false;
}

/**
 * Fetch the latest version from the npm registry and cache it.
 * Exported for tests; production callers go through
 * `handleCoreUpdateStatus`, which defers this via `after()`.
 */
export async function refreshCoreUpdateCache(
	db: Kysely<Database>,
	fetchImpl: typeof fetch = fetch,
): Promise<void> {
	const response = await fetchImpl(REGISTRY_URL, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(REGISTRY_TIMEOUT_MS),
	});
	if (!response.ok) {
		throw new Error(`registry responded ${response.status}`);
	}
	const body: unknown = await response.json();
	const latest =
		typeof body === "object" && body !== null && "version" in body ? body.version : null;
	if (typeof latest !== "string" || !SEMVER_RE.test(latest)) {
		throw new Error("registry response missing a valid version");
	}
	const cache: CoreUpdateCache = { latest, checkedAt: new Date().toISOString() };
	await new OptionsRepository(db).set(CORE_UPDATE_OPTION, cache);
}

function parseCache(value: unknown): CoreUpdateCache | null {
	if (typeof value !== "object" || value === null) return null;
	if (!("latest" in value) || !("checkedAt" in value)) return null;
	const { latest, checkedAt } = value;
	if (typeof latest !== "string" || typeof checkedAt !== "string") return null;
	return { latest, checkedAt };
}

/**
 * Report the cached update status and, when the cache is stale (or
 * missing), kick a deferred registry refresh. Never blocks on the
 * network: the first request after install/expiry reports the previous
 * state and the next request sees the refreshed one.
 *
 * ponytail: concurrent stale reads can kick overlapping refreshes; both
 * write the same idempotent option row, so no coordination is needed.
 */
export async function handleCoreUpdateStatus(
	db: Kysely<Database>,
	options?: { now?: Date; enabled?: boolean },
): Promise<ApiResult<CoreUpdateStatus>> {
	// Opt-out (`updateCheck: false` in config): report the current version
	// only — no registry traffic, no banner, and no stale cache leaking
	// through from before the check was disabled.
	if (options?.enabled === false) {
		return {
			success: true,
			data: { current: VERSION, latest: null, updateAvailable: false, checkedAt: null },
		};
	}

	try {
		const raw = await new OptionsRepository(db).get(CORE_UPDATE_OPTION);
		const cache = parseCache(raw);

		const now = options?.now ?? new Date();
		const stale =
			!cache || now.getTime() - new Date(cache.checkedAt).getTime() >= CHECK_INTERVAL_MS;
		// A "dev" version can never compare as outdated, so skip the
		// registry round-trip entirely in uncompiled dev/test runs.
		if (stale && VERSION !== "dev") {
			after(async () => {
				try {
					await refreshCoreUpdateCache(db);
				} catch (error) {
					console.warn("[update-check] registry refresh failed:", error);
				}
			});
		}

		return {
			success: true,
			data: {
				current: VERSION,
				latest: cache?.latest ?? null,
				updateAvailable: cache ? isNewerVersion(cache.latest, VERSION) : false,
				checkedAt: cache?.checkedAt ?? null,
			},
		};
	} catch (error) {
		console.error("Failed to read core update status:", error);
		return {
			success: false,
			error: { code: ErrorCode.UPDATE_CHECK_ERROR, message: "Failed to read update status" },
		};
	}
}
