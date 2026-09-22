/**
 * `com.emdashcms.experimental.aggregator.resolvePackage` — handle/slug →
 * package view. Convenience wrapper that:
 *
 *   1. Resolves the handle to a DID via the publisher's DID document.
 *   2. Looks up the package by (resolved DID, slug).
 *
 * Throws `HandleNotFound` when handle resolution fails (publisher's
 * `_atproto` TXT record / `.well-known/atproto-did` file missing or
 * mismatched). Throws `NotFound` when handle resolves but no package is
 * indexed under (did, slug).
 *
 * Resolution path: bidirectional handle resolution per atproto spec
 * (`@atcute/identity-resolver`'s `HandleResolver`). We deliberately don't
 * cache the handle→DID mapping at the aggregator: handles are mutable and
 * resolvable on every request keeps the contract honest. If/when this
 * becomes a hot path, add a short-TTL cache here keyed by handle.
 */

import type { Did, Handle } from "@atcute/lexicons/syntax";
import { json, XRPCError } from "@atcute/xrpc-server";
import { type AggregatorResolvePackage } from "@emdash-cms/registry-lexicons";

import { createProductionDidResolver, upsertPublisherHandle } from "../../did-resolver.js";
import { lookupPackage, throwPackageLookupError } from "./listing-query.js";
import { packageView } from "./views.js";

export async function resolvePackage(
	env: Env,
	params: AggregatorResolvePackage.$params,
): Promise<Response> {
	let identity: { did: Did; handle?: Handle; identityCacheHit?: boolean };
	try {
		identity = await createProductionDidResolver(env).resolveIdentifier(params.handle);
	} catch (err) {
		throw new XRPCError({
			status: 404,
			error: "HandleNotFound",
			message: `Could not resolve handle '${params.handle}': ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	const session = env.DB.withSession("first-primary");
	const result = await lookupPackage(session, env, identity.did, params.slug);
	if (result.state !== "visible") throwPackageLookupError(result);
	const view = packageView(result.row);
	if (identity.handle) {
		if (!identity.identityCacheHit) {
			await upsertPublisherHandle(env.DB, identity.did, identity.handle);
		}
		view.handle = identity.handle;
	}
	return json(view);
}
