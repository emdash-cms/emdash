import {
	ACTIVE_PUBLIC_PACKAGE_SQL,
	ACTIVE_PUBLIC_RELEASE_SQL,
	activePublicSubjectBindings,
	getListingPolicy,
	type ListingPolicyConfig,
} from "./listing-policy.js";

export async function enforceConfiguredProjection(env: Env): Promise<void> {
	const policy = await getListingPolicy(env);
	if (policy.mode !== "projection" || !policy.moderationPolicy) return;
	await enforcePublicProjectionPolicy(env.DB, policy);
}

export async function enforcePublicProjectionPolicy(
	db: D1Database,
	policy: ListingPolicyConfig,
): Promise<void> {
	if (policy.mode !== "projection" || !policy.moderationPolicy) return;
	const subjectBindings = activePublicSubjectBindings(policy);
	await db.batch([
		db
			.prepare(
				`DELETE FROM public_releases AS r
				 WHERE EXISTS (
				   SELECT 1 FROM public_packages p
				   WHERE p.generation = r.generation
				     AND p.did = r.did
				     AND p.slug = r.package
				     AND NOT (${ACTIVE_PUBLIC_RELEASE_SQL})
				 )`,
			)
			.bind(...subjectBindings),
		db.prepare(REFRESH_PUBLIC_PACKAGES_SQL),
		db
			.prepare(`DELETE FROM public_packages AS p WHERE NOT (${ACTIVE_PUBLIC_PACKAGE_SQL})`)
			.bind(...subjectBindings),
	]);
}

const REFRESH_PUBLIC_PACKAGES_SQL = `
	UPDATE public_packages SET
		latest_version = (
			SELECT version FROM public_releases
			WHERE generation = public_packages.generation
			  AND did = public_packages.did
			  AND package = public_packages.slug
			ORDER BY version_sort DESC, version DESC, rkey DESC LIMIT 1
		),
		capabilities = (
			SELECT json_group_array(key) FROM (
				SELECT key FROM json_each(
					(SELECT json_extract(emdash_extension, '$.declaredAccess')
					 FROM public_releases
					 WHERE generation = public_packages.generation
					   AND did = public_packages.did
					   AND package = public_packages.slug
					 ORDER BY version_sort DESC, version DESC, rkey DESC LIMIT 1)
				) ORDER BY key
			)
		)
	WHERE latest_version IS NOT NULL
		AND NOT EXISTS (
			SELECT 1 FROM public_releases
			WHERE generation = public_packages.generation
				AND did = public_packages.did
				AND package = public_packages.slug
				AND version = public_packages.latest_version
		)
`;
