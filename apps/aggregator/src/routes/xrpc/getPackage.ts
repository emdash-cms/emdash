/**
 * `com.emdashcms.experimental.aggregator.getPackage` — single package by
 * (did, slug). Returns the lexicon's `packageView` envelope (decoded
 * record + cid + indexedAt + labels).
 *
 * Throws `XRPCError("NotFound")` when no row matches. Tombstone is not a
 * separate state on `packages` (deletes hard-delete the row), so a NotFound
 * covers both cases — the lexicon's documented "Tombstoned" error name is
 * reserved for if/when we move to soft-delete on packages.
 */

import { json } from "@atcute/xrpc-server";
import { type AggregatorDefs, type AggregatorGetPackage } from "@emdash-cms/registry-lexicons";

import { lookupPackage, throwPackageLookupError } from "./listing-query.js";
import { packageView } from "./views.js";

export async function getPackage(
	env: Env,
	params: AggregatorGetPackage.$params,
): Promise<Response> {
	// `first-primary` because the same row could become subject to a takedown
	// label between two reads; once the labeller (Slice 2) writes, the next
	// read everywhere should reflect it. Per plan §XRPC endpoints.
	const session = env.DB.withSession("first-primary");
	const result = await lookupPackage(session, env, params.did, params.slug);
	if (result.state !== "visible") throwPackageLookupError(result);
	const view: AggregatorDefs.PackageView = packageView(result.row);
	return json(view);
}
