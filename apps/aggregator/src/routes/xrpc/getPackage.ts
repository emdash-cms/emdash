/**
 * `com.emdashcms.experimental.aggregator.getPackage` — single package by
 * (did, slug). Returns the lexicon's `packageView` envelope (decoded
 * record + cid + indexedAt + empty mirrors/labels).
 *
 * Throws `XRPCError("NotFound")` when no row matches. Tombstone is not a
 * separate state on `packages` (deletes hard-delete the row), so a NotFound
 * covers both cases — the lexicon's documented "Tombstoned" error name is
 * reserved for if/when we move to soft-delete on packages.
 */

import { json, XRPCError } from "@atcute/xrpc-server";
import { type AggregatorDefs, type AggregatorGetPackage } from "@emdash-cms/registry-lexicons";

import { parseSignatureMetadataCid } from "../../utils.js";
import { hydrateLabels, isRedacted } from "./label-enforcement.js";
import { getRequestLabelerPolicy } from "./request-policy.js";
import { type PackageRow, packageColumns, packageUri, packageView } from "./views.js";

export async function getPackage(
	env: Env,
	params: AggregatorGetPackage.$params,
	request: Request,
): Promise<Response> {
	// `first-primary` because the same row could become subject to a takedown
	// label between two reads; once the labeler (Slice 2) writes, the next
	// read everywhere should reflect it. Per plan §XRPC endpoints.
	const session = env.DB.withSession("first-primary");
	const row = await session
		.prepare(`SELECT ${packageColumns()} FROM packages WHERE did = ? AND slug = ?`)
		.bind(params.did, params.slug)
		.first<PackageRow>();
	if (!row) {
		throw new XRPCError({
			status: 404,
			error: "NotFound",
			message: `No package indexed under (${params.did}, ${params.slug}).`,
		});
	}

	const { accepted } = getRequestLabelerPolicy(request);
	const uri = packageUri(row);
	const labelsByUri = await hydrateLabels(
		session,
		accepted,
		[
			{ uri, currentCid: parseSignatureMetadataCid(row.signature_metadata) ?? undefined },
			{ uri: row.did },
		],
		Date.now(),
	);
	const labels = [...(labelsByUri.get(uri) ?? []), ...(labelsByUri.get(row.did) ?? [])];
	if (isRedacted(labels, accepted)) {
		// Indistinguishable from absence — that is what redaction means.
		throw new XRPCError({
			status: 404,
			error: "NotFound",
			message: `No package indexed under (${params.did}, ${params.slug}).`,
		});
	}

	const view: AggregatorDefs.PackageView = packageView(row, labels);
	return json(view);
}
