/**
 * XRPC dispatcher for the aggregator's read API.
 *
 * Aggregator endpoints (`com.emdashcms.experimental.aggregator.*`) flow
 * through `@atcute/xrpc-server`'s typed router — handlers receive
 * lexicon-validated `params` and return `JSONResponse<…>` typed against
 * the lexicon's output schema. The router handles 400 (bad params),
 * 404 (no handler), and 500 (unexpected throw) automatically; handlers
 * throw `XRPCError` for typed application errors (`NotFound`, etc.).
 *
 * `com.atproto.sync.getRecord` is intercepted *before* the router because
 * we don't have a generated lexicon binding for atproto's own NSIDs and
 * the response is `application/vnd.ipld.car` not JSON. See
 * `sync-get-record.ts`.
 *
 * Caching headers:
 *   - All aggregator endpoints: `private, no-store` (label-state can change
 *     at any time and Cloudflare's Cache API is colo-local — see plan
 *     §Caching).
 *   - `sync.getRecord`: `public, max-age=300` set on the response itself
 *     (immutable bytes).
 */

import { InternalServerError, XRPCError, XRPCRouter } from "@atcute/xrpc-server";
import {
	AggregatorGetLatestRelease,
	AggregatorGetPackage,
	AggregatorGetPublisher,
	AggregatorGetPublisherVerification,
	AggregatorListReleases,
	AggregatorResolvePackage,
	AggregatorSearchPackages,
} from "@emdash-cms/registry-lexicons";

import { getLatestRelease } from "./getLatestRelease.js";
import { getPackage } from "./getPackage.js";
import { getPublisher } from "./getPublisher.js";
import { getPublisherVerification } from "./getPublisherVerification.js";
import { listReleases } from "./listReleases.js";
import { resolveRequestLabelerPolicy } from "./request-policy.js";
import { resolvePackage } from "./resolvePackage.js";
import { searchPackages } from "./searchPackages.js";
import { syncGetRecord } from "./sync-get-record.js";

const NO_STORE = "private, no-store";
const SYNC_GET_RECORD_PATH = "/xrpc/com.atproto.sync.getRecord";

/**
 * CORS for the aggregator's XRPC surface.
 *
 * The aggregator is a public read-only service: admin UIs running on
 * arbitrary EmDash sites call it directly from the browser. The atproto
 * spec doesn't standardize CORS for XRPC services, but browser clients
 * need `Access-Control-Allow-Origin` to access the JSON responses.
 *
 * `*` is correct here because nothing in our responses depends on the
 * caller's origin or credentials -- there are no cookies, no auth, no
 * per-origin policy. We allow `atproto-accept-labelers` and
 * `content-type` as request headers (the only two clients send), expose
 * the response headers a labeler-aware client needs to read
 * (`atproto-content-labelers`, `content-language`), and cap preflight
 * cache at 24h.
 */
const CORS_HEADERS: Record<string, string> = {
	"access-control-allow-origin": "*",
	"access-control-allow-methods": "GET, POST, OPTIONS",
	"access-control-allow-headers": "content-type, atproto-accept-labelers",
	"access-control-expose-headers": "atproto-content-labelers, content-language",
	"access-control-max-age": "86400",
};

function applyCorsHeaders(headers: Headers): void {
	for (const [name, value] of Object.entries(CORS_HEADERS)) {
		headers.set(name, value);
	}
}

/**
 * Generic 500 for an unexpected failure (e.g. a D1 error). Logs the internal
 * error under `context` for operators but returns the router's own opaque
 * envelope, so no internal detail (SQL text, stack) reaches the client.
 * Matches the body the router itself produces for a handler throw.
 */
function internalErrorResponse(err: unknown, context: string): Response {
	console.error(`[aggregator] xrpc ${context} failed`, {
		error: err instanceof Error ? (err.stack ?? err.message) : String(err),
	});
	return new InternalServerError({
		message: "an exception happened whilst processing this request",
	}).toResponse();
}

/**
 * Wrap an unexpected dispatch failure as an error Response carrying CORS +
 * `no-store`. An unwrapped throw escapes to workerd's bare 500, dropping both
 * — and on the cacheable `sync.getRecord` path it would leave a takedown-
 * relevant error under a public cache header. `XRPCError` keeps its typed
 * envelope (e.g. a malformed accept-labelers header); anything else is opaque.
 */
