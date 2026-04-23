import { sql, type Kysely } from "kysely";
import { ulid } from "ulidx";

import {
	compilePattern,
	matchPattern,
	interpolateDestination,
	isPattern,
} from "../../redirects/patterns.js";
import { currentTimestampValue } from "../dialect-helpers.js";
import type { Database, RedirectTable } from "../types.js";
import { encodeCursor, decodeCursor, type FindManyResult } from "./types.js";

// ---------------------------------------------------------------------------
// Bounded 404 logging
// ---------------------------------------------------------------------------

/**
 * Hard cap on rows stored in `_emdash_404_log`. When exceeded, the oldest
 * rows (by `last_seen_at`) are evicted on insert. Prevents an unauthenticated
 * attacker from growing the table without bound by requesting unique URLs.
 */
export const MAX_404_LOG_ROWS = 10_000;

/** Max stored length for the `Referer` header — truncated on insert. */
export const REFERRER_MAX_LENGTH = 512;

/** Max stored length for the `User-Agent` header — truncated on insert. */
export const USER_AGENT_MAX_LENGTH = 256;

/**
 * Truncate a header-derived string to `max` chars, preserving `null`/`undefined`
 * as `null`. Empty strings stay empty (the caller decides whether to coerce).
 */
function truncateOrNull(value: string | null | undefined, max: number): string | null {
	if (value === null || value === undefined) return null;
	return value.length > max ? value.slice(0, max) : value;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Redirect {
	id: string;
	source: string;
	destination: string;
	type: number;
	isPattern: boolean;
	enabled: boolean;
	hits: number;
	lastHitAt: string | null;
	groupName: string | null;
	auto: boolean;
	createdAt: string;
	updatedAt: string;
}

export interface CreateRedirectInput {
	source: string;
	destination: string;
	type?: number;
	isPattern?: boolean;
	enabled?: boolean;
	groupName?: string | null;
	auto?: boolean;
}

export interface UpdateRedirectInput {
	source?: string;
	destination?: string;
	type?: number;
	isPattern?: boolean;
	enabled?: boolean;
	groupName?: string | null;
}

export interface NotFoundEntry {
	id: string;
	path: string;
	referrer: string | null;
	userAgent: string | null;
	ip: string | null;
	createdAt: string;
}

export interface NotFoundSummary {
	path: string;
	count: number;
	lastSeen: string;
	topReferrer: string | null;
}

export interface RedirectMatch {
	redirect: Redirect;
	resolvedDestination: string;
}

// ---------------------------------------------------------------------------
// Row mapping
// ---------------------------------------------------------------------------

function rowToRedirect(row: RedirectTable): Redirect {
	return {
		id: row.id,
		source: row.source,
		destination: row.destination,
		type: row.type,
		isPattern: row.is_pattern === 1,
		enabled: row.enabled === 1,
		hits: row.hits,
		lastHitAt: row.last_hit_at,
		groupName: row.group_name,
		auto: row.auto === 1,
		createdAt: row.created_at,
		updatedAt: row.updated_at,
	};
}

// ---------------------------------------------------------------------------
// Repository
// ---------------------------------------------------------------------------

export class RedirectRepository {
	constructor(private db: Kysely<Database>) {}

	// --- CRUD ---------------------------------------------------------------

	async findById(id: string): Promise<Redirect | null> {
		const row = await this.db
			.selectFrom("_emdash_redirects")
			.selectAll()
			.where("id", "=", id)
			.executeTakeFirst();
		return row ? rowToRedirect(row) : null;
	}

	async findBySource(source: string): Promise<Redirect | null> {
		const row = await this.db
			.selectFrom("_emdash_redirects")
			.selectAll()
			.where("source", "=", source)
			.executeTakeFirst();
		return row ? rowToRedirect(row) : null;
	}

	async findMany(opts: {
		cursor?: string;
		limit?: number;
		search?: string;
		group?: string;
		enabled?: boolean;
		auto?: boolean;
	}): Promise<FindManyResult<Redirect>> {
		const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);

		let query = this.db
			.selectFrom("_emdash_redirects")
			.selectAll()
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(limit + 1);

		if (opts.search) {
			const term = `%${opts.search}%`;
			query = query.where((eb) =>
				eb.or([eb("source", "like", term), eb("destination", "like", term)]),
			);
		}

		if (opts.group !== undefined) {
			query = query.where("group_name", "=", opts.group);
		}

		if (opts.enabled !== undefined) {
			query = query.where("enabled", "=", opts.enabled ? 1 : 0);
		}

		if (opts.auto !== undefined) {
			query = query.where("auto", "=", opts.auto ? 1 : 0);
		}

		if (opts.cursor) {
			const decoded = decodeCursor(opts.cursor);
			if (decoded) {
				query = query.where((eb) =>
					eb.or([
						eb("created_at", "<", decoded.orderValue),
						eb.and([eb("created_at", "=", decoded.orderValue), eb("id", "<", decoded.id)]),
					]),
				);
			}
		}

		const rows = await query.execute();
		const items = rows.slice(0, limit).map(rowToRedirect);
		const result: FindManyResult<Redirect> = { items };

		if (rows.length > limit) {
			const last = items.at(-1)!;
			result.nextCursor = encodeCursor(last.createdAt, last.id);
		}

		return result;
	}

	async create(input: CreateRedirectInput): Promise<Redirect> {
		const id = ulid();
		const now = new Date().toISOString();
		const patternFlag = input.isPattern ?? isPattern(input.source);

		await this.db
			.insertInto("_emdash_redirects")
			.values({
				id,
				source: input.source,
				destination: input.destination,
				type: input.type ?? 301,
				is_pattern: patternFlag ? 1 : 0,
				enabled: input.enabled !== false ? 1 : 0,
				hits: 0,
				last_hit_at: null,
				group_name: input.groupName ?? null,
				auto: input.auto ? 1 : 0,
				created_at: now,
				updated_at: now,
			})
			.execute();

		return (await this.findById(id))!;
	}

	async update(id: string, input: UpdateRedirectInput): Promise<Redirect | null> {
		const existing = await this.findById(id);
		if (!existing) return null;

		const now = new Date().toISOString();
		const values: Record<string, unknown> = { updated_at: now };

		if (input.source !== undefined) {
			values.source = input.source;
			values.is_pattern =
				input.isPattern !== undefined ? (input.isPattern ? 1 : 0) : isPattern(input.source) ? 1 : 0;
		} else if (input.isPattern !== undefined) {
			values.is_pattern = input.isPattern ? 1 : 0;
		}

		if (input.destination !== undefined) values.destination = input.destination;
		if (input.type !== undefined) values.type = input.type;
		if (input.enabled !== undefined) values.enabled = input.enabled ? 1 : 0;
		if (input.groupName !== undefined) values.group_name = input.groupName;

		await this.db.updateTable("_emdash_redirects").set(values).where("id", "=", id).execute();

		return (await this.findById(id))!;
	}

	async delete(id: string): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_emdash_redirects")
			.where("id", "=", id)
			.executeTakeFirst();
		return BigInt(result.numDeletedRows) > 0n;
	}

	/**
	 * Fetch all enabled redirects (for loop detection graph building).
	 * Not paginated — returns the full set.
	 */
	async findAllEnabled(): Promise<Redirect[]> {
		const rows = await this.db
			.selectFrom("_emdash_redirects")
			.selectAll()
			.where("enabled", "=", 1)
			.execute();
		return rows.map(rowToRedirect);
	}

	// --- Matching -----------------------------------------------------------

	async findExactMatch(path: string): Promise<Redirect | null> {
		const row = await this.db
			.selectFrom("_emdash_redirects")
			.selectAll()
			.where("source", "=", path)
			.where("enabled", "=", 1)
			.where("is_pattern", "=", 0)
			.executeTakeFirst();
		return row ? rowToRedirect(row) : null;
	}

	async findEnabledPatternRules(): Promise<Redirect[]> {
		const rows = await this.db
			.selectFrom("_emdash_redirects")
			.selectAll()
			.where("enabled", "=", 1)
			.where("is_pattern", "=", 1)
			.execute();
		return rows.map(rowToRedirect);
	}

	/**
	 * Match a request path against all enabled redirect rules.
	 * Checks exact matches first (indexed), then pattern rules.
	 * Returns the matched redirect and the resolved destination URL.
	 */
	async matchPath(path: string): Promise<RedirectMatch | null> {
		// 1. Exact match (fast, indexed)
		const exact = await this.findExactMatch(path);
		if (exact) {
			return { redirect: exact, resolvedDestination: exact.destination };
		}

		// 2. Pattern match
		const patterns = await this.findEnabledPatternRules();
		for (const redirect of patterns) {
			const compiled = compilePattern(redirect.source);
			const params = matchPattern(compiled, path);
			if (params) {
				const resolved = interpolateDestination(redirect.destination, params);
				return { redirect, resolvedDestination: resolved };
			}
		}

		return null;
	}

	// --- Hit tracking -------------------------------------------------------

	async recordHit(id: string): Promise<void> {
		await sql`
			UPDATE _emdash_redirects
			SET hits = hits + 1, last_hit_at = ${currentTimestampValue(this.db)}, updated_at = ${currentTimestampValue(this.db)}
			WHERE id = ${id}
		`.execute(this.db);
	}

	// --- Auto-redirects (slug change) ---------------------------------------

	/**
	 * Create an auto-redirect when a content slug changes.
	 * Uses the collection's URL pattern to compute old/new URLs.
	 * Collapses existing redirect chains pointing to the old URL.
	 */
	async createAutoRedirect(
		collection: string,
		oldSlug: string,
		newSlug: string,
		contentId: string,
		urlPattern: string | null,
	): Promise<Redirect> {
		const oldUrl = urlPattern
			? urlPattern.replace("{slug}", oldSlug).replace("{id}", contentId)
			: `/${collection}/${oldSlug}`;
		const newUrl = urlPattern
			? urlPattern.replace("{slug}", newSlug).replace("{id}", contentId)
			: `/${collection}/${newSlug}`;

		// Collapse chains: update any existing redirects pointing to the old URL
		await this.collapseChains(oldUrl, newUrl);

		// Check if a redirect from this source already exists
		const existing = await this.findBySource(oldUrl);
		if (existing) {
			// Update the existing redirect to point to the new URL
			return (await this.update(existing.id, { destination: newUrl }))!;
		}

		return this.create({
			source: oldUrl,
			destination: newUrl,
			type: 301,
			isPattern: false,
			auto: true,
			groupName: "Auto: slug change",
		});
	}

	/**
	 * Update all redirects whose destination matches oldDestination
	 * to point to newDestination instead. Prevents redirect chains.
	 * Returns the number of updated rows.
	 */
	async collapseChains(oldDestination: string, newDestination: string): Promise<number> {
		const result = await this.db
			.updateTable("_emdash_redirects")
			.set({
				destination: newDestination,
				updated_at: new Date().toISOString(),
			})
			.where("destination", "=", oldDestination)
			.executeTakeFirst();
		return Number(result.numUpdatedRows);
	}

	// --- 404 log ------------------------------------------------------------

	/**
	 * Record a 404 hit for `entry.path`.
	 *
	 * Dedups by path: repeat hits increment `hits` and refresh `last_seen_at`
	 * on the existing row instead of inserting a new one. Referrer and
	 * user-agent are truncated to bounded lengths so a malicious client can't
	 * blow up storage with huge headers. When the table would exceed
	 * MAX_404_LOG_ROWS, the oldest entries (by `last_seen_at`) are evicted.
	 *
	 * This is called from the public redirect middleware on every 404 and
	 * must never throw for an unauthenticated caller — failures bubble up to
	 * the middleware, which swallows them.
	 */
	async log404(entry: {
		path: string;
		referrer?: string | null;
		userAgent?: string | null;
		ip?: string | null;
	}): Promise<void> {
		const now = new Date().toISOString();
		const referrer = truncateOrNull(entry.referrer, REFERRER_MAX_LENGTH);
		const userAgent = truncateOrNull(entry.userAgent, USER_AGENT_MAX_LENGTH);
		const ip = entry.ip ?? null;

		// Upsert: check for existing row by path, bump if present, insert if not.
		const existing = await this.db
			.selectFrom("_emdash_404_log")
			.select("id")
			.where("path", "=", entry.path)
			.executeTakeFirst();

		if (existing) {
			await this.db
				.updateTable("_emdash_404_log")
				.set({
					hits: sql`hits + 1`,
					last_seen_at: now,
					referrer,
					user_agent: userAgent,
					ip,
				})
				.where("id", "=", existing.id)
				.execute();
			return;
		}

		await this.db
			.insertInto("_emdash_404_log")
			.values({
				id: ulid(),
				path: entry.path,
				referrer,
				user_agent: userAgent,
				ip,
				hits: 1,
				last_seen_at: now,
				created_at: now,
			})
			.execute();

		// Enforce the row cap. Deterministic: every insert of a brand-new path
		// counts the table and evicts the oldest rows if over cap. Updates
		// (dedup hits) don't grow the table, so they skip this step.
		await this.enforce404Cap();
	}

	/**
	 * Delete the oldest rows from `_emdash_404_log` if the row count exceeds
	 * MAX_404_LOG_ROWS. "Oldest" is by `last_seen_at`, so a path that keeps
	 * getting hit stays in the table even if it was first seen long ago.
	 *
	 * Exposed (package-private) for tests; callers should prefer `log404`.
	 */
	private async enforce404Cap(): Promise<void> {
		const countRow = await this.db
			.selectFrom("_emdash_404_log")
			.select((eb) => eb.fn.countAll<number>().as("c"))
			.executeTakeFirst();
		const count = Number(countRow?.c ?? 0);
		if (count <= MAX_404_LOG_ROWS) return;

		const excess = count - MAX_404_LOG_ROWS;
		const victims = await this.db
			.selectFrom("_emdash_404_log")
			.select("id")
			.orderBy("last_seen_at", "asc")
			.orderBy("id", "asc")
			.limit(excess)
			.execute();

		if (victims.length === 0) return;

		await this.db
			.deleteFrom("_emdash_404_log")
			.where(
				"id",
				"in",
				victims.map((v) => v.id),
			)
			.execute();
	}

	async find404s(opts: {
		cursor?: string;
		limit?: number;
		search?: string;
	}): Promise<FindManyResult<NotFoundEntry>> {
		const limit = Math.min(Math.max(opts.limit ?? 50, 1), 100);

		let query = this.db
			.selectFrom("_emdash_404_log")
			.selectAll()
			.orderBy("created_at", "desc")
			.orderBy("id", "desc")
			.limit(limit + 1);

		if (opts.search) {
			query = query.where("path", "like", `%${opts.search}%`);
		}

		if (opts.cursor) {
			const decoded = decodeCursor(opts.cursor);
			if (decoded) {
				query = query.where((eb) =>
					eb.or([
						eb("created_at", "<", decoded.orderValue),
						eb.and([eb("created_at", "=", decoded.orderValue), eb("id", "<", decoded.id)]),
					]),
				);
			}
		}

		const rows = await query.execute();
		const items: NotFoundEntry[] = rows.slice(0, limit).map((row) => ({
			id: row.id,
			path: row.path,
			referrer: row.referrer,
			userAgent: row.user_agent,
			ip: row.ip,
			createdAt: row.created_at,
		}));

		const result: FindManyResult<NotFoundEntry> = { items };
		if (rows.length > limit) {
			const last = items.at(-1)!;
			result.nextCursor = encodeCursor(last.createdAt, last.id);
		}

		return result;
	}

	async get404Summary(limit = 50): Promise<NotFoundSummary[]> {
		// Since rows are now deduped by path, each path has exactly one row
		// with `hits` as the running count and `last_seen_at` as the latest
		// timestamp. The subquery for `top_referrer` collapses to a simple
		// pick of the row's stored referrer (the most recent one seen).
		const rows = await sql<{
			path: string;
			count: number;
			last_seen: string;
			top_referrer: string | null;
		}>`
			SELECT
				path,
				SUM(hits) as count,
				MAX(last_seen_at) as last_seen,
				(
					SELECT referrer FROM _emdash_404_log AS inner_log
					WHERE inner_log.path = _emdash_404_log.path
						AND referrer IS NOT NULL AND referrer != ''
					LIMIT 1
				) as top_referrer
			FROM _emdash_404_log
			GROUP BY path
			ORDER BY count DESC
			LIMIT ${limit}
		`.execute(this.db);

		return rows.rows.map((row) => ({
			path: row.path,
			count: Number(row.count),
			lastSeen: row.last_seen,
			topReferrer: row.top_referrer,
		}));
	}

	async delete404(id: string): Promise<boolean> {
		const result = await this.db
			.deleteFrom("_emdash_404_log")
			.where("id", "=", id)
			.executeTakeFirst();
		return BigInt(result.numDeletedRows) > 0n;
	}

	async clear404s(): Promise<number> {
		const result = await this.db.deleteFrom("_emdash_404_log").executeTakeFirst();
		return Number(result.numDeletedRows);
	}

	async prune404s(olderThan: string): Promise<number> {
		const result = await this.db
			.deleteFrom("_emdash_404_log")
			.where("created_at", "<", olderThan)
			.executeTakeFirst();
		return Number(result.numDeletedRows);
	}
}
