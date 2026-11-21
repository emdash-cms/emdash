/**
 * Cloudflare D1 runtime adapter - RUNTIME ENTRY
 *
 * Creates a Kysely dialect for D1 and, when read replication is enabled,
 * a per-request Kysely bound to a D1 Sessions-API session.
 *
 * This module imports directly from cloudflare:workers to access the D1 binding.
 * Do NOT import this at config time - use { d1 } from "@emdash-cms/cloudflare" instead.
 */

import { env, waitUntil } from "cloudflare:workers";
import {
	EmDashConfigurationError,
	type CollectionDeletionGuardInput,
	type CollectionDeletionGuardResult,
} from "emdash";
import {
	attachReplayMetrics,
	kyselyLogOption,
	recordRoundTrip,
} from "emdash/database/instrumentation";
import { type Dialect, Kysely } from "kysely";

import { CoalescingD1Dialect } from "./coalescing-d1.js";
import { EmDashD1Dialect, RawBindingD1Dialect } from "./d1-dialect.js";
import { createD1SessionGuard, type D1SessionGuard } from "./d1-session-guard.js";
import { ReplayD1Dialect, type ReplayCounters } from "./replay-d1.js";
import {
	CachePlanStore,
	LayeredPlanStore,
	MemoryPlanStore,
	type ReplayPlanStore,
} from "./replay-plan-store.js";

/**
 * D1 configuration (runtime type — matches the config-time type in index.ts)
 */
interface D1Config {
	binding: string;
	session?: "disabled" | "auto" | "primary-first";
	bookmarkCookie?: string;
	coalesce?: boolean;
	replay?: boolean;
}

const DEFAULT_BOOKMARK_COOKIE = "__em_d1_bookmark";
const COLLECTION_SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;
const STALE_DELETION_GUARD_PATTERN =
	/not null constraint failed:\s*_emdash_media_usage_collection_deletions\.collection_id/i;

/**
 * One-shot guard so the "coalesce opted in but the binding can't do sessions
 * at runtime" warning fires once per worker, not on every request.
 */
let warnedCoalesceNoRuntimeSession = false;
let warnedReplayNoCoalesce = false;

/**
 * Isolate-wide replay state: the in-memory plan store, and whether this
 * isolate has finished a replay-eligible request yet. Plans are keyed on the
 * latter because a fresh isolate's first render also fills isolate-level
 * caches, so it runs reads later renders skip. On globalThis for the same
 * Vite chunk-duplication reason as the session guard.
 */
const REPLAY_STATE_KEY = Symbol.for("emdash:d1-replay");

interface ReplayIsolateState {
	memory: MemoryPlanStore;
	warm: boolean;
}

function getReplayState(): ReplayIsolateState {
	const g = globalThis as Record<symbol, unknown>;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see do-sql.ts)
	let state = g[REPLAY_STATE_KEY] as ReplayIsolateState | undefined;
	if (!state) {
		state = { memory: new MemoryPlanStore(), warm: false };
		g[REPLAY_STATE_KEY] = state;
	}
	return state;
}

function defaultCache(): Cache | null {
	try {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- workerd's CacheStorage carries `default`
		return (globalThis.caches as (CacheStorage & { default?: Cache }) | undefined)?.default ?? null;
	} catch {
		return null;
	}
}

/**
 * Isolate-wide hang guard for the D1 Sessions API. In environments where
 * session queries silently never settle (e.g. the
 * `global_fetch_strictly_public` compatibility flag blocking the Sessions
 * API's internal routing request — see
 * https://github.com/emdash-cms/emdash/issues/1273), this detects the hang
 * on the first session query, falls back to the direct binding for that
 * request, and disables sessions for the rest of the isolate's life instead
 * of letting every request hang until the Worker is killed.
 *
 * Lives on globalThis behind a Symbol.for key (not module scope) because
 * Vite can duplicate this module across SSR chunks — every duplicate must
 * resolve the SAME guard, or one copy could keep racing broken sessions
 * after another has latched (same pattern as the DO bookmark sinks in
 * do-sql.ts and core's request-cache.ts).
 */
const SESSION_GUARD_KEY = Symbol.for("emdash:d1-session-guard");

