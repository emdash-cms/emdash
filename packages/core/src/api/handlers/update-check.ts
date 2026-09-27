/**
 * Core update status handler.
 *
 * Caches the publish times of stable `emdash` releases from the npm
 * registry in the options table, and reports the newest release that has
 * been public for the minimum release age when it is newer than the
 * running `VERSION`. A stale or missing cache schedules a deferred refresh.
 */

import type { Kysely } from "kysely";

import { after } from "../../after.js";
import { OptionsRepository } from "../../database/repositories/options.js";
import type { Database } from "../../database/types.js";
import { parseDurationSeconds } from "../../registry/config.js";
import { VERSION } from "../../version.js";
import { ErrorCode } from "../errors.js";
import type { ApiResult } from "../types.js";

/** Options-table key for the cached registry result. */
export const CORE_UPDATE_OPTION = "emdash:core_update_check";

/** Check the registry at most once per day, whether or not the check succeeds. */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** npm packument for `emdash`: the `latest` dist-tag and each version's publish time. */
const REGISTRY_URL = "https://registry.npmjs.org/emdash";

/** Default time a release must be public before admins are told about it. */
export const DEFAULT_MINIMUM_RELEASE_AGE = "24h";

const REGISTRY_TIMEOUT_MS = 10_000;

/** Cached registry state, stored in the options table. */
interface CoreUpdateCache {
	/** Publish time (ISO) of each non-deprecated stable release up to the `latest` dist-tag. */
	releases: Record<string, string>;
	/** ISO timestamp of the last registry check. */
	checkedAt: string;
}

export interface CoreUpdateStatus {
	/** The running EmDash version (`"dev"` in uncompiled dev/test runs). */
	current: string;
	/**
	 * Newest stable release that has been public for the minimum release
	 * age, or null when no check has completed yet.
	 */
	latest: string | null;
	updateAvailable: boolean;
	/** ISO timestamp of the last registry check, if any. */
	checkedAt: string | null;
}

const SEMVER_RE = /^(\d+)\.(\d+)\.(\d+)(-.+)?$/;
const STABLE_RE = /^\d+\.\d+\.\d+$/;

/**
 * True when `latest` is a strictly newer release than `current`.
 *
 * Handles plain `major.minor.patch` versions. Anything unparsable —
 * including the `"dev"` fallback version — compares as "not newer", so
 * dev/test runs never show the banner. On an equal base version, a stable
 * release is newer than a prerelease of it, so a site running
 * `0.24.0-beta.1` is notified when `0.24.0` ships. Prerelease identifiers
 * are not compared to each other.
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
	return !l[4] && !!c[4];
}

function field(value: unknown, key: string): unknown {
	return typeof value === "object" && value !== null && Object.hasOwn(value, key)
		? (Reflect.get(value, key) as unknown)
		: undefined;
}

/**
 * Fetch the stable releases and their publish times from the npm registry
 * and cache them. Exported for tests; production callers go through
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
	const latest = field(field(body, "dist-tags"), "latest");
	if (typeof latest !== "string" || !STABLE_RE.test(latest)) {
		throw new Error("registry response missing a valid version");
	}
	const time = field(body, "time");
	const versions = field(body, "versions");
	const releases: Record<string, string> = {};
	if (typeof time === "object" && time !== null) {
		for (const [version, publishedAt] of Object.entries(time)) {
			if (!STABLE_RE.test(version) || isNewerVersion(version, latest)) continue;
			const manifest = field(versions, version);
			if (manifest === undefined || field(manifest, "deprecated") !== undefined) continue;
			if (typeof publishedAt !== "string" || Number.isNaN(Date.parse(publishedAt))) continue;
			releases[version] = publishedAt;
		}
	}
	if (!releases[latest]) {
		throw new Error("registry response missing a publish time for the latest version");
	}
	const cache: CoreUpdateCache = { releases, checkedAt: new Date().toISOString() };
	await new OptionsRepository(db).set(CORE_UPDATE_OPTION, cache);
}

function parseCache(value: unknown): CoreUpdateCache | null {
	const releases = field(value, "releases");
	const checkedAt = field(value, "checkedAt");
	if (typeof releases !== "object" || releases === null || typeof checkedAt !== "string") {
		return null;
	}
	// An unparsable checkedAt would make the staleness math NaN (never
	// stale), freezing a corrupt cache forever — treat it as no cache so
	// the next request schedules a refresh that overwrites it.
	if (Number.isNaN(Date.parse(checkedAt))) return null;
	const valid: Record<string, string> = {};
	for (const [version, publishedAt] of Object.entries(releases)) {
		if (
			STABLE_RE.test(version) &&
			typeof publishedAt === "string" &&
			!Number.isNaN(Date.parse(publishedAt))
		) {
			valid[version] = publishedAt;
		}
	}
	return { releases: valid, checkedAt };
}

/** The newest release published at least `minimumAgeMs` before `now`. */
function newestReleased(
	releases: Record<string, string>,
	now: Date,
	minimumAgeMs: number,
): string | null {
	let newest: string | null = null;
	for (const [version, publishedAt] of Object.entries(releases)) {
		if (now.getTime() - Date.parse(publishedAt) < minimumAgeMs) continue;
		if (!newest || isNewerVersion(version, newest)) newest = version;
	}
	return newest;
}

