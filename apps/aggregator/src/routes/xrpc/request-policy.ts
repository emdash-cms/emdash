/**
 * Resolves the accepted-labelers policy for one aggregator request from the
 * `atproto-accept-labelers` request header (W4.4). `handleXrpc` resolves this
 * once per request before dispatch; handlers read the result back via
 * `getRequestLabelerPolicy`.
 */

import { InvalidRequestError } from "@atcute/xrpc-server";
import {
	InvalidAcceptLabelersHeaderError,
	parseAcceptLabelersHeader,
	serializeContentLabelersHeader,
	type AcceptedLabelerPolicy,
} from "@emdash-cms/registry-moderation";

const ACCEPT_LABELERS_HEADER = "atproto-accept-labelers";
// Keeps `IN (...)` clauses within D1's bound-parameter limit.
const AVAILABILITY_CHUNK_SIZE = 50;

export interface RequestLabelerPolicy {
	/** Effective, deduped, availability-filtered accepted labelers. */
	accepted: AcceptedLabelerPolicy[];
	/** `atproto-content-labelers` header value; "" means the header is omitted. */
	contentLabelersHeader: string;
}

function chunk<T>(items: T[], size: number): T[][] {
	const out: T[][] = [];
	for (let index = 0; index < items.length; index += size)
		out.push(items.slice(index, index + size));
	return out;
}

async function defaultAcceptedPolicy(env: Env): Promise<AcceptedLabelerPolicy[]> {
	const session = env.DB.withSession("first-primary");
	const result = await session
		.prepare(`SELECT did FROM labelers WHERE trusted = 1 ORDER BY did ASC`)
		.all<{ did: string }>();
	return (result.results ?? []).map((row) => ({ did: row.did, redact: true }));
}

/** Drops requested DIDs the deployment doesn't ingest, preserving request order. */
async function filterAvailable(
	env: Env,
	requested: AcceptedLabelerPolicy[],
): Promise<AcceptedLabelerPolicy[]> {
	if (requested.length === 0) return [];
	const session = env.DB.withSession("first-primary");
	const available = new Set<string>();
	for (const batch of chunk(
		requested.map((policy) => policy.did),
		AVAILABILITY_CHUNK_SIZE,
	)) {
		const placeholders = batch.map(() => "?").join(", ");
		const result = await session
			.prepare(`SELECT did FROM labelers WHERE did IN (${placeholders})`)
			.bind(...batch)
			.all<{ did: string }>();
		for (const row of result.results ?? []) available.add(row.did);
	}
	return requested.filter((policy) => available.has(policy.did));
}

const requestPolicies = new WeakMap<Request, RequestLabelerPolicy>();

/**
 * Resolves and stashes the request's labeler policy. Call exactly once per
 * request, before dispatching to a handler. Throws `InvalidRequestError` for
 * malformed header syntax; any other rejection (e.g. a D1 error) propagates
 * as-is so the caller 500s rather than failing open to an empty policy.
 */
export async function resolveRequestLabelerPolicy(
	env: Env,
	request: Request,
): Promise<RequestLabelerPolicy> {
	const header = request.headers.get(ACCEPT_LABELERS_HEADER);
	let accepted: AcceptedLabelerPolicy[];
	if (header === null) {
		accepted = await defaultAcceptedPolicy(env);
	} else {
		let requested: AcceptedLabelerPolicy[];
		try {
			requested = parseAcceptLabelersHeader(header);
		} catch (err) {
			if (err instanceof InvalidAcceptLabelersHeaderError) {
				throw new InvalidRequestError({
					message: `invalid ${ACCEPT_LABELERS_HEADER} header: ${err.message}`,
				});
			}
			throw err;
		}
		accepted = await filterAvailable(env, requested);
	}
	const policy: RequestLabelerPolicy = {
		accepted,
		contentLabelersHeader: serializeContentLabelersHeader(accepted),
	};
	requestPolicies.set(request, policy);
	return policy;
}

/** Reads back the policy `resolveRequestLabelerPolicy` stashed for this request. */
export function getRequestLabelerPolicy(request: Request): RequestLabelerPolicy {
	const policy = requestPolicies.get(request);
	if (!policy) {
		throw new Error("request labeler policy was not resolved before handler dispatch");
	}
	return policy;
}
