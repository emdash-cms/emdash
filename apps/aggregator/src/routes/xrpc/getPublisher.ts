/**
 * `com.emdashcms.experimental.aggregator.getPublisher` — single publisher
 * profile by DID. Returns the lexicon's `publisherView` envelope (decoded
 * record + cid + indexedAt + empty labels unless hydrated).
 *
 * Throws `XRPCError("NotFound")` when no row matches. Publisher deletes
 * hard-delete the `publishers` row, so a NotFound covers both the
 * never-indexed and the deleted cases — clients treat them equivalently.
 */

import { json, XRPCError } from "@atcute/xrpc-server";
import { type AggregatorDefs, type AggregatorGetPublisher } from "@emdash-cms/registry-lexicons";

import { parseSignatureMetadataCid } from "../../utils.js";
import { hydrateLabels, isRedacted } from "./label-enforcement.js";
import { getRequestLabelerPolicy } from "./request-policy.js";
import { type PublisherRow, publisherColumns, publisherUri, publisherView } from "./views.js";

export async function getPublisher(
	env: Env,
	params: AggregatorGetPublisher.$params,
	request: Request,
): Promise<Response> {
	// `first-primary` for the same reason as getPackage: a label written by
	// the labeler between two reads should be reflected on the next read.
	const session = env.DB.withSession("first-primary");
	const row = await session
		.prepare(`SELECT ${publisherColumns()} FROM publishers WHERE did = ?`)
		.bind(params.did)
		.first<PublisherRow>();
	if (!row) {
		throw new XRPCError({
			status: 404,
			error: "NotFound",
			message: `No publisher indexed under ${params.did}.`,
		});
	}

	const { accepted } = getRequestLabelerPolicy(request);
	const uri = publisherUri(row);
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
			message: `No publisher indexed under ${params.did}.`,
		});
	}

	const view: AggregatorDefs.PublisherView = publisherView(row, labels);
	return json(view);
}
