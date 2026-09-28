import {
	ACTIVE_PROJECTION_JOINS_SQL,
	ACTIVE_PROJECTION_POLICY_SQL,
	activeProjectionPolicyBindings,
	getListingPolicy,
} from "./listing-policy.js";

interface PublicHealthRow {
	ready: number;
	packages: number;
	releases: number;
}

interface PublicHealthSnapshot {
	status: number;
	body: {
		service: "emdash-aggregator";
		status: "ok" | "not-ready";
		policyMode: "open" | "allowlist" | "projection";
		projection: {
			ready: boolean;
			packages: number;
			releases: number;
		};
	};
}

interface CachedPublicHealth {
	expiresAt: number;
	value: Promise<PublicHealthSnapshot>;
}

const PUBLIC_HEALTH_CACHE_TTL_MS = 5_000;
const PUBLIC_HEALTH_CACHE_KEY = Symbol.for("emdash:aggregator:public-health-cache");
const globals = globalThis as Record<symbol, unknown>;
const publicHealthCache: WeakMap<object, CachedPublicHealth> =
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- shared across duplicated Worker chunks
	(globals[PUBLIC_HEALTH_CACHE_KEY] as WeakMap<object, CachedPublicHealth> | undefined) ??
	(() => {
		const cache = new WeakMap<object, CachedPublicHealth>();
		globals[PUBLIC_HEALTH_CACHE_KEY] = cache;
		return cache;
	})();

export async function publicHealth(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
	}
	const snapshot = await cachedPublicHealth(env);
	const headers = { "cache-control": "no-store", "content-type": "application/json" };
	if (request.method === "HEAD") return new Response(null, { status: snapshot.status, headers });
	return Response.json(snapshot.body, { status: snapshot.status, headers });
}

function cachedPublicHealth(env: Env): Promise<PublicHealthSnapshot> {
	const now = Date.now();
	const cached = publicHealthCache.get(env);
	if (cached && cached.expiresAt > now) return cached.value;
	const value = readPublicHealth(env).catch((error: unknown) => {
		if (publicHealthCache.get(env)?.value === value) publicHealthCache.delete(env);
		throw error;
	});
	publicHealthCache.set(env, { expiresAt: now + PUBLIC_HEALTH_CACHE_TTL_MS, value });
	return value;
}

async function readPublicHealth(env: Env): Promise<PublicHealthSnapshot> {
	const policy = await getListingPolicy(env);
	const requiresProjection = policy.mode === "projection";
	const readinessSql = requiresProjection
		? `EXISTS (
			SELECT 1 FROM public_projection_state projection_state
			${ACTIVE_PROJECTION_JOINS_SQL}
			WHERE projection_state.id = 1 AND ${ACTIVE_PROJECTION_POLICY_SQL}
		)`
		: "1";
	const row = await env.DB.withSession("first-primary")
		.prepare(
			`SELECT
			   ${readinessSql} AS ready,
			   (SELECT COUNT(*) FROM public_packages package
			    JOIN public_projection_state state
			      ON state.active_generation = package.generation
			    WHERE state.id = 1) AS packages,
			   (SELECT COUNT(*) FROM public_releases release
			    JOIN public_projection_state state
			      ON state.active_generation = release.generation
			    WHERE state.id = 1) AS releases`,
		)
		.bind(...(requiresProjection ? activeProjectionPolicyBindings(policy) : []))
		.first<PublicHealthRow>();
	if (!row) throw new Error("aggregator health query returned no row");

	const ready = row.ready === 1;
	const status = ready ? 200 : 503;
	return {
		status,
		body: {
			service: "emdash-aggregator",
			status: ready ? "ok" : "not-ready",
			policyMode: policy.mode,
			projection: {
				ready,
				packages: row.packages,
				releases: row.releases,
			},
		},
	};
}
