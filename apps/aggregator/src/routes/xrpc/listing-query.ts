import { XRPCError } from "@atcute/xrpc-server";

import {
	ACTIVE_PROJECTION_JOINS_SQL,
	ACTIVE_PROJECTION_POLICY_SQL,
	ACTIVE_PROFILE_SQL,
	ACTIVE_PROFILE_REDACTION_SQL,
	ACTIVE_PUBLIC_PACKAGE_SQL,
	activeProjectionPolicyBindings,
	activePublicSubjectBindings,
	getListingPolicy,
	isPackageAllowlisted,
} from "../../listing-policy.js";
import { type PackageRow, packageColumns } from "./views.js";

const RELEASE_HISTORY_COLUMNS_SQL = `
	(SELECT COUNT(*)
	   FROM releases release_history
	  WHERE release_history.did = p.did
	    AND release_history.package = p.slug) AS historical_release_count,
	COALESCE(
		(SELECT history.release_history_complete
		   FROM package_release_history history
		  WHERE history.did = p.did AND history.package = p.slug),
		0
	) AS release_history_complete
`;

export type PackageLookupResult =
	| { state: "visible"; row: PackageRow }
	| { state: "unavailable" }
	| { state: "not-found" };

export async function lookupPackage(
	session: D1DatabaseSession,
	env: Env,
	did: string,
	slug: string,
): Promise<PackageLookupResult> {
	const policy = await getListingPolicy(env);
	if (policy.mode === "projection") {
		const row = await session
			.prepare(
				`SELECT ${packageColumns("p.")}, p.labels_json, ${RELEASE_HISTORY_COLUMNS_SQL}
				 FROM public_projection_state projection_state
				 ${ACTIVE_PROJECTION_JOINS_SQL}
				 JOIN public_packages p ON p.generation = projection_state.active_generation
				 WHERE projection_state.id = 1
				   AND ${ACTIVE_PROJECTION_POLICY_SQL}
				   AND ${ACTIVE_PUBLIC_PACKAGE_SQL}
				   AND p.did = ? AND p.slug = ?`,
			)
			.bind(
				...activeProjectionPolicyBindings(policy),
				...activePublicSubjectBindings(policy),
				did,
				slug,
			)
			.first<PackageRow>();
		if (row) return { state: "visible", row };
		return (await stagedPackageExists(session, did, slug))
			? { state: "unavailable" }
			: { state: "not-found" };
	}

	const row = await session
		.prepare(
			`SELECT ${packageColumns("p.")}, ${RELEASE_HISTORY_COLUMNS_SQL}
			 FROM packages p
			 WHERE p.did = ? AND p.slug = ?
			   AND ${ACTIVE_PROFILE_SQL}
			   AND ${ACTIVE_PROFILE_REDACTION_SQL}`,
		)
		.bind(did, slug)
		.first<PackageRow>();
	if (!row) return { state: "not-found" };
	if (policy.mode === "allowlist" && !isPackageAllowlisted(policy, did, slug)) {
		return { state: "unavailable" };
	}
	return { state: "visible", row };
}

export function throwPackageLookupError(
	result: Exclude<PackageLookupResult, { state: "visible" }>,
): never {
	if (result.state === "unavailable") {
		throw new XRPCError({
			status: 404,
			error: "ListingUnavailable",
			message: "The requested listing is unavailable under the active registry policy.",
		});
	}
	throw new XRPCError({
		status: 404,
		error: "NotFound",
		message: "No package is indexed under the requested identity.",
	});
}

export function throwReleaseUnavailable(): never {
	throw new XRPCError({
		status: 404,
		error: "ListingUnavailable",
		message: "No release is available under the active registry policy.",
	});
}

async function stagedPackageExists(
	session: D1DatabaseSession,
	did: string,
	slug: string,
): Promise<boolean> {
	const row = await session
		.prepare(
			`SELECT 1 AS hit
			 FROM packages p
			 WHERE p.did = ? AND p.slug = ? AND ${ACTIVE_PROFILE_SQL}`,
		)
		.bind(did, slug)
		.first<{ hit: number }>();
	return row !== null;
}
