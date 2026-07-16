/**
 * Read-only client over the aggregator Worker's XRPC surface, reached via
 * the `AGGREGATOR` service binding (fetch-over-binding; the aggregator is
 * HTTP/XRPC-only with no RPC entrypoint).
 *
 * Each method performs exactly one `fetch` per call with no memoization,
 * caching, or retry: internal consumers require a fresh read at call time
 * (W10.4). Callers layer their own retry/backoff if they want it.
 *
 * No `atproto-accept-labelers` header is sent — internal reads want the raw,
 * unfiltered aggregator view. Sending the header would make the aggregator
 * apply labeler policy and redact rows, which is the opposite of what the
 * labeler's own analysis needs.
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

/** NSIDs are fixed per method and never derived from caller data. Only query
 * param *values* carry caller data, and every value is `encodeURIComponent`-
 * encoded in {@link buildUrl}; the param *keys* are hard-coded literals. There
 * is therefore no path for caller data to alter the target host or path. */
const NSID = {
	getPackage: "com.emdashcms.experimental.aggregator.getPackage",
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
		if (cursor !== undefined) params["cursor"] = cursor;
		const url = buildUrl(NSID.listReleases, params);
		return this.#query<AggregatorListReleases.$output>(NSID.listReleases, url);
	}

	/** One fetch, no retry. `NotFound` → `null`; any other non-2xx or a
	 * transport failure throws. */
	async #query<T>(nsid: string, url: string): Promise<T | null> {
		const response = await this.#fetcher.fetch(url);
		if (response.ok) {
			return response.json<T>();
		}
		const body = await response.text();
		if (response.status === 404 && parseXrpcErrorName(body) === "NotFound") {
			return null;
		}
		const errorName = parseXrpcErrorName(body);
		throw new Error(
			`Aggregator ${nsid} failed: ${response.status}${errorName ? ` ${errorName}` : ""}`,
		);
	}
}
