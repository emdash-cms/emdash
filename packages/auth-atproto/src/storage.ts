/**
 * Auth provider storage accessor.
 *
 * Resolves the atproto auth provider's storage collections from the
 * EmDash runtime config. Used by route handlers to get storage for
 * the OAuth client.
 */

import type { Kysely } from "kysely";

interface AuthProviderDescriptorLike {
	id: string;
	storage?: Record<string, { indexes?: Array<string | string[]> }>;
}

interface EmdashLocals {
	db: Kysely<unknown>;
	config: { authProviders?: AuthProviderDescriptorLike[] };
}

/**
 * Get the auth provider storage collections for the atproto provider.
 * Returns null if the provider has no storage declared or is not found.
 */
export async function getAtprotoStorage(emdash: EmdashLocals) {
	const { getAuthProviderStorage } = await import("emdash/api/route-utils");
	const provider = emdash.config.authProviders?.find((p) => p.id === "atproto");
	if (!provider?.storage) return null;

	return getAuthProviderStorage(
		emdash.db as Parameters<typeof getAuthProviderStorage>[0],
		"atproto",
		provider.storage as Parameters<typeof getAuthProviderStorage>[2],
	);
}
