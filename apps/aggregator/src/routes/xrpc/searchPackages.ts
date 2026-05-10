/**
 * `com.emdashcms.experimental.aggregator.searchPackages` — FTS5 search over
 * `packages_fts` with optional capability filter.
 *
 * Pagination: offset-based (cursor encodes `{offset}`), since BM25 ranking
 * isn't stable across queries — a cursor encoding `(rank, slug)` would
 * misbehave if the corpus changed between calls. Offset is the simplest
 * stable pagination contract for ranked search; the trade is that deep
 * pagination scans more rows. At Slice 1 scale (hundreds of packages) it's
 * a non-issue.
 *
 * Takedown filter joins `label_state` even though that table is empty in
 * Slice 1 — keeps the contract honest for Slice 2 (when the labeller starts
 * writing), and the optimiser short-circuits the NOT EXISTS subquery
 * cheaply when no rows match. See plan §Search.
 *
 * `q` is passed directly to FTS5 MATCH. Special characters in user input
 * are escaped via `quoteFtsQuery` so a stray `"`/`*`/`(` doesn't blow up
 * the FTS parser. Empty query returns all packages (paginated, ordered by
 * last_updated DESC) — the lexicon's documented behaviour.
 */

import { InvalidRequestError, json } from "@atcute/xrpc-server";
import {
	type AggregatorDefs,
	NSID,
	type AggregatorSearchPackages,
} from "@emdash-cms/registry-lexicons";

import { decodeOffsetCursor, encodeOffsetCursor, InvalidCursorError } from "./cursor.js";
import { type PackageRow, packageColumns, packageView } from "./views.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;

export async function searchPackages(
	env: Env,
	params: AggregatorSearchPackages.$params,
): Promise<Response> {
	const limit = clampLimit(params.limit);
	let offset: number;
	try {
		offset = decodeOffsetCursor(params.cursor)?.offset ?? 0;
	} catch (err) {
		if (err instanceof InvalidCursorError) {
			throw new InvalidRequestError({ error: "InvalidRequest", message: err.message });
		}
		throw err;
	}
	const session = env.DB.withSession("first-primary");

	const hasQuery = typeof params.q === "string" && params.q.trim().length > 0;
	const hasCapability = typeof params.capability === "string" && params.capability.length > 0;

	let rows: PackageRow[];
	if (hasQuery) {
		const ftsQuery = quoteFtsQuery(params.q!);
		const result = await session
			.prepare(buildFtsSearchSql(hasCapability))
			.bind(
				...buildFtsBindings(
					ftsQuery,
					hasCapability ? params.capability : undefined,
					limit + 1,
					offset,
				),
			)
			.all<PackageRow>();
		rows = result.results ?? [];
	} else {
		// No query → ordered list of all packages, label-filtered. last_updated
		// DESC keeps the "what's new" view sensible for an empty search box.
		const result = await session
			.prepare(buildBrowseSql(hasCapability))
			.bind(
				...buildBrowseBindings(hasCapability ? params.capability : undefined, limit + 1, offset),
			)
			.all<PackageRow>();
		rows = result.results ?? [];
	}

	const hasMore = rows.length > limit;
	const page = hasMore ? rows.slice(0, limit) : rows;

	const response: {
		packages: AggregatorDefs.PackageView[];
		cursor?: string;
	} = {
		packages: page.map(packageView),
	};
	if (hasMore) response.cursor = encodeOffsetCursor({ offset: offset + limit });
	return json(response);
}

function buildFtsSearchSql(hasCapability: boolean): string {
	return `
		SELECT ${packageColumns("p.")}
		FROM packages_fts
		JOIN packages p ON p.rowid = packages_fts.rowid
		WHERE packages_fts MATCH ?
		${ENFORCEMENT_FILTER_SQL}
		${hasCapability ? CAPABILITY_FILTER_SQL : ""}
		ORDER BY bm25(packages_fts), p.last_updated DESC, p.did ASC, p.slug ASC
		LIMIT ? OFFSET ?
	`;
}

function buildFtsBindings(
	ftsQuery: string,
	capability: string | undefined,
	limit: number,
	offset: number,
): unknown[] {
	const out: unknown[] = [ftsQuery];
	if (capability !== undefined) out.push(capability);
	out.push(limit, offset);
	return out;
}

function buildBrowseSql(hasCapability: boolean): string {
	// Stable tiebreakers (did, slug) so offset pagination doesn't shuffle
	// rows across pages when many packages share `last_updated` (or it's
	// NULL — `last_updated` comes from the optional record.lastUpdated
	// field). NULLS LAST keeps NULL `last_updated` rows out of the way
	// of the freshness sort but still reachable via pagination.
	return `
		SELECT ${packageColumns("p.")}
		FROM packages p
		WHERE 1=1
		${ENFORCEMENT_FILTER_SQL}
		${hasCapability ? CAPABILITY_FILTER_SQL : ""}
		ORDER BY p.last_updated IS NULL, p.last_updated DESC, p.did ASC, p.slug ASC
		LIMIT ? OFFSET ?
	`;
}

function buildBrowseBindings(
	capability: string | undefined,
	limit: number,
	offset: number,
): unknown[] {
	const out: unknown[] = [];
	if (capability !== undefined) out.push(capability);
	out.push(limit, offset);
	return out;
}

/** Hard-enforcement label filter. The Slice 2 labeller writes to
 * `label_state`; until then the table is empty so this clause is a no-op
 * (the NOT EXISTS short-circuits). The plan calls for shipping the filter
 * now to lock the contract — adding it later would be a behaviour change
 * for cached clients. */
const ENFORCEMENT_FILTER_SQL = `
	AND NOT EXISTS (
		SELECT 1 FROM label_state ls
		WHERE ls.uri = 'at://' || p.did || '/${NSID.packageProfile}/' || p.slug
		  AND ls.val IN ('!takedown', 'security:yanked')
		  AND ls.trusted = 1
		  AND ls.neg = 0
		  AND (ls.exp IS NULL OR ls.exp > strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
	)
`;

const CAPABILITY_FILTER_SQL = `
	AND p.capabilities IS NOT NULL
	AND EXISTS (SELECT 1 FROM json_each(p.capabilities) WHERE value = ?)
`;

/** Quote a user-supplied search string for FTS5 MATCH. FTS5 treats `"`,
 * `*`, `(`, `)`, `.`, `:`, `^`, `+`, `-` as syntax. The simplest robust
 * escape is to wrap the whole query as a single phrase string and double
 * any embedded quotes. This loses prefix-search functionality
 * (`"foo*"` is treated literally) but is safe and sufficient for v1; if
 * advanced query syntax becomes a product feature we'll layer a parsed
 * mode on top. */
const FTS_QUOTE_RE = /"/g;
function quoteFtsQuery(raw: string): string {
	return `"${raw.replace(FTS_QUOTE_RE, '""')}"`;
}

function clampLimit(raw: number | undefined): number {
	if (raw === undefined) return DEFAULT_LIMIT;
	if (raw < 1) return 1;
	if (raw > MAX_LIMIT) return MAX_LIMIT;
	return raw;
}
