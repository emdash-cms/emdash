/**
 * Durable Object SQL database — RUNTIME ENTRY
 *
 * Creates a Kysely dialect backed by an `EmDashDB` Durable Object and, when
 * read replication is enabled, a per-request Kysely that holds a single DO stub
 * for the whole request (anonymous reads route to the nearest replica; writes
 * proxy to the primary; authenticated requests get read-your-writes via a
 * bookmark cookie).
 *
 * This module imports directly from cloudflare:workers to access the DO
 * binding. Do NOT import it at config time — use { durableObjects } from
 * "@emdash-cms/cloudflare" instead.
 */

import { env } from "cloudflare:workers";
import { kyselyLogOption, recordRpc } from "emdash/database/instrumentation";
import { type Dialect, Kysely } from "kysely";

import { CoalescingDOSqlDialect } from "./coalescing-do-sql.js";
import type { EmDashDB } from "./do-sql-class.js";
import { type BookmarkSink, DOSqlDialect } from "./do-sql-dialect.js";
import type { DurableObjectsConfig, EmDashDBStub } from "./do-sql-types.js";

const DEFAULT_NAME = "emdash";
const DEFAULT_BOOKMARK_COOKIE = "__em_do_bookmark";

/**
 * Replication bookmarks are opaque. We don't validate their shape (a tighter
 * check risks rejecting a future encoding and silently degrading
 * read-your-writes), but we cap length and reject control characters so a
 * malicious or corrupt cookie can't smuggle anything into the RPC.
 */
const MAX_BOOKMARK_LENGTH = 1024;

function hasControlChars(value: string): boolean {
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code < 0x20 || code === 0x7f) return true;
	}
	return false;
}

function getNamespace(config: DurableObjectsConfig): DurableObjectNamespace<EmDashDB> | null {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Worker binding accessed from untyped env object
	const ns = (env as Record<string, unknown>)[config.binding] as
		| DurableObjectNamespace<EmDashDB>
		| undefined;
	return ns ?? null;
}

function bindingError(binding: string): Error {
	return new Error(
		`Durable Object binding "${binding}" not found in environment. ` +
			`Check your wrangler.jsonc configuration:\n\n` +
			`"durable_objects": {\n` +
			`  "bindings": [{ "name": "${binding}", "class_name": "EmDashDB" }]\n` +
			`},\n` +
			`"migrations": [{ "tag": "v1", "new_sqlite_classes": ["EmDashDB"] }]\n\n` +
			`For read replication also set:\n` +
			`"compatibility_flags": ["experimental", "replica_routing"]`,
	);
}

/**
 * Bookmark sinks for the non-request-scoped dialects, keyed by DO identity.
 *
 * Read-after-write on the DO backend rides a bookmark: a write records the
 * current bookmark; a later read passes it so a replica blocks until it has
 * caught up. The singleton (migrations, scheduled tasks) and the cold-start
 * read connection both need to see each other's writes — a migration runs on
 * the singleton, then the runtime's cold-start reads must observe it — so they
 * share one sink per DO. Bookmarks are global to the database, so the sink is
 * valid across the fresh-per-query stubs each dialect resolves.
 *
 * Best-effort under concurrency: bookmarks are opaque, so out-of-order writes
 * can leave the sink pointing at an older bookmark and a later read served
 * slightly stale. It never loses or corrupts a write. Request traffic is
 * unaffected — it uses isolated per-request sinks in `createRequestScopedDb`.
 */
// Stored on globalThis behind a Symbol key so Vite SSR chunk duplication can't
// produce two maps — the singleton dialect and the cold-start coalescing dialect
// must resolve the *same* BookmarkSink object to share read-your-writes state
// (same pattern as core's request-cache.ts / settings/index.ts).
const SINGLETON_BOOKMARK_SINKS_KEY = Symbol.for("emdash:do-singleton-bookmark-sinks");
const g = globalThis as Record<symbol, unknown>;
const singletonBookmarkSinks: Map<string, BookmarkSink> =
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- globalThis singleton pattern (see core request-cache.ts)
	(g[SINGLETON_BOOKMARK_SINKS_KEY] as Map<string, BookmarkSink> | undefined) ??
	(() => {
		const m = new Map<string, BookmarkSink>();
		g[SINGLETON_BOOKMARK_SINKS_KEY] = m;
		return m;
	})();

function getSingletonBookmarkSink(config: DurableObjectsConfig): BookmarkSink {
	const key = `${config.binding}:${config.name ?? DEFAULT_NAME}`;
	let sink = singletonBookmarkSinks.get(key);
	if (!sink) {
		sink = {};
		singletonBookmarkSinks.set(key, sink);
	}
	return sink;
}

/**
 * Create a DO SQL dialect from config. Used for the singleton Kysely instance
 * (runtime-init migrations, scheduled tasks, and any query outside a request
 * scope).
 *
 * This dialect is cached across requests on globalThis, so it must NOT hold a
 * stub: a DO stub is a per-request I/O object. We resolve a fresh stub on every
 * query instead. The hot read/write path uses `createRequestScopedDb`, which
 * reuses one stub for the whole request.
 */
