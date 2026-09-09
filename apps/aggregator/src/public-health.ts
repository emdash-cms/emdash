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
	replay_pending: number;
}

export async function publicHealth(request: Request, env: Env): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") {
		return new Response(null, { status: 405, headers: { allow: "GET, HEAD" } });
	}
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
			    WHERE state.id = 1) AS releases,
			   (SELECT COUNT(*) FROM labellers source
			    WHERE source.active = 1 AND source.replay_pending = 1
			      AND (source.required_positive = 1
			        OR source.accepted_state = 1
			        OR source.redaction = 1)) AS replay_pending`,
		)
		.bind(...(requiresProjection ? activeProjectionPolicyBindings(policy) : []))
		.first<PublicHealthRow>();
	if (!row) throw new Error("aggregator health query returned no row");

	const ready = row.ready === 1;
	const status = ready ? 200 : 503;
	const headers = { "cache-control": "no-store", "content-type": "application/json" };
	if (request.method === "HEAD") return new Response(null, { status, headers });
	return Response.json(
		{
			service: "emdash-aggregator",
			status: ready ? "ok" : "not-ready",
			policyMode: policy.mode,
			projection: {
				ready,
				packages: row.packages,
				releases: row.releases,
			},
			labelSources: {
				replayPending: row.replay_pending,
			},
		},
		{ status, headers },
	);
}
