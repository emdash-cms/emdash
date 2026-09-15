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
 * A query that is exactly a handle, DID, or either identity plus `/slug`
 * resolves the publisher first and queries by stable DID. Other queries use
 * FTS5 with defensive quoting. Empty queries return all visible packages.
 */

import { isDid, isHandle } from "@atcute/lexicons/syntax";
import { InvalidRequestError, json } from "@atcute/xrpc-server";
import { type AggregatorDefs, type AggregatorSearchPackages } from "@emdash-cms/registry-lexicons";

import { createProductionDidResolver, upsertPublisherHandle } from "../../did-resolver.js";
import {
	ACTIVE_PROJECTION_JOINS_SQL,
	ACTIVE_PROJECTION_POLICY_SQL,
	ACTIVE_PROFILE_REDACTION_SQL,
	ACTIVE_PROFILE_SQL,
	ACTIVE_PUBLIC_PACKAGE_SQL,
	ALLOWLIST_PROFILE_SQL,
	activeProjectionPolicyBindings,
	activePublicSubjectBindings,
	getListingPolicy,
	type ListingPolicyConfig,
} from "../../listing-policy.js";
import { decodeOffsetCursor, encodeOffsetCursor, InvalidCursorError } from "./cursor.js";
import { type PackageRow, packageColumns, packageView } from "./views.js";

const DEFAULT_LIMIT = 25;
const MAX_LIMIT = 100;
const PACKAGE_SLUG_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/i;
const LEADING_AT_PATTERN = /^@/;

export interface SearchPackagesDeps {
	resolvePublisher(identifier: string): Promise<{
		did: `did:${string}:${string}`;
		handle?: `${string}.${string}`;
		identityCacheHit?: boolean;
	}>;
}