export function createDialect(config: DurableObjectsConfig): Dialect {
	const ns = getNamespace(config);
	if (!ns) throw bindingError(config.binding);
	const id = ns.idFromName(config.name ?? DEFAULT_NAME);
	return new DOSqlDialect({
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Rpc type limitation with unknown row types
		resolveStub: () => ns.get(id) as unknown as EmDashDBStub,
		bookmarkSink: getSingletonBookmarkSink(config),
		onRpc: recordRpc,
	});
}

/**
 * Coalescing DO SQL dialect for the runtime's cold-start read phase, where the
 * core runtime batches its init reads into one `batchQuery` RPC. Shares the
 * singleton's bookmark sink so reads issued right after a migration (run on the
 * singleton) wait for the replica to catch up — read-your-writes across the two
 * connections. Resolves a fresh stub per query like {@link createDialect}. Each
 * call returns a fresh dialect; this must never back the long-lived singleton,
 * whose coalescing buffer would be shared across requests.
 */
export function createCoalescingDialect(config: DurableObjectsConfig): Dialect {
	const ns = getNamespace(config);
	if (!ns) throw bindingError(config.binding);
	const id = ns.idFromName(config.name ?? DEFAULT_NAME);
	return new CoalescingDOSqlDialect({
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Rpc type limitation with unknown row types
		resolveStub: () => ns.get(id) as unknown as EmDashDBStub,
		bookmarkSink: getSingletonBookmarkSink(config),
		onRpc: recordRpc,
	});
}

// =========================================================================
// Read-replica request scoping
//
// createRequestScopedDb is called by the core middleware on each request.
// When session is "auto" it returns a per-request Kysely that holds one DO
// stub for the whole request, plus a commit() that persists the resulting
// replication bookmark as a cookie for authenticated users (read-your-writes).
// =========================================================================

interface CookieJar {
	get(name: string): { value: string } | undefined;
	set(name: string, value: string, options: Record<string, unknown>): void;
}

export interface RequestScopedDbOpts {
	config: DurableObjectsConfig;
	isAuthenticated: boolean;
	/**
	 * Whether this request mutates. Part of the shared adapter contract (the D1
	 * adapter pins writes to `first-primary`). The DO backend does NOT use it for
	 * routing: DO exposes no Worker-side "give me the primary" handle -- a write
	 * is proxied to the primary by the DO itself, and read-your-writes is
	 * provided by the per-request bookmark feedback (a write records its bookmark
	 * in the sink; later reads in the same request wait for it). So correctness
	 * doesn't depend on knowing up front that the request writes.
	 */
	isWrite: boolean;
	cookies: CookieJar;
	url: URL;
}

export interface RequestScopedDb {
	db: Kysely<any>;
	commit: () => void;
}

export function createRequestScopedDb(opts: RequestScopedDbOpts): RequestScopedDb | null {
	if (opts.config?.session !== "auto") return null;
	const ns = getNamespace(opts.config);
	if (!ns) return null;

	const id = ns.idFromName(opts.config.name ?? DEFAULT_NAME);
	const cookieName = opts.config.bookmarkCookie ?? DEFAULT_BOOKMARK_COOKIE;

	// One stub for the entire request, resolved lazily inside the request's
	// I/O context and reused across every query. This is the key latency win
	// over a per-query stub.
	let stub: EmDashDBStub | undefined;
	const resolveStub = (): EmDashDBStub => {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Rpc type limitation with unknown row types
		return (stub ??= ns.get(id) as unknown as EmDashDBStub);
	};

	// Authenticated read-your-writes: pass the client's last bookmark on reads
	// so a replica waits until it has caught up before serving. Anonymous
	// readers can't resume across requests, so they always read nearest-replica.
	let readBookmark: string | undefined;
	if (opts.isAuthenticated) {
		const bookmark = opts.cookies.get(cookieName)?.value;
		if (
			bookmark &&
			bookmark.length > 0 &&
			bookmark.length <= MAX_BOOKMARK_LENGTH &&
			!hasControlChars(bookmark)
		) {
			readBookmark = bookmark;
		}
	}

	// The per-request path always coalesces: same-turn SELECTs become one
	// batchQuery RPC instead of one round trip per read. (The singleton in
	// createDialect uses the plain DOSqlDialect -- it must never coalesce, since
	// concurrent requests would share a buffer.)
	const bookmarkSink: BookmarkSink = {};
	const db = new Kysely<any>({
		dialect: new CoalescingDOSqlDialect({
			resolveStub,
			readBookmark,
			bookmarkSink,
			onRpc: recordRpc,
		}),
		log: kyselyLogOption(),
	});

	return {
		db,
		commit() {
			// Only authenticated users benefit from resuming a bookmark.
			if (!opts.isAuthenticated) return;
			const newBookmark = bookmarkSink.latest;
			if (!newBookmark) return;
			// Don't emit a cookie the browser will silently drop (~4 KB limit),
			// which would break read-your-writes with no signal. Bookmarks are
			// far smaller than this in practice; the guard is belt-and-braces.
			if (newBookmark.length > MAX_BOOKMARK_LENGTH) return;
			opts.cookies.set(cookieName, newBookmark, {
				path: "/",
				httpOnly: true,
				sameSite: "lax",
				secure: opts.url.protocol === "https:",
				// Bound the lifetime so a stale bookmark can't linger indefinitely.
				maxAge: 60 * 60 * 24,
			});
		},
	};
}

// Re-export the DO class so consumers can register it in their worker entry.
export { EmDashDB } from "./do-sql-class.js";