function getSessionGuard(): D1SessionGuard {
	const g = globalThis as Record<symbol, unknown>;
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see do-sql.ts)
	let guard = g[SESSION_GUARD_KEY] as D1SessionGuard | undefined;
	if (!guard) {
		guard = createD1SessionGuard();
		g[SESSION_GUARD_KEY] = guard;
	}
	return guard;
}

/**
 * D1 bookmarks are opaque, minted by Cloudflare. We don't validate the shape
 * (a tighter regex risks rejecting a format change and silently degrading
 * read-your-writes), but we do cap length and reject control characters so a
 * malicious or corrupt cookie can't smuggle anything weird into `withSession`.
 */
// D1 bookmarks observed in the wild are ~60 chars, but the format is opaque
// and future encodings (e.g. signed envelopes) could be longer. Err on the
// generous side — cookie values max out at ~4 KB anyway.
const MAX_BOOKMARK_LENGTH = 1024;

function hasControlChars(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

/**
 * Create a D1 dialect from config. Used for the singleton Kysely instance
 * (no session — queries go through the raw binding).
 */
export function createDialect(config: D1Config): Dialect {
	const db = getBinding(config);
	if (!db) {
		const example = JSON.stringify(
			{
				d1_databases: [
					{
						binding: config.binding,
						database_name: "your-database-name",
						database_id: "your-database-id",
					},
				],
			},
			null,
			2,
		);
		throw new EmDashConfigurationError(
			`D1 binding "${config.binding}" not found in environment. ` +
				`Check your wrangler.jsonc configuration:\n\n${example}`,
			"BINDING_NOT_FOUND",
		);
	}
	// Coalescing only applies to the per-request session db; without
	// sessions it silently does nothing, which would be a confusing no-op.
	if (config.coalesce && !isSessionEnabled(config)) {
		console.warn(
			'[emdash] d1({ coalesce: true }) has no effect without sessions — set session: "auto" (or "primary-first") to enable query coalescing.',
		);
	}
	if (config.replay && (!config.coalesce || !isSessionEnabled(config)) && !warnedReplayNoCoalesce) {
		warnedReplayNoCoalesce = true;
		console.warn(
			'[emdash] d1({ replay: true }) has no effect without sessions and coalescing — set session: "auto" (or "primary-first") and coalesce: true to enable query replay.',
		);
	}
	// The raw-binding singleton skips the ConnectionMutex: on Workers a
	// canceled request would otherwise never release the lock, deadlocking the
	// isolate (#2040). The session-backed dialects below keep their
	// serialization (see RawBindingD1Dialect for why).
	return new RawBindingD1Dialect({ database: db, onRpc: recordRoundTrip });
}

/**
 * Coalescing D1 dialect for the runtime's cold-start read phase, where the
 * core runtime batches its init reads into one `batch()` round trip. Carries
 * no Sessions-API bookmark — cold-start reads need no read-your-writes
 * guarantee — so plain coalescing over the raw binding suffices. Each call
 * returns a fresh dialect; this must never back the long-lived singleton,
 * whose coalescing buffer would be shared across requests.
 */
export function createCoalescingDialect(config: D1Config): Dialect {
	const db = getBinding(config);
	if (!db) {
		throw new EmDashConfigurationError(
			`D1 binding "${config.binding}" not found in environment.`,
			"BINDING_NOT_FOUND",
		);
	}
	return new CoalescingD1Dialect({ database: db, onRpc: recordRoundTrip });
}

// =========================================================================
// D1 Read Replica Session Support
//
// createRequestScopedDb is called by the core middleware on each request.
// When sessions are enabled it returns a per-request Kysely bound to a
// D1 Sessions API session, plus a `commit()` callback that persists the
// resulting bookmark as a cookie for authenticated users.
// =========================================================================

/**
 * A cookie interface minimally compatible with Astro's AstroCookies. Declared
 * here (not imported from astro) so this module stays free of astro types.
 */
interface CookieJar {
	get(name: string): { value: string } | undefined;
	set(name: string, value: string, options: Record<string, unknown>): void;
}

export interface RequestScopedDbOpts {
	config: D1Config;
	isAuthenticated: boolean;
	/** Whether core routing allows this request to use an anonymous public-read cache. */
	canUseCachedBinding?: boolean;
	/** A GET whose preferred response type is HTML (core's anonymous page path). */
	htmlNavigation?: boolean;
	/** Identifies the site build; plans from another build are never used. */
	buildId?: string;
	/**
	 * Evaluated at commit() time: whether the request ended authenticated.
	 * Login/signup/invite requests start unauthenticated and establish a
	 * session mid-request; `isAuthenticated` captures only the request-start
	 * state.
	 */
	endedAuthenticated?: () => boolean;
	isWrite: boolean;
	cookies: CookieJar;
	url: URL;
}

export interface RequestScopedDb {
	/** Per-request Kysely instance backed by a D1 Sessions API session. */
	db: Kysely<any>;
	/**
	 * Persist any per-request session state (e.g. the resulting D1 bookmark)
	 * as a cookie. Idempotent; safe to call once after next() returns.
	 */
	commit: () => void;
	/**
	 * Set only when the request replays: learns the plan once the body has
	 * streamed, from `outcome` (core's description of the response; absent
	 * when the render threw).
	 */
	close?: (outcome?: ResponseOutcome) => void;
}

/** Mirrors core's ScopedResponseOutcome (declared here to keep the adapter free of core internals). */
export interface ResponseOutcome {
	status: number;
	contentType: string | null;
	/** The body streamed to the end (true for bodyless responses). */
	complete: boolean;
}

/** Only a fully streamed 2xx HTML page is a render worth learning from. */
function isLearnablePage(outcome: ResponseOutcome | undefined): boolean {
	return (
		!!outcome &&
		outcome.complete &&
		outcome.status >= 200 &&
		outcome.status < 300 &&
		(outcome.contentType ?? "").trim().toLowerCase().startsWith("text/html")
	);
}

/** The path is gone: a plan stored for it only predicts wasted reads. */
function isGone(outcome: ResponseOutcome | undefined): boolean {
	return !!outcome && (outcome.status === 404 || outcome.status === 410);
}

export async function executeCollectionDeletionGuard(
	config: D1Config,
	input: CollectionDeletionGuardInput,
): Promise<CollectionDeletionGuardResult> {
	assertCollectionDeletionInput(input);
	const binding = getBinding(config);
	if (!binding) {
		throw new EmDashConfigurationError(
			`D1 binding "${config.binding}" not found in environment.`,
			"BINDING_NOT_FOUND",
		);
	}
	return input.action === "fence"
		? executeFenceBatch(binding, input)
		: executeDropBatch(binding, input);
}

async function executeFenceBatch(
	binding: D1Database,
	input: Extract<CollectionDeletionGuardInput, { action: "fence" }>,
): Promise<CollectionDeletionGuardResult> {
	const tableName = `ec_${input.collectionSlug}`;
	const contentPredicate = input.forceDelete
		? ""
		: `AND NOT EXISTS (SELECT 1 FROM "${tableName}" WHERE deleted_at IS NULL LIMIT 1)`;
	const update = binding
		.prepare(`
			UPDATE _emdash_media_usage_index_status
			SET capture_state = 'deleting',
				updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
			WHERE adapter_id = 'content-media'
				AND scope_type = 'collection'
				AND scope_key = ?
				AND collection_id = ?
				AND capture_state = 'active'
				AND EXISTS (
					SELECT 1 FROM _emdash_collections
					WHERE id = ? AND slug = ?
				)
				AND EXISTS (
					SELECT 1 FROM _emdash_media_usage_collection_deletions
					WHERE collection_id = ?
						AND collection_slug = ?
						AND state = 'leased'
						AND phase = 'fence'
						AND lease_token = ?
						AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				)
				${contentPredicate}
			RETURNING collection_id
		`)
		.bind(
			input.collectionSlug,
			input.collectionId,
			input.collectionId,
			input.collectionSlug,
			input.collectionId,
			input.collectionSlug,
			input.leaseToken,
		);
	const diagnostic = binding
		.prepare(`
			SELECT CASE
				WHEN EXISTS (
					SELECT 1 FROM _emdash_media_usage_collection_deletions
					WHERE collection_id = ?
						AND collection_slug = ?
						AND state = 'leased'
						AND phase = 'fence'
						AND lease_token = ?
						AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				)
				AND EXISTS (
					SELECT 1 FROM _emdash_media_usage_index_status
					WHERE adapter_id = 'content-media'
						AND scope_type = 'collection'
						AND scope_key = ?
						AND collection_id = ?
						AND capture_state = 'active'
				)
				AND EXISTS (SELECT 1 FROM "${tableName}" WHERE deleted_at IS NULL LIMIT 1)
				THEN 'has_content'
				ELSE 'stale'
			END AS outcome
		`)
		.bind(
			input.collectionId,
			input.collectionSlug,
			input.leaseToken,
			input.collectionSlug,
			input.collectionId,
		);
	if (input.forceDelete) {
		const updated = await update.all<{ collection_id: string }>();
		return updated.results.length > 0 ? { outcome: "fenced" } : { outcome: "stale" };
	}
	const [updated, observed] = await binding.batch<{ collection_id: string } | { outcome: string }>([
		update,
		diagnostic,
	]);
	if (updated?.results.length) return { outcome: "fenced" };
	const diagnosticRow = observed?.results[0];
	return diagnosticRow && "outcome" in diagnosticRow && diagnosticRow.outcome === "has_content"
		? { outcome: "has_content" }
		: { outcome: "stale" };
}

async function executeDropBatch(
	binding: D1Database,
	input: Extract<CollectionDeletionGuardInput, { action: "drop" }>,
): Promise<CollectionDeletionGuardResult> {
	const contentTable = `ec_${input.collectionSlug}`;
	const ftsTable = `_emdash_fts_${input.collectionSlug}`;
	const guardId = `__emdash_guard:${input.collectionId}:${input.leaseToken}`;
	const guardSlug = `__emdash_guard_slug:${input.collectionId}:${input.leaseToken}`;
	try {
		await binding.batch([
			binding
				.prepare(`
					INSERT INTO _emdash_media_usage_collection_deletions (
						collection_id, collection_slug, force_delete, state, phase,
						next_attempt_at, lease_token, lease_expires_at
					)
					VALUES (
						(
							SELECT ?
							FROM _emdash_media_usage_collection_deletions
							WHERE collection_id = ?
								AND collection_slug = ?
								AND state = 'leased'
								AND phase = 'table'
								AND lease_token = ?
								AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
						),
						?, 0, 'leased', 'table',
						strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), ?,
						strftime('%Y-%m-%dT%H:%M:%fZ', 'now', '+1 minute')
					)
				`)
				.bind(
					guardId,
					input.collectionId,
					input.collectionSlug,
					input.leaseToken,
					guardSlug,
					input.leaseToken,
				),
			binding.prepare(`DROP TRIGGER IF EXISTS "${ftsTable}_insert"`),
			binding.prepare(`DROP TRIGGER IF EXISTS "${ftsTable}_update"`),
			binding.prepare(`DROP TRIGGER IF EXISTS "${ftsTable}_delete"`),
			binding.prepare(`DROP TABLE IF EXISTS "${ftsTable}"`),
			binding.prepare(`DROP TABLE IF EXISTS "${contentTable}"`),
			binding
				.prepare(
					"DELETE FROM _emdash_media_usage_collection_deletions WHERE collection_id = ? AND collection_slug = ?",
				)
				.bind(guardId, guardSlug),
		]);
	} catch (error) {
		if (STALE_DELETION_GUARD_PATTERN.test(deepErrorMessage(error))) {
			return { outcome: "stale" };
		}
		throw error;
	}
	return { outcome: "dropped" };
}

function assertCollectionDeletionInput(input: CollectionDeletionGuardInput): void {
	if (!input.collectionId || !input.leaseToken) {
		throw new Error("Collection deletion guard requires a collection ID and lease token");
	}
	if (!COLLECTION_SLUG_PATTERN.test(input.collectionSlug) || input.collectionSlug.length > 63) {
		throw new Error("Collection deletion guard requires a valid collection slug");
	}
}

function deepErrorMessage(error: unknown): string {
	if (error instanceof Error) {
		return error.cause ? `${error.message}: ${deepErrorMessage(error.cause)}` : error.message;
	}
	return String(error);
}

/**
 * Create a per-request session-backed Kysely, or null when D1 sessions are
 * disabled or the binding is missing. Core middleware calls this once per
 * request, stashes `db` in ALS for the duration of next(), then invokes
 * `commit()` on the response path.
 */
export function createRequestScopedDb(opts: RequestScopedDbOpts): RequestScopedDb | null {
	if (!isSessionEnabled(opts.config)) return null;
	// A session query hung earlier in this isolate's life (see the guard).
	// Sessions are considered broken here; route everything through the
	// singleton (direct binding) instead of hanging every request.
	const sessionGuard = getSessionGuard();
	if (sessionGuard.isBroken()) return null;
	const binding = getBinding(opts.config);
	if (!binding || typeof binding.withSession !== "function") {
		// Sessions are enabled in config, so createDialect's config-time warning
		// didn't fire — but the live binding can't actually do sessions (older
		// D1 binding / missing withSession). Coalescing silently falls back to
		// the singleton, so surface that once rather than leaving the opt-in a
		// mystery no-op.
		if (opts.config.coalesce && binding && !warnedCoalesceNoRuntimeSession) {
			warnedCoalesceNoRuntimeSession = true;
			console.warn(
				"[emdash] d1({ coalesce: true }) has no effect: the D1 binding does not support sessions (withSession() is unavailable at runtime). Query coalescing requires D1 sessions.",
			);
		}
		return null;
	}

	const cookieName = opts.config.bookmarkCookie ?? DEFAULT_BOOKMARK_COOKIE;
	const configConstraint =
		opts.config.session === "primary-first" ? "first-primary" : "first-unconstrained";

	// Any write — authenticated or not (e.g. an anonymous comment POST) — must
	// hit primary; we don't want a write plus a follow-up read racing across
	// replicas. Authenticated reads resume from a prior bookmark when the client
	// sent a valid one. Everything else (anonymous reads — the whole point of
	// read replicas) uses the config default, typically "first-unconstrained"
	// for nearest-replica routing.
	let constraint: string = configConstraint;
	if (opts.isWrite) {
		constraint = "first-primary";
	} else if (opts.isAuthenticated) {
		const bookmark = opts.cookies.get(cookieName)?.value;
		if (
			bookmark &&
			bookmark.length > 0 &&
			bookmark.length <= MAX_BOOKMARK_LENGTH &&
			!hasControlChars(bookmark)
		) {
			constraint = bookmark;
		}
	}

	const session = binding.withSession(constraint);
	// kysely-d1 only touches .prepare() and .batch() on the database argument,
	// both of which D1DatabaseSession implements. Hang-guarded: until the
	// first session query settles in this isolate, queries are raced against
	// a timeout and fall back to the direct binding if the Sessions API never
	// responds (issue #1273).
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- session is structurally compatible with the subset D1Dialect uses
	const sessionAsDatabase = sessionGuard.wrap(session as unknown as D1Database, binding);
	// Coalescing is per-request only by construction: this Kysely (and its
	// driver buffer) lives for a single request, so there is no cross-request
	// buffering. The shared singleton from createDialect must never coalesce.
	const replayBuildId =
		opts.config.coalesce && opts.config.replay ? replayBuildIdFor(opts) : undefined;
	const replayOff = replayBuildId !== undefined && isReplayOffHost(opts.url.hostname);
	const replay =
		replayBuildId !== undefined && !replayOff ? startReplay(opts, replayBuildId) : null;
	const dialect = replay
		? new ReplayD1Dialect({ database: sessionAsDatabase, onRpc: recordRoundTrip }, replay.options)
		: opts.config.coalesce
			? new CoalescingD1Dialect({ database: sessionAsDatabase, onRpc: recordRoundTrip })
			: new EmDashD1Dialect({ database: sessionAsDatabase, onRpc: recordRoundTrip });
	const db = new Kysely<any>({
		dialect,
		// Kysely measures around the driver call, so per-query metrics still
		// count each query. With coalescing, durations reflect the shared batch
		// window rather than per-statement time — acceptable.
		log: kyselyLogOption(),
	});

	// Learning: only a request without a query string may change the stored
	// plan, and only from a fully streamed 2xx HTML page. A 404/410 that
	// replayed a plan deletes it (the path is gone, so the plan only predicts
	// wasted reads); redirects, 5xx, thrown renders and cut-off streams leave
	// the stored plan alone, since they say nothing about a good render.
	const close =
		replay && dialect instanceof ReplayD1Dialect
			? (response?: ResponseOutcome) => {
					replay.state.warm = true;
					const outcome = dialect.finish();
					if (!replay.learns || !outcome) return;
					if (isLearnablePage(response)) {
						const nextPlan = outcome.nextPlan;
						if (nextPlan) replay.enqueue((store) => store.put(replay.key, nextPlan));
					} else if (isGone(response) && outcome.hadPlan) {
						replay.enqueue((store) => store.delete(replay.key));
					}
				}
			: replayOff
				? () => {
						getReplayState().warm = true;
					}
				: undefined;

	return {
		db,
		...(close ? { close } : {}),
		commit() {
			// Anonymous sessions can't resume across requests, so there's no
			// value in persisting a bookmark for them. A request that became
			// authenticated mid-flight (login, signup, invite) must persist:
			// its writes landed on the primary, and the follow-up request reads
			// authenticated — without this bookmark it can hit a replica that
			// doesn't have the new user/session rows yet.
			if (!opts.isAuthenticated && !opts.endedAuthenticated?.()) return;
			const newBookmark = session.getBookmark?.();
			if (!newBookmark) return;
			opts.cookies.set(cookieName, newBookmark, {
				path: "/",
				httpOnly: true,
				sameSite: "lax",
				secure: opts.url.protocol === "https:",
			});
		},
	};
}

/**
 * Set up speculative replay for an anonymous HTML navigation: look up the
 * plan for this build, isolate phase, host and path, and hand it to the
 * connection, which starts the batch as soon as the plan resolves. Returns
 * null for every other request. The plan key ignores the query string; the
 * locale is part of the path (or host), so it needs no component of its own.
 *
 * Only requests without a query string learn (`learns`): a page that reads
 * the query string (search, `?page=`) would otherwise rewrite its one plan for
 * every new value. Requests with one still replay the path's plan, serving
 * whatever matches, but never write or delete it.
 */
function startReplay(opts: RequestScopedDbOpts, buildId: string) {
	const state = getReplayState();
	const key = `${buildId}:${state.warm ? "warm" : "cold"}:${opts.url.host}${opts.url.pathname}`;
	const store: ReplayPlanStore = new LayeredPlanStore(
		state.memory,
		new CachePlanStore(defaultCache(), opts.url.origin),
	);
	// Store writes run in order (a drop after a failed batch must not land
	// after the rewrite that follows it) and in the background.
	let chain: Promise<void> = Promise.resolve();
	const enqueue = (op: (s: ReplayPlanStore) => Promise<void>) => {
		chain = chain.then(() => op(store)).catch(() => {});
		try {
			waitUntil(chain);
		} catch {
			// Outside a request the promise simply runs.
		}
	};
	const counters: ReplayCounters = { hits: 0, misses: 0, waste: 0 };
	attachReplayMetrics(counters);
	const learns = opts.url.search === "";
	return {
		key,
		state,
		learns,
		enqueue,
		options: {
			plan: store.get(key),
			counters,
			onBatchFailed: learns ? () => enqueue((s) => s.delete(key)) : undefined,
		},
	};
}

/**
 * The build id to key plans with when this request may replay: an anonymous
 * HTML navigation that may use the public cache. Undefined otherwise.
 */
function replayBuildIdFor(opts: RequestScopedDbOpts): string | undefined {
	if (!opts.htmlNavigation || !opts.canUseCachedBinding || opts.isWrite || opts.isAuthenticated) {
		return undefined;
	}
	return opts.buildId || undefined;
}

/**
 * Hosts in the comma-separated `EMDASH_REPLAY_OFF_HOSTS` Worker var render
 * without replay, so one deployment can serve replay on and off side by side
 * from the same isolates and database. Their requests still mark the isolate
 * warm, or a replaying host on the same isolate would keep using cold plans.
 */
function isReplayOffHost(hostname: string): boolean {
	const list: unknown = Reflect.get(env, "EMDASH_REPLAY_OFF_HOSTS");
	if (typeof list !== "string" || list === "") return false;
	return list.split(",").some((host) => host.trim().toLowerCase() === hostname);
}

function isSessionEnabled(config: D1Config): boolean {
	return !!config.session && config.session !== "disabled";
}

function getBinding(config: D1Config): D1Database | null {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Worker binding accessed from untyped env object
	const db = (env as Record<string, unknown>)[config.binding] as D1Database | undefined;
	return db ?? null;
}