function wrapDispatchError(err: unknown, context: string): Response {
	const errorResponse =
		err instanceof XRPCError ? err.toResponse() : internalErrorResponse(err, context);
	const headers = new Headers(errorResponse.headers);
	headers.set("cache-control", NO_STORE);
	applyCorsHeaders(headers);
	return new Response(errorResponse.body, { status: errorResponse.status, headers });
}

/**
 * Dispatch any `/xrpc/*` request. Returns null when the path isn't an
 * XRPC route (caller falls through to other route matching).
 */
export async function handleXrpc(env: Env, request: Request): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/xrpc/")) return null;

	// CORS preflight. Browsers send OPTIONS before any cross-origin XRPC
	// call; we answer with the same allow-list as the actual response
	// so the real request goes through.
	if (request.method === "OPTIONS") {
		const headers = new Headers();
		applyCorsHeaders(headers);
		return new Response(null, { status: 204, headers });
	}

	if (url.pathname === SYNC_GET_RECORD_PATH) {
		let response: Response;
		try {
			response = await syncGetRecord(env, request);
		} catch (err) {
			return wrapDispatchError(err, "sync.getRecord");
		}
		const headers = new Headers(response.headers);
		applyCorsHeaders(headers);
		return new Response(response.body, {
			status: response.status,
			statusText: response.statusText,
			headers,
		});
	}

	// Resolve the accepted-labelers policy once, before dispatch, so every
	// handler sees the same policy the response's `atproto-content-labelers`
	// header reports below. A malformed header 400s in the same envelope
	// shape the router itself produces for InvalidRequest; any other failure
	// (e.g. a D1 error) is wrapped as a 500 below so the caller fails closed
	// rather than the request silently falling open to an empty policy.
	let policy: Awaited<ReturnType<typeof resolveRequestLabelerPolicy>>;
	try {
		policy = await resolveRequestLabelerPolicy(env, request);
	} catch (err) {
		return wrapDispatchError(err, "policy resolution");
	}

	const router = getRouter(env);
	const response = await router.fetch(request);
	// Override Cache-Control unconditionally on aggregator endpoints — the
	// takedown story requires `no-store` regardless of which endpoint
	// responded, and it's deliberately not per-handler-overridable (a
	// future endpoint that wants public caching has to be intercepted
	// before the router, like sync.getRecord, where the cache contract
	// can be reasoned about end-to-end). Cloning so we don't mutate a
	// frozen Response from `json()`.
	const headers = new Headers(response.headers);
	headers.set("cache-control", NO_STORE);
	applyCorsHeaders(headers);
	if (policy.contentLabelersHeader !== "") {
		headers.set("atproto-content-labelers", policy.contentLabelersHeader);
	}
	return new Response(response.body, {
		status: response.status,
		statusText: response.statusText,
		headers,
	});
}

/** Cache the router per worker isolate. Construction registers handler
 * closures that capture `env`; env is stable across requests within an
 * isolate so single-instance is fine. */
let cachedRouter: XRPCRouter | null = null;
let cachedEnvRef: Env | null = null;
function getRouter(env: Env): XRPCRouter {
	// If somehow re-invoked with a different env reference (shouldn't happen
	// in workerd but cheap to guard), rebuild — better than serving stale
	// closures pointing at a swapped-out env.
	if (cachedRouter && cachedEnvRef === env) return cachedRouter;
	cachedRouter = createRouter(env);
	cachedEnvRef = env;
	return cachedRouter;
}

function createRouter(env: Env): XRPCRouter {
	const router = new XRPCRouter();
	router.addQuery(AggregatorGetPackage.mainSchema, {
		handler: ({ params, request }) => getPackage(env, params, request),
	});
	router.addQuery(AggregatorListReleases.mainSchema, {
		handler: ({ params, request }) => listReleases(env, params, request),
	});
	router.addQuery(AggregatorGetLatestRelease.mainSchema, {
		handler: ({ params, request }) => getLatestRelease(env, params, request),
	});
	router.addQuery(AggregatorSearchPackages.mainSchema, {
		handler: ({ params, request }) => searchPackages(env, params, request),
	});
	router.addQuery(AggregatorResolvePackage.mainSchema, {
		handler: ({ params, request }) => resolvePackage(env, params, request),
	});
	router.addQuery(AggregatorGetPublisher.mainSchema, {
		handler: ({ params, request }) => getPublisher(env, params, request),
	});
	router.addQuery(AggregatorGetPublisherVerification.mainSchema, {
		handler: ({ params, request }) => getPublisherVerification(env, params, request),
	});
	return router;
}
