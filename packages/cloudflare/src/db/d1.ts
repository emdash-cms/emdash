/**
 * Cloudflare D1 runtime adapter - RUNTIME ENTRY
 *
 * Creates a Kysely dialect for D1 and, when read replication is enabled,
 * a per-request Kysely bound to a D1 Sessions-API session.
 *
 * This module imports directly from cloudflare:workers to access the D1 binding.
 * Do NOT import this at config time - use { d1 } from "@emdash-cms/cloudflare" instead.
 */

import { env } from "cloudflare:workers";
import { type DatabaseIntrospector, type Dialect, Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";

import { D1Introspector } from "./d1-introspector.js";

/**
 * D1 configuration (runtime type — matches the config-time type in index.ts)
 */
interface D1Config {
	binding: string;
	session?: "disabled" | "auto" | "primary-first";
	bookmarkCookie?: string;
}

const DEFAULT_BOOKMARK_COOKIE = "__em_d1_bookmark";

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
 * Custom D1 Dialect that uses our D1-compatible introspector
 *
 * The default kysely-d1 dialect uses SqliteIntrospector which does a
 * cross-join with pragma_table_info() that D1 doesn't allow.
 */
class EmDashD1Dialect extends D1Dialect {
	override createIntrospector(db: Kysely<any>): DatabaseIntrospector {
		return new D1Introspector(db);
	}
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
		throw new Error(
			`D1 binding "${config.binding}" not found in environment. ` +
				`Check your wrangler.jsonc configuration:\n\n${example}`,
		);
	}
	return new EmDashD1Dialect({ database: db });
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
}

/**
 * Create a per-request session-backed Kysely, or null when D1 sessions are
 * disabled or the binding is missing. Core middleware calls this once per
 * request, stashes `db` in ALS for the duration of next(), then invokes
 * `commit()` on the response path.
 */
export function createRequestScopedDb(opts: RequestScopedDbOpts): RequestScopedDb | null {
	if (!isSessionEnabled(opts.config)) return null;
	const binding = getBinding(opts.config);
	if (!binding || typeof binding.withSession !== "function") return null;

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
	// both of which D1DatabaseSession implements.
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- session is structurally compatible with the subset D1Dialect uses
	const sessionAsDatabase = session as unknown as D1Database;
	const db = new Kysely<any>({ dialect: new EmDashD1Dialect({ database: sessionAsDatabase }) });

	return {
		db,
		commit() {
			// Anonymous sessions can't resume across requests, so there's no
			// value in persisting a bookmark for them.
			if (!opts.isAuthenticated) return;
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

function isSessionEnabled(config: D1Config): boolean {
	return !!config.session && config.session !== "disabled";
}

function getBinding(config: D1Config): D1Database | null {
	// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Worker binding accessed from untyped env object
	const db = (env as Record<string, unknown>)[config.binding] as D1Database | undefined;
	return db ?? null;
}
