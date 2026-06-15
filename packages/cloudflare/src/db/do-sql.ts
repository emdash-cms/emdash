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
import { kyselyLogOption } from "emdash/database/instrumentation";
import { type Dialect, Kysely } from "kysely";

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
 * Create a DO SQL dialect from config. Used for the singleton Kysely instance
 * (runtime-init migrations and any query outside a request scope).
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

	const bookmarkSink: BookmarkSink = {};
	const db = new Kysely<any>({
		dialect: new DOSqlDialect({ resolveStub, readBookmark, bookmarkSink }),
		log: kyselyLogOption(),
	});

	return {
		db,
		commit() {
			// Only authenticated users benefit from resuming a bookmark.
			if (!opts.isAuthenticated) return;
			const newBookmark = bookmarkSink.latest;
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

// Re-export the DO class so consumers can register it in their worker entry.
export { EmDashDB } from "./do-sql-class.js";
