/**
 * `com.emdashcms.experimental.aggregator.getLatestRelease` — single-release
 * lookup that returns the highest-precedence non-tombstoned release for a
 * (did, package).
 *
 * The aggregator's writer maintains `packages.latest_version` denormalised
 * from each `releases` insert (see `refreshPackageLatestStmt` in
 * records-consumer.ts), so a single JOIN is sufficient — we don't compute
 * "latest" with an ORDER BY here. If the parent package doesn't exist, or
 * exists but has no eligible releases, returns `NotFound`.
 */

import { json, XRPCError } from "@atcute/xrpc-server";
import { type AggregatorGetLatestRelease } from "@emdash-cms/registry-lexicons";

import { type ReleaseRow, releaseColumns, releaseView } from "./views.js";

export async function getLatestRelease(
	env: Env,
	params: AggregatorGetLatestRelease.$params,
): Promise<Response> {
	const session = env.DB.withSession("first-primary");
	// Single round-trip: pull the latest_version pointer from `packages` and
	// the matching release row in one query. The tombstoned_at filter is the
	// safety net — `latest_version` is updated by the writer to skip
	// tombstones, but a race between tombstone-then-list could still hand
	// back a stale pointer.
	const row = await session
		.prepare(
			`SELECT ${releaseColumns("r.")}
			 FROM packages p
			 JOIN releases r ON r.did = p.did AND r.package = p.slug AND r.version = p.latest_version
			 WHERE p.did = ? AND p.slug = ? AND r.tombstoned_at IS NULL`,
		)
		.bind(params.did, params.package)
		.first<ReleaseRow>();

	if (!row) {
		throw new XRPCError({
			status: 404,
			error: "NotFound",
			message: `No eligible release for (${params.did}, ${params.package}).`,
		});
	}
	return json(releaseView(row));
}
