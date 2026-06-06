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

import {
	CompositeHandleResolver,
	DohJsonHandleResolver,
	WellKnownHandleResolver,
} from "@atcute/identity-resolver";
import { json, XRPCError } from "@atcute/xrpc-server";
import { type AggregatorResolvePackage } from "@emdash-cms/registry-lexicons";

import { boundFetch } from "../../utils.js";
import { type PackageRow, packageColumns, packageView } from "./views.js";

/** Cache the resolver per worker isolate. Construction is allocation-only
 * (no I/O), but reusing a single instance avoids per-request setup. */
let cachedResolver: CompositeHandleResolver | null = null;
function getHandleResolver(): CompositeHandleResolver {
	if (!cachedResolver) {
		cachedResolver = new CompositeHandleResolver({
			strategy: "race",
			methods: {
				dns: new DohJsonHandleResolver({
					dohUrl: "https://mozilla.cloudflare-dns.com/dns-query",
					fetch: boundFetch,
				}),
				http: new WellKnownHandleResolver({ fetch: boundFetch }),
			},
		});
	}
	return cachedResolver;
}

export async function resolvePackage(
	env: Env,
	params: AggregatorResolvePackage.$params,
): Promise<Response> {
	let did: string;
	try {
		// Lexicon validates `handle` format upstream so `params.handle` is
		// already typed `${string}.${string}`, which structurally satisfies
		// the resolver's `Handle` parameter — no cast needed.
		did = await getHandleResolver().resolve(params.handle);
	} catch (err) {
		throw new XRPCError({
			status: 404,
			error: "HandleNotFound",
			message: `Could not resolve handle '${params.handle}': ${err instanceof Error ? err.message : String(err)}`,
		});
	}

	const session = env.DB.withSession("first-primary");
	const row = await session
		.prepare(`SELECT ${packageColumns()} FROM packages WHERE did = ? AND slug = ?`)
		.bind(did, params.slug)
		.first<PackageRow>();
	if (!row) {
		throw new XRPCError({
			status: 404,
			error: "NotFound",
			message: `No package indexed under resolved (${did}, ${params.slug}).`,
		});
	}
	const view = packageView(row);
	// Surface the handle we resolved — the lexicon's view has an optional
	// `handle` field for exactly this case (best-effort current handle).
	view.handle = params.handle;
	return json(view);
}
