/**
 * `com.emdashcms.experimental.aggregator.getPublisherVerification` — the
 * verification state indexed for a publisher DID: the non-tombstoned
 * `publisher_verifications` claims naming it as subject, as operator/display
 * context.
 *
 * An empty `verifications` array is a valid 200 (an unverified publisher).
 * NotFound is returned only when the DID is redacted by a labeler the request
 * accepts — same redaction rule as `getPackage` applies to a publisher DID
 * subject, so an internal caller opting out with a blank
 * `atproto-accept-labelers` header always gets the view.
 *
 * The companion input in plan W8.4 slice 3 — recent handle/profile *changes* —
 * has no read here because the aggregator does not ingest a history of them:
 * `publishers` is upserted to current state only and handle changes arrive as
 * atproto identity events the ingestor does not subscribe to
 * (`jetstream-client.ts`). Exposing them is blocked on that ingestion work,
 * not on a read path.
 */

import { json, XRPCError } from "@atcute/xrpc-server";
import {
	type AggregatorDefs,
	type AggregatorGetPublisherVerification,
} from "@emdash-cms/registry-lexicons";

import { hydrateLabels, isRedacted } from "./label-enforcement.js";
import { getRequestLabelerPolicy } from "./request-policy.js";
import {
	type PublisherVerificationRow,
	publisherVerificationColumns,
	publisherVerificationView,
} from "./views.js";

/** Upper bound on claims returned in one view. A publisher with more than this
 * many verification claims is pathological; the view's lexicon `maxLength`
 * matches. */
const MAX_VERIFICATION_CLAIMS = 100;

export async function getPublisherVerification(
	env: Env,
	params: AggregatorGetPublisherVerification.$params,
	request: Request,
): Promise<Response> {
	// `first-primary` for read-after-write consistency with a takedown label
	// that could land between two reads, mirroring `getPackage`.
	const session = env.DB.withSession("first-primary");
	const result = await session
		.prepare(
			`SELECT ${publisherVerificationColumns()} FROM publisher_verifications
			 WHERE subject_did = ? AND tombstoned_at IS NULL
			 ORDER BY created_at DESC, issuer_did ASC
			 LIMIT ?`,
		)
		.bind(params.did, MAX_VERIFICATION_CLAIMS)
		.all<PublisherVerificationRow>();
	const rows = result.results ?? [];

	const { accepted } = getRequestLabelerPolicy(request);
	const labelsByUri = await hydrateLabels(session, accepted, [{ uri: params.did }], Date.now());
	const labels = labelsByUri.get(params.did) ?? [];
	if (isRedacted(labels, accepted)) {
		// Indistinguishable from absence — that is what redaction means.
		throw new XRPCError({
			status: 404,
			error: "NotFound",
			message: `No publisher indexed under ${params.did}.`,
		});
	}

	const view: AggregatorDefs.PublisherVerificationView = publisherVerificationView(
		params.did,
		rows,
		labels,
	);
	return json(view);
}