export async function searchPackages(
	env: Env,
	params: AggregatorSearchPackages.$params,
	deps: SearchPackagesDeps = productionSearchDeps(env),
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
	const policy = await getListingPolicy(env);

	const hasQuery = typeof params.q === "string" && params.q.trim().length > 0;
	const hasCapability = typeof params.capability === "string" && params.capability.length > 0;
	const publisherQuery = hasQuery ? parsePublisherQuery(params.q!) : null;

	let rows: PackageRow[];
	if (publisherQuery) {
		let identity: Awaited<ReturnType<SearchPackagesDeps["resolvePublisher"]>>;
		try {
			identity = await deps.resolvePublisher(publisherQuery.identifier);
		} catch {
			if (!isDid(publisherQuery.identifier)) return json({ packages: [] });
			identity = { did: publisherQuery.identifier };
		}
		const result = await session
			.prepare(buildPublisherSearchSql(policy, hasCapability, publisherQuery.slug !== undefined))
			.bind(
				...buildPublisherSearchBindings(
					policy,
					identity.did,
					publisherQuery.slug,
					policy.mode === "allowlist" ? policy.allowlistJson : undefined,
					hasCapability ? params.capability : undefined,
					limit + 1,
					offset,
				),
			)
			.all<PackageRow>();
		rows = result.results ?? [];
		if (rows.length > 0 && identity.handle) {
			if (!identity.identityCacheHit) {
				await upsertPublisherHandle(env.DB, identity.did, identity.handle);
			}
			for (const row of rows) row.handle = identity.handle;
		}
	} else if (hasQuery) {
		const ftsQuery = quoteFtsQuery(params.q!);
		const result = await session
			.prepare(buildFtsSearchSql(policy, hasCapability))
			.bind(
				...buildFtsBindings(
					policy,
					ftsQuery,
					policy.mode === "allowlist" ? policy.allowlistJson : undefined,
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
			.prepare(buildBrowseSql(policy, hasCapability))
			.bind(
				...buildBrowseBindings(
					policy,
					policy.mode === "allowlist" ? policy.allowlistJson : undefined,
					hasCapability ? params.capability : undefined,
					limit + 1,
					offset,
				),
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

function productionSearchDeps(env: Env): SearchPackagesDeps {
	return {
		async resolvePublisher(identifier) {
			const identity = await createProductionDidResolver(env).resolveIdentifier(identifier);
			if (!identity.handle || !isHandle(identity.handle)) {
				throw new Error(`publisher has no verified handle`);
			}
			return {
				did: identity.did,
				...(identity.handle ? { handle: identity.handle } : {}),
				...(identity.identityCacheHit ? { identityCacheHit: true } : {}),
			};
		},
	};
}

function parsePublisherQuery(
	raw: string,
): { identifier: `did:${string}:${string}` | `${string}.${string}`; slug?: string } | null {
	const normalized = raw.trim().replace(LEADING_AT_PATTERN, "");
	const slash = normalized.indexOf("/");
	const identifier = slash === -1 ? normalized : normalized.slice(0, slash);
	const slug = slash === -1 ? undefined : normalized.slice(slash + 1);
	if (!isHandle(identifier) && !isDid(identifier)) return null;
	if (slug !== undefined && !PACKAGE_SLUG_PATTERN.test(slug)) return null;
	return slug === undefined ? { identifier } : { identifier, slug };
}

function buildPublisherSearchSql(
	policy: ListingPolicyConfig,
	hasCapability: boolean,
	hasSlug: boolean,
): string {
	if (policy.mode === "projection") {
		return `
			SELECT ${packageColumns("p.")}, p.labels_json
			FROM public_projection_state projection_state
			${ACTIVE_PROJECTION_JOINS_SQL}
			JOIN public_packages p ON p.generation = projection_state.active_generation
			WHERE projection_state.id = 1
			AND ${ACTIVE_PROJECTION_POLICY_SQL}
			AND ${ACTIVE_PUBLIC_PACKAGE_SQL}
			AND p.did = ?
			${hasSlug ? "AND p.slug = ?" : ""}
			${hasCapability ? CAPABILITY_FILTER_SQL : ""}
			ORDER BY p.last_updated IS NULL, p.last_updated DESC, p.slug ASC
			LIMIT ? OFFSET ?
		`;
	}
	return `
		SELECT ${packageColumns("p.")}
		FROM packages p
		WHERE p.did = ?
		${hasSlug ? "AND p.slug = ?" : ""}
		AND ${ACTIVE_PROFILE_SQL}
		${policy.mode === "allowlist" ? `AND ${ALLOWLIST_PROFILE_SQL}` : ""}
		AND ${ACTIVE_PROFILE_REDACTION_SQL}
		${hasCapability ? CAPABILITY_FILTER_SQL : ""}
		ORDER BY p.last_updated IS NULL, p.last_updated DESC, p.slug ASC
		LIMIT ? OFFSET ?
	`;
}

function buildPublisherSearchBindings(
	policy: ListingPolicyConfig,
	did: string,
	slug: string | undefined,
	allowlistJson: string | undefined,
	capability: string | undefined,
	limit: number,
	offset: number,
): unknown[] {
	const out: unknown[] = [];
	if (policy.mode === "projection") out.push(...activeProjectionPolicyBindings(policy));
	if (policy.mode === "projection") out.push(...activePublicSubjectBindings(policy));
	out.push(did);
	if (slug !== undefined) out.push(slug);
	if (allowlistJson !== undefined) out.push(allowlistJson);
	if (capability !== undefined) out.push(capability);
	out.push(limit, offset);
	return out;
}

function buildFtsSearchSql(policy: ListingPolicyConfig, hasCapability: boolean): string {
	if (policy.mode === "projection") {
		return `
			SELECT ${packageColumns("p.")}, p.labels_json
			FROM public_projection_state projection_state
			${ACTIVE_PROJECTION_JOINS_SQL}
			JOIN public_packages p ON p.generation = projection_state.active_generation
			JOIN public_packages_fts ON p.rowid = public_packages_fts.rowid
			WHERE projection_state.id = 1
			AND ${ACTIVE_PROJECTION_POLICY_SQL}
			AND ${ACTIVE_PUBLIC_PACKAGE_SQL}
			AND public_packages_fts MATCH ?
			${hasCapability ? CAPABILITY_FILTER_SQL : ""}
			ORDER BY bm25(public_packages_fts), p.last_updated DESC, p.did ASC, p.slug ASC
			LIMIT ? OFFSET ?
		`;
	}
	return `
		SELECT ${packageColumns("p.")}
		FROM packages_fts
		JOIN packages p ON p.rowid = packages_fts.rowid
		WHERE packages_fts MATCH ?
		AND ${ACTIVE_PROFILE_SQL}
		${policy.mode === "allowlist" ? `AND ${ALLOWLIST_PROFILE_SQL}` : ""}
		AND ${ACTIVE_PROFILE_REDACTION_SQL}
		${hasCapability ? CAPABILITY_FILTER_SQL : ""}
		ORDER BY bm25(packages_fts), p.last_updated DESC, p.did ASC, p.slug ASC
		LIMIT ? OFFSET ?
	`;
}

function buildFtsBindings(
	policy: ListingPolicyConfig,
	ftsQuery: string,
	allowlistJson: string | undefined,
	capability: string | undefined,
	limit: number,
	offset: number,
): unknown[] {
	const out: unknown[] = [];
	if (policy.mode === "projection") out.push(...activeProjectionPolicyBindings(policy));
	if (policy.mode === "projection") out.push(...activePublicSubjectBindings(policy));
	out.push(ftsQuery);
	if (allowlistJson !== undefined) out.push(allowlistJson);
	if (capability !== undefined) out.push(capability);
	out.push(limit, offset);
	return out;
}

function buildBrowseSql(policy: ListingPolicyConfig, hasCapability: boolean): string {
	// Stable tiebreakers (did, slug) so offset pagination doesn't shuffle
	// rows across pages when many packages share `last_updated` (or it's
	// NULL — `last_updated` comes from the optional record.lastUpdated
	// field). NULLS LAST keeps NULL `last_updated` rows out of the way
	// of the freshness sort but still reachable via pagination.
	if (policy.mode === "projection") {
		return `
			SELECT ${packageColumns("p.")}, p.labels_json
			FROM public_projection_state projection_state
			${ACTIVE_PROJECTION_JOINS_SQL}
			JOIN public_packages p ON p.generation = projection_state.active_generation
			WHERE projection_state.id = 1
			AND ${ACTIVE_PROJECTION_POLICY_SQL}
			AND ${ACTIVE_PUBLIC_PACKAGE_SQL}
			${hasCapability ? CAPABILITY_FILTER_SQL : ""}
			ORDER BY p.last_updated IS NULL, p.last_updated DESC, p.did ASC, p.slug ASC
			LIMIT ? OFFSET ?
		`;
	}
	return `
		SELECT ${packageColumns("p.")}
		FROM packages p
		WHERE ${ACTIVE_PROFILE_SQL}
		${policy.mode === "allowlist" ? `AND ${ALLOWLIST_PROFILE_SQL}` : ""}
		AND ${ACTIVE_PROFILE_REDACTION_SQL}
		${hasCapability ? CAPABILITY_FILTER_SQL : ""}
		ORDER BY p.last_updated IS NULL, p.last_updated DESC, p.did ASC, p.slug ASC
		LIMIT ? OFFSET ?
	`;
}

function buildBrowseBindings(
	policy: ListingPolicyConfig,
	allowlistJson: string | undefined,
	capability: string | undefined,
	limit: number,
	offset: number,
): unknown[] {
	const out: unknown[] = [];
	if (policy.mode === "projection") out.push(...activeProjectionPolicyBindings(policy));
	if (policy.mode === "projection") out.push(...activePublicSubjectBindings(policy));
	if (allowlistJson !== undefined) out.push(allowlistJson);
	if (capability !== undefined) out.push(capability);
	out.push(limit, offset);
	return out;
}

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
