/**
 * `com.emdashcms.experimental.aggregator.listReleases` — releases for a
 * (did, package), descending semver. Cursor pagination over
 * `(version_sort, version)` so tied semver-precedence cases (shouldn't
 * happen in practice but defensive) still page deterministically.
 *
 * Returns `NotFound` when the parent package isn't indexed, even if a
 * (orphaned) release row exists — the lexicon's contract is "list
 * releases of a known package", not "list any release rows for this
 * (did, package)".
 */

import { InvalidRequestError, json, XRPCError } from "@atcute/xrpc-server";
import { type AggregatorDefs, type AggregatorListReleases } from "@emdash-cms/registry-lexicons";

import { decodeListCursor, encodeListCursor, InvalidCursorError } from "./cursor.js";
import { type ReleaseRow, releaseColumns, releaseView } from "./views.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function listReleases(
	env: Env,
	params: AggregatorListReleases.$params,
): Promise<Response> {
	const limit = clampLimit(params.limit);
	const session = env.DB.withSession("first-primary");

	// Confirm parent package exists. One extra D1 read per request — could be
	// folded into a JOIN, but the explicit existence check keeps the NotFound
	// signal cheap and unambiguous (the empty-list response shape would
	// otherwise mean "package exists, no releases" or "package doesn't exist"
	// indistinguishably).
	const parentExists = await session
		.prepare(`SELECT 1 AS hit FROM packages WHERE did = ? AND slug = ?`)
		.bind(params.did, params.package)
		.first<{ hit: number }>();
	if (!parentExists) {
		throw new XRPCError({
			status: 404,
			error: "NotFound",
			message: `No package indexed under (${params.did}, ${params.package}).`,
		});
	}

	// Cursor encodes the LAST seen (version_sort, version) on the previous
	// page so the next page picks up below it in DESC order. `WHERE`
	// half-tuple inequality so SQLite's index on (did, package, version_sort
	// DESC) stays useful. A *provided* cursor that fails to decode 400s
	// (would otherwise loop the client through page 1 forever).
	let cursor: ReturnType<typeof decodeListCursor>;
	try {
		cursor = decodeListCursor(params.cursor);
	} catch (err) {
		if (err instanceof InvalidCursorError) {
			throw new InvalidRequestError({ error: "InvalidRequest", message: err.message });
		}
		throw err;
	}
	const rows = await session
		.prepare(
			`SELECT ${releaseColumns()}, version_sort
			 FROM releases
			 WHERE did = ? AND package = ? AND tombstoned_at IS NULL
			 ${cursor ? "AND (version_sort < ? OR (version_sort = ? AND version < ?))" : ""}
			 ORDER BY version_sort DESC, version DESC
			 LIMIT ?`,
		)
		.bind(
			...(cursor
				? [
						params.did,
						params.package,
						cursor.versionSort,
						cursor.versionSort,
						cursor.version,
						limit + 1,
					]
				: [params.did, params.package, limit + 1]),
		)
		.all<ReleaseRow & { version_sort: string }>();

	const items = rows.results ?? [];
	// Read limit+1 to detect a next page without a trailing COUNT query.
	const hasMore = items.length > limit;
	const page = hasMore ? items.slice(0, limit) : items;
	const last = page.at(-1);

	const response: {
		releases: AggregatorDefs.ReleaseView[];
		cursor?: string;
	} = {
		releases: page.map(releaseView),
	};
	if (hasMore && last) {
		// Cursor encodes the internal `version_sort` format. If the
		// `computeVersionSort` encoding ever changes, in-flight cursors
		// will be cursor-incompatible across the deploy — clients will
		// 400 (per the strict-cursor policy) and fall back to fetching
		// page 1. Acceptable for the experimental NSID; revisit if/when
		// we stabilise.
		response.cursor = encodeListCursor({ versionSort: last.version_sort, version: last.version });
	}
	return json(response);
}

function clampLimit(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_LIMIT;
	if (raw < 1) return 1;
	if (raw > MAX_LIMIT) return MAX_LIMIT;
	return raw;
}
