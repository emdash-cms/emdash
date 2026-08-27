/**
 * `com.emdashcms.experimental.aggregator.getLatestRelease` — single-release
 * lookup that returns the highest-precedence non-tombstoned release for a
 * (did, package).
 *
 * The aggregator's writer maintains `packages.latest_version` denormalised
 * from each `releases` insert (see `refreshPackageLatestStmt` in
 * records-consumer.ts), so the fast path is a single JOIN. If that misses
 * — typically because `latest_version` points at a release that was
 * tombstoned after the pointer was written, and the refresh hasn't
 * propagated yet (or failed transactionally) — we fall back to the
 * authoritative ORDER BY query.
 *
 * Without the fallback, a tombstoned-but-still-pointed-at release would
 * make this endpoint return `NotFound` even though the package
 * demonstrably has other live releases (visible via `listReleases`). The
 * denormalisation is an optimisation, not a correctness gate.
 */

import { json, XRPCError } from "@atcute/xrpc-server";
import { type AggregatorGetLatestRelease } from "@emdash-cms/registry-lexicons";

import {
	ACTIVE_PROJECTION_JOINS_SQL,
	ACTIVE_PROJECTION_POLICY_SQL,
	ACTIVE_PROFILE_SQL,
	ACTIVE_PROFILE_REDACTION_SQL,
	ACTIVE_PUBLIC_RELEASE_SQL,
	ACTIVE_RELEASE_REDACTION_SQL,
	activeProjectionPolicyBindings,
	activePublicSubjectBindings,
	getListingPolicy,
	isPackageAllowlisted,
	type ListingPolicyConfig,
} from "../../listing-policy.js";
import {
	lookupPackage,
	throwPackageLookupError,
	throwReleaseUnavailable,
} from "./listing-query.js";
import { type ReleaseRow, releaseColumns, releaseView } from "./views.js";

export async function getLatestRelease(
	env: Env,
	params: AggregatorGetLatestRelease.$params,
): Promise<Response> {
	const session = env.DB.withSession("first-primary");
	const policy = await getListingPolicy(env);
	if (policy.mode === "allowlist" && !isPackageAllowlisted(policy, params.did, params.package)) {
		const result = await lookupPackage(session, env, params.did, params.package);
		if (result.state !== "visible") throwPackageLookupError(result);
	}

	const row = await session
		.prepare(latestReleaseSql(policy))
		.bind(
			...(policy.mode === "projection" ? activeProjectionPolicyBindings(policy) : []),
			...(policy.mode === "projection" ? activePublicSubjectBindings(policy) : []),
			params.did,
			params.package,
		)
		.first<ReleaseRow>();
	if (row) return json(releaseView(row));

	const packageResult = await lookupPackage(session, env, params.did, params.package);
	if (packageResult.state !== "visible") throwPackageLookupError(packageResult);
	if (policy.mode !== "open") throwReleaseUnavailable();

	throw new XRPCError({
		status: 404,
		error: "NotFound",
		message: "No eligible release is indexed under the requested package identity.",
	});
}

function latestReleaseSql(policy: ListingPolicyConfig): string {
	if (policy.mode === "projection") {
		return `SELECT ${releaseColumns("r.")}, r.labels_json
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
			ORDER BY r.version_sort DESC, r.version DESC, r.rkey DESC
			LIMIT 1`;
	}
	return `SELECT ${releaseColumns("r.")}
		FROM packages p
		JOIN releases r ON r.did = p.did AND r.package = p.slug
		WHERE p.did = ? AND p.slug = ?
		  AND ${ACTIVE_PROFILE_SQL}
		  AND ${ACTIVE_PROFILE_REDACTION_SQL}
		  AND r.tombstoned_at IS NULL
		  AND ${ACTIVE_RELEASE_REDACTION_SQL}
		ORDER BY r.version_sort DESC, r.version DESC, r.rkey DESC
		LIMIT 1`;
}
