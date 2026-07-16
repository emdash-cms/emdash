/**
 * `com.emdashcms.experimental.aggregator.getPublisherVerification` — the
 * verification state indexed for a publisher DID: the non-tombstoned
 * `publisher_verifications` claims naming it as subject, as operator/display
 * context.
 *
 * Redaction runs at two scopes, because a claim is authored by its ISSUER's
 * repo, not the subject's:
 *   - the subject DID gates the whole view (redacted → NotFound), the same rule
 *     `getPackage` applies to a publisher subject;
 *   - each claim's issuer DID gates only that claim (redacted issuer → the claim
 *     is dropped from `verifications`), so one taken-down issuer can't hide a
 *     publisher's other, still-valid claims.
 * An internal caller opting out with a blank `atproto-accept-labelers` header
 * has an empty accepted set, so nothing is redacted — it reads every claim,
 * including redacted-issuer ones, and weighs trust itself.
 *
 * An empty `verifications` array is a valid 200 (an unverified publisher, or one
 * whose every claim's issuer is redacted for this caller) — a NON-redacted
 * subject is never a 404, so 404 (redacted subject) is distinguishable from an
 * empty result, unlike `getPackage` where absence is also a 404.
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
	// One batched hydration for the subject DID plus every distinct issuer DID
	// in the result. `hydrateLabels` chunks its `uri IN (...)` at 50, so this
	// stays a single query unless a publisher has 50+ distinct issuers.
	const issuerDids = [...new Set(rows.map((row) => row.issuer_did))];
	const subjects = [params.did, ...issuerDids].map((uri) => ({ uri }));
	const labelsByUri = await hydrateLabels(session, accepted, subjects, Date.now());

	const subjectLabels = labelsByUri.get(params.did) ?? [];
	if (isRedacted(subjectLabels, accepted)) {
		// A redacted publisher DID hides the whole view — the caller can't tell it
		// apart from an empty result, which is the point of redaction.
		throw new XRPCError({
			status: 404,
			error: "NotFound",
			message: `No publisher indexed under ${params.did}.`,
		});
	}

	const visibleRows = rows.filter(
		(row) => !isRedacted(labelsByUri.get(row.issuer_did) ?? [], accepted),
	);

	const view: AggregatorDefs.PublisherVerificationView = publisherVerificationView(
		params.did,
		visibleRows,
		subjectLabels,
	);
	return json(view);
}
