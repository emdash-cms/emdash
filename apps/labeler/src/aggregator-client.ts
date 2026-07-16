/**
 * Read-only client over the aggregator Worker's XRPC surface, reached via
 * the `AGGREGATOR` service binding (fetch-over-binding; the aggregator is
 * HTTP/XRPC-only with no RPC entrypoint).
 *
 * Each method performs exactly one `fetch` per call with no memoization,
 * caching, or retry: internal consumers require a fresh read at call time
 * (W10.4). Callers layer their own retry/backoff if they want it.
 *
 * Every request sends a BLANK `atproto-accept-labelers` header to obtain the
 * genuinely unfiltered view. Counter-intuitively, OMITTING the header does the
 * opposite: the aggregator resolves an absent header to its default policy
 * (every trusted labeler, `redact: true`), so a subject redacted by any trusted
 * labeler — plausibly including this labeler itself — presents as `NotFound`
 * and is indistinguishable from an unindexed subject. A blank value parses to
 * an empty accepted-labelers set, which the aggregator enforces as a no-op.
 * The labeler is the moderation authority performing analysis; it must not be
 * blinded to redacted subjects when resolving a takedown contact, reading
 * history context, or re-assessing a flagged subject.
 *
 * Boundary: this unfiltered view is for INTERNAL ANALYSIS ONLY. Its results
 * must never be surfaced to a public serving path without re-applying takedown
 * enforcement at that layer (see the ratified sync.getRecord / artifact-mirror
 * serving decisions) — an unfiltered read that reached a public surface would
 * re-expose taken-down content.
 *
 * Views are returned as their `@emdash-cms/registry-lexicons` types without
 * runtime validation: the aggregator is a first-party in-process binding, and
 * the acquire stage independently re-verifies artifact checksums downstream.
 *
 * Error contract: a missing subject (XRPC `NotFound`, HTTP 404) resolves to
 * `null`. Any other non-2xx status, or a transport failure, throws — callers
 * may treat a throw as transient and retry the whole read.
 */

import type { AggregatorDefs, AggregatorListReleases } from "@emdash-cms/registry-lexicons";

/**
 * XRPC endpoint host. Irrelevant to routing — a service binding dispatches by
 * binding, not DNS — but `fetch` needs a syntactically valid absolute URL.
 */
const XRPC_BASE = "https://aggregator/xrpc";

/**
 * ATProto label-negotiation header. Sent with a blank value on every read to
 * opt out of the aggregator's default trusted-labeler redaction (see the
 * module doc). Mirrors the aggregator's own local constant; this is a stable
 * protocol string, not currently exported from a shared package.
 */
const ACCEPT_LABELERS_HEADER = "atproto-accept-labelers";

/** NSIDs are fixed per method and never derived from caller data. Only query
 * param *values* carry caller data, and every value is `encodeURIComponent`-
 * encoded in {@link buildUrl}; the param *keys* are hard-coded literals. There
 * is therefore no path for caller data to alter the target host or path. */
const NSID = {
	getPackage: "com.emdashcms.experimental.aggregator.getPackage",
	getPublisher: "com.emdashcms.experimental.aggregator.getPublisher",
	getLatestRelease: "com.emdashcms.experimental.aggregator.getLatestRelease",
	listReleases: "com.emdashcms.experimental.aggregator.listReleases",
} as const;

/** Build an XRPC GET URL from a constant NSID and caller-supplied param
 * values. Keys are the caller's fixed literals; each value is URL-encoded. */
function buildUrl(nsid: string, params: Record<string, string>): string {
	const query = Object.entries(params)
		.map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
		.join("&");
	return `${XRPC_BASE}/${nsid}?${query}`;
}

/** The `error` field of an XRPC error envelope, or undefined if the body
 * isn't a recognisable `{ error }` object. */
function parseXrpcErrorName(body: string): string | undefined {
	try {
		const parsed: unknown = JSON.parse(body);
		if (parsed && typeof parsed === "object" && "error" in parsed) {
			const { error } = parsed;
			if (typeof error === "string") return error;
		}
	} catch {
		// Non-JSON error body (e.g. an infra-level 502); fall through to throw.
	}
	return undefined;
}

export class AggregatorClient {
	readonly #fetcher: Fetcher;

	constructor(fetcher: Fetcher) {
		this.#fetcher = fetcher;
	}

	/** Fetch the package view for `(did, slug)`, or `null` if not indexed. */
	async getPackage(did: string, slug: string): Promise<AggregatorDefs.PackageView | null> {
		const url = buildUrl(NSID.getPackage, { did, slug });
		return this.#query<AggregatorDefs.PackageView>(NSID.getPackage, url);
	}

	/** Fetch the publisher profile view for `did`, or `null` if not indexed. */
	async getPublisher(did: string): Promise<AggregatorDefs.PublisherView | null> {
		const url = buildUrl(NSID.getPublisher, { did });
		return this.#query<AggregatorDefs.PublisherView>(NSID.getPublisher, url);
	}

	/** Fetch the highest-precedence live release for `(did, pkg)`, or `null`
	 * if the package has no eligible release. */
	async getLatestRelease(did: string, pkg: string): Promise<AggregatorDefs.ReleaseView | null> {
		const url = buildUrl(NSID.getLatestRelease, { did, package: pkg });
		return this.#query<AggregatorDefs.ReleaseView>(NSID.getLatestRelease, url);
	}

	/** List releases for `(did, pkg)`, newest first, one page per call.
	 * Returns `null` if the parent package isn't indexed. */
	async listReleases(
		did: string,
		pkg: string,
		cursor?: string,
	): Promise<AggregatorListReleases.$output | null> {
		const params: Record<string, string> = { did, package: pkg };
		// Only a non-empty cursor is a page token; an empty string would decode as
		// a malformed cursor (the aggregator 400s), so treat it as "first page".
		if (cursor) params["cursor"] = cursor;
		const url = buildUrl(NSID.listReleases, params);
		return this.#query<AggregatorListReleases.$output>(NSID.listReleases, url);
	}

	/** One fetch, no retry. `NotFound` → `null`; any other non-2xx or a
	 * transport failure throws. */
	async #query<T>(nsid: string, url: string): Promise<T | null> {
		const response = await this.#fetcher.fetch(url, {
			headers: { [ACCEPT_LABELERS_HEADER]: "" },
		});
		if (response.ok) {
			return response.json<T>();
		}
		const body = await response.text();
		const errorName = parseXrpcErrorName(body);
		if (response.status === 404 && errorName === "NotFound") {
			return null;
		}
		throw new Error(
			`Aggregator ${nsid} failed: ${response.status}${errorName ? ` ${errorName}` : ""}`,
		);
	}
}
