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

import { XRPCRouter } from "@atcute/xrpc-server";
import {
	AggregatorGetLatestRelease,
	AggregatorGetPackage,
	AggregatorListReleases,
	AggregatorResolvePackage,
	AggregatorSearchPackages,
} from "@emdash-cms/registry-lexicons";

import { getLatestRelease } from "./getLatestRelease.js";
import { getPackage } from "./getPackage.js";
import { listReleases } from "./listReleases.js";
import { resolvePackage } from "./resolvePackage.js";
import { searchPackages } from "./searchPackages.js";
import { syncGetRecord } from "./sync-get-record.js";

const NO_STORE = "private, no-store";
const SYNC_GET_RECORD_PATH = "/xrpc/com.atproto.sync.getRecord";

/**
 * Dispatch any `/xrpc/*` request. Returns null when the path isn't an
 * XRPC route (caller falls through to other route matching).
 */
export async function handleXrpc(env: Env, request: Request): Promise<Response | null> {
	const url = new URL(request.url);
	if (!url.pathname.startsWith("/xrpc/")) return null;

	if (url.pathname === SYNC_GET_RECORD_PATH) {
		return syncGetRecord(env, request);
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
		handler: ({ params }) => getPackage(env, params),
	});
	router.addQuery(AggregatorListReleases.mainSchema, {
		handler: ({ params }) => listReleases(env, params),
	});
	router.addQuery(AggregatorGetLatestRelease.mainSchema, {
		handler: ({ params }) => getLatestRelease(env, params),
	});
	router.addQuery(AggregatorSearchPackages.mainSchema, {
		handler: ({ params }) => searchPackages(env, params),
	});
	router.addQuery(AggregatorResolvePackage.mainSchema, {
		handler: ({ params }) => resolvePackage(env, params),
	});
	return router;
}
