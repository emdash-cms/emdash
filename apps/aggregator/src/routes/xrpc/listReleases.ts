/**
 * `com.emdashcms.experimental.aggregator.listReleases` — releases for a
 * (did, package), descending semver. Cursor pagination over
 * `(version_sort, version)` so tied semver-precedence cases (shouldn't
 * happen in practice but defensive) still page deterministically.
 *
 * Returns `NotFound` when the parent package isn't indexed, even if a
 * (orphaned) release row exists — the lexicon's contract is "list
 * releases of a known package", not "list any release rows for this
 * (did, package)".
 */

import { InvalidRequestError, json } from "@atcute/xrpc-server";
import { type AggregatorDefs, type AggregatorListReleases } from "@emdash-cms/registry-lexicons";

import {
	ACTIVE_PROJECTION_JOINS_SQL,
	ACTIVE_PROJECTION_POLICY_SQL,
	ACTIVE_PUBLIC_RELEASE_SQL,
	ACTIVE_RELEASE_REDACTION_SQL,
	activeProjectionPolicyBindings,
	activePublicSubjectBindings,
	getListingPolicy,
	type ListingPolicyConfig,
} from "../../listing-policy.js";
import { decodeListCursor, encodeListCursor, InvalidCursorError } from "./cursor.js";
import { lookupPackage, throwPackageLookupError } from "./listing-query.js";
import { type ReleaseRow, releaseColumns, releaseView } from "./views.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function listReleases(
	env: Env,
	params: AggregatorListReleases.$params,
): Promise<Response> {
	const limit = clampLimit(params.limit);
	const session = env.DB.withSession("first-primary");

	const packageResult = await lookupPackage(session, env, params.did, params.package);
	if (packageResult.state !== "visible") throwPackageLookupError(packageResult);
	const policy = await getListingPolicy(env);

	// Cursor encodes the LAST seen (version_sort, version) on the previous
	// page so the next page picks up below it in DESC order. `WHERE`
	// half-tuple inequality so SQLite's index on (did, package, version_sort
	// DESC) stays useful. A *provided* cursor that fails to decode 400s
	// (would otherwise loop the client through page 1 forever).
	let cursor: ReturnType<typeof decodeListCursor>;
	try {
		cursor = decodeListCursor(params.cursor);
	} catch (err) {
		if (err instanceof InvalidCursorError) {
			throw new InvalidRequestError({ error: "InvalidRequest", message: err.message });
		}
		throw err;
	}
	const rows = await session
		.prepare(listReleasesSql(policy, cursor !== null))
		.bind(
			...(policy.mode === "projection" ? activeProjectionPolicyBindings(policy) : []),
			...(policy.mode === "projection" ? activePublicSubjectBindings(policy) : []),
			...(cursor
				? [
						params.did,
						params.package,
						cursor.versionSort,
						cursor.versionSort,
						cursor.version,
						limit + 1,
					]
				: [params.did, params.package, limit + 1]),
		)
		.all<ReleaseRow & { version_sort: string }>();

	const items = rows.results ?? [];
	// Read limit+1 to detect a next page without a trailing COUNT query.
	const hasMore = items.length > limit;
	const page = hasMore ? items.slice(0, limit) : items;
	const last = page.at(-1);

	const response: {
		releases: AggregatorDefs.ReleaseView[];
		cursor?: string;
	} = {
		releases: page.map(releaseView),
	};
	if (hasMore && last) {
		// Cursor encodes the internal `version_sort` format. If the
		// `computeVersionSort` encoding ever changes, in-flight cursors
		// will be cursor-incompatible across the deploy — clients will
		// 400 (per the strict-cursor policy) and fall back to fetching
		// page 1. Acceptable for the experimental NSID; revisit if/when
		// we stabilise.
		response.cursor = encodeListCursor({ versionSort: last.version_sort, version: last.version });
	}
	return json(response);
}

function listReleasesSql(policy: ListingPolicyConfig, hasCursor: boolean): string {
	if (policy.mode === "projection") {
		return `SELECT ${releaseColumns("r.")}, r.labels_json, r.version_sort
			FROM public_projection_state projection_state
			${ACTIVE_PROJECTION_JOINS_SQL}
			JOIN public_releases r ON r.generation = projection_state.active_generation
			JOIN public_packages p
			  ON p.generation = r.generation AND p.did = r.did AND p.slug = r.package
			WHERE projection_state.id = 1
			  AND ${ACTIVE_PROJECTION_POLICY_SQL}
			  AND ${ACTIVE_PUBLIC_RELEASE_SQL}
			  AND ${ACTIVE_RELEASE_REDACTION_SQL}
			  AND r.did = ? AND r.package = ?
			${hasCursor ? "AND (r.version_sort < ? OR (r.version_sort = ? AND r.version < ?))" : ""}
			ORDER BY r.version_sort DESC, r.version DESC
			LIMIT ?`;
	}
	return `SELECT ${releaseColumns("r.")}, r.version_sort
		FROM releases r
		WHERE r.did = ? AND r.package = ? AND r.tombstoned_at IS NULL
		  AND ${ACTIVE_RELEASE_REDACTION_SQL}
		${hasCursor ? "AND (r.version_sort < ? OR (r.version_sort = ? AND r.version < ?))" : ""}
		ORDER BY r.version_sort DESC, r.version DESC
		LIMIT ?`;
}

function clampLimit(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_LIMIT;
	if (raw < 1) return 1;
	if (raw > MAX_LIMIT) return MAX_LIMIT;
	return raw;
}