/**
 * Seconds a release must be public before it is reported, from the
 * `updateCheck` option. Throws on an invalid duration.
 */
export function minimumReleaseAgeSeconds(
	option: boolean | { minimumReleaseAge?: string | number } | null | undefined,
): number {
	const age = typeof option === "object" ? option?.minimumReleaseAge : undefined;
	return parseDurationSeconds(age ?? DEFAULT_MINIMUM_RELEASE_AGE);
}

/**
 * Report the cached update status and, when the cache is stale (or
 * missing), kick a deferred registry refresh. Never blocks on the
 * network: the first request after install/expiry reports the previous
 * state and the next request sees the refreshed one.
 */
export async function handleCoreUpdateStatus(
	db: Kysely<Database>,
	options?: { now?: Date; enabled?: boolean; minimumReleaseAgeSeconds?: number; current?: string },
): Promise<ApiResult<CoreUpdateStatus>> {
	const current = options?.current ?? VERSION;
	if (options?.enabled === false) {
		return {
			success: true,
			data: { current, latest: null, updateAvailable: false, checkedAt: null },
		};
	}

	try {
		const repo = new OptionsRepository(db);
		const cache = parseCache(await repo.get(CORE_UPDATE_OPTION));

		const now = options?.now ?? new Date();
		const minimumAgeMs =
			(options?.minimumReleaseAgeSeconds ?? minimumReleaseAgeSeconds(undefined)) * 1000;
		const stale = !cache || now.getTime() - Date.parse(cache.checkedAt) >= CHECK_INTERVAL_MS;
		// A "dev" version can never compare as outdated, so skip the
		// registry round-trip entirely in uncompiled dev/test runs.
		if (stale && current !== "dev") {
			after(async () => {
				try {
					await refreshCoreUpdateCache(db);
				} catch (error) {
					console.warn("[update-check] registry refresh failed:", error);
					const latestCache = parseCache(await repo.get(CORE_UPDATE_OPTION));
					if (latestCache?.checkedAt !== cache?.checkedAt) return;
					const retryLater: CoreUpdateCache = {
						releases: cache?.releases ?? {},
						checkedAt: new Date().toISOString(),
					};
					await repo.set(CORE_UPDATE_OPTION, retryLater);
				}
			});
		}

		const latest = cache ? newestReleased(cache.releases, now, minimumAgeMs) : null;
		return {
			success: true,
			data: {
				current,
				latest,
				updateAvailable: latest ? isNewerVersion(latest, current) : false,
				checkedAt: cache?.checkedAt ?? null,
			},
		};
	} catch (error) {
		console.error("[update-check] status read failed:", error);
		return {
			success: false,
			error: { code: ErrorCode.UPDATE_CHECK_ERROR, message: "Failed to read update status" },
		};
	}
}
