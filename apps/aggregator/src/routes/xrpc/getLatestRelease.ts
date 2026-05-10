/**
 * `com.emdashcms.experimental.aggregator.getLatestRelease` — single-release
 * lookup that returns the highest-precedence non-tombstoned release for a
 * (did, package).
 *
 * The aggregator's writer maintains `packages.latest_version` denormalised
 * from each `releases` insert (see `refreshPackageLatestStmt` in
 * records-consumer.ts), so the fast path is a single JOIN. If that misses
 * — typically because `latest_version` points at a release that was
 * tombstoned after the pointer was written, and the refresh hasn't
 * propagated yet (or failed transactionally) — we fall back to the
 * authoritative ORDER BY query.
 *
 * Without the fallback, a tombstoned-but-still-pointed-at release would
 * make this endpoint return `NotFound` even though the package
 * demonstrably has other live releases (visible via `listReleases`). The
 * denormalisation is an optimisation, not a correctness gate.
 */

import { json, XRPCError } from "@atcute/xrpc-server";
import { type AggregatorGetLatestRelease } from "@emdash-cms/registry-lexicons";

import { type ReleaseRow, releaseColumns, releaseView } from "./views.js";

export async function getLatestRelease(
	env: Env,
	params: AggregatorGetLatestRelease.$params,
): Promise<Response> {
	const session = env.DB.withSession("first-primary");

	// Fast path: pull the latest_version pointer + matching release in one
	// query. The tombstoned_at filter is the integrity gate — if the
	// pointer is stale (release tombstoned, refresh pending), this misses
	// and we fall through.
	const fast = await session
		.prepare(
			`SELECT ${releaseColumns("r.")}
			 FROM packages p
			 JOIN releases r ON r.did = p.did AND r.package = p.slug AND r.version = p.latest_version
			 WHERE p.did = ? AND p.slug = ? AND r.tombstoned_at IS NULL`,
		)
		.bind(params.did, params.package)
		.first<ReleaseRow>();
	if (fast) return json(releaseView(fast));

	// Slow-path fallback: the authoritative ORDER BY. Costs an extra D1
	// round-trip on the rare miss but guarantees we don't 404 on a package
	// that has live releases. Tiebreakers (version, rkey) keep the result
	// deterministic if version_sort ties, matching listReleases' ordering.
	const slow = await session
		.prepare(
			`SELECT ${releaseColumns()}
			 FROM releases
			 WHERE did = ? AND package = ? AND tombstoned_at IS NULL
			 ORDER BY version_sort DESC, version DESC, rkey DESC
			 LIMIT 1`,
		)
		.bind(params.did, params.package)
		.first<ReleaseRow>();
	if (slow) return json(releaseView(slow));

	throw new XRPCError({
		status: 404,
		error: "NotFound",
		message: `No eligible release for (${params.did}, ${params.package}).`,
	});
}
