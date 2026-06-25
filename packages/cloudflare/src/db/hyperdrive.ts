/**
 * Cloudflare Hyperdrive runtime adapter - RUNTIME ENTRY
 *
 * Hyperdrive pools and accelerates connections to an existing PostgreSQL
 * (or PostgreSQL-compatible, e.g. PlanetScale Postgres) database, letting a
 * Worker reach it over Cloudflare's network with connection pooling and
 * query caching.
 *
 * Connection lifecycle on Workers
 * --------------------------------
 * A Worker isolate handles many requests, but a database connection (a TCP
 * socket) is bound to the request that opened it — it cannot be reused by a
 * later request. A module-global `pg.Pool` therefore breaks: the first request
 * works, then subsequent requests reusing the isolate's stale pool hang or
 * error with "Cannot perform I/O on behalf of a different request".
 *
 * So this adapter is request-scoped: `createRequestScopedDb` builds a fresh
 * `pg.Pool` + Kysely for each request and closes it once the response body has
 * finished streaming. EmDash's middleware stashes that per-request Kysely in
 * ALS, and the runtime/loader db getters prefer it over the singleton — so all
 * request-path queries use a connection opened in the current request.
 *
 * `createDialect` still builds the per-isolate singleton Kysely. Its socket is
 * opened by whatever event first queries it — normally the cold-start
 * migrations during the first HTTP request — and, because a pg socket is bound
 * to the request that opened it, it is only safe to use again from within that
 * same event. The request path never does: routes and loaders read through the
 * per-request scoped Kysely (ALS), not the singleton.
 *
 * Known limitation — background and plugin paths still use the singleton
 * --------------------------------------------------------------------------
 * Several subsystems capture the runtime's singleton db at construction and do
 * not consult the per-request scoped connection:
 *   - the Cron Trigger handler (`scheduled()` → scheduled publishing, plugin
 *     cron, system cleanup),
 *   - plugin hook contexts (a hook's `content` / `media` / `users` / `cron`
 *     access),
 *   - media providers and sandboxed plugins.
 *
 * On a warm isolate the singleton's socket belongs to an earlier request, so
 * these paths can fail under workerd's cross-request I/O guard ("Cannot perform
 * I/O on behalf of a different request"). It is not a data-corruption risk — the
 * work errors and is logged — but it means scheduled publishing and
 * database-querying plugin hooks are not yet supported on the Hyperdrive
 * adapter. The core read/write path (pages, content API routes, loaders) is
 * unaffected. Closing this requires the core runtime to thread an event-scoped
 * connection through those subsystems; tracked in
 * https://github.com/emdash-cms/emdash/issues/1622. Until then, use D1 for
 * deployments that rely on Cron Triggers or DB-querying plugins.
 *
 * This module imports directly from cloudflare:workers to access the binding.
 * Do NOT import it at config time — use { hyperdrive } from
 * "@emdash-cms/cloudflare" instead.
 *
 * Requirements (set in the consuming site's wrangler config):
 * - `compatibility_flags: ["nodejs_compat"]`
 * - `compatibility_date >= "2024-09-23"`
 * - `pg >= 8.16.3` installed in the site
 */

import { env, waitUntil } from "cloudflare:workers";
import { kyselyLogOption } from "emdash/database/instrumentation";
import { type Dialect, Kysely, PostgresDialect } from "kysely";
// `pg` is provided by the consuming site (an optional peer of `emdash`); it is
// kept external from this package's bundle.
import { Pool } from "pg";

/**
 * Hyperdrive configuration (runtime type — matches the config-time type in
 * index.ts).
 */
interface HyperdriveConfig {
	binding: string;
	max?: number;
}

/**
 * Minimal shape of a Hyperdrive binding. Workers inject `connectionString`
 * (and the discrete parts) at runtime; we only need the string for pg.
 */
interface HyperdriveBinding {
	connectionString: string;
}

const DEFAULT_MAX = 5;

/**
 * Build a fresh node-postgres Pool for the given connection string.
 *
 * Hyperdrive owns the real pool to the origin; the in-Worker pool just feeds
 * connections to the current request. The per-request pool is closed
 * explicitly once the response has streamed (see `close()` in
 * `createRequestScopedDb`), so no idle-reaper is needed.
 */
function createPool(connectionString: string, max: number): Pool {
	return new Pool({
		connectionString,
		max,
		// Disable pg's idle-reaper timer. In workerd a socket is owned by the
		// request that opened it; a background timer set in one request that
		// later fires and touches that socket performs I/O "on behalf of a
		// different request", which workerd hangs on. Pools are torn down
		// explicitly instead, so the reaper is unnecessary.
		idleTimeoutMillis: 0,
	});
}

/**
 * Create a PostgreSQL dialect backed by a Hyperdrive binding.
 *
 * Used for the per-isolate singleton Kysely. The request path never touches it
 * (it reads through `createRequestScopedDb`); in practice the singleton serves
 * cold-start migrations, plus the background/plugin paths noted in the module
 * header that are not yet safe across event boundaries on this adapter.
 */
export function createDialect(config: HyperdriveConfig): Dialect {
	const binding = requireBinding(config);
	// Cold-start migrations are sequential, so a single connection is enough,
	// and keeping it to 1 leaves the bulk of Hyperdrive's connection budget for
	// the per-request pools.
	return new PostgresDialect({ pool: createPool(binding.connectionString, 1) });
}

/**
 * A cookie interface minimally compatible with Astro's AstroCookies. Declared
 * here (not imported from astro) so this module stays free of astro types.
 */
interface CookieJar {
	get(name: string): { value: string } | undefined;
	set(name: string, value: string, options: Record<string, unknown>): void;
}

export interface RequestScopedDbOpts {
	config: HyperdriveConfig;
	isAuthenticated: boolean;
	isWrite: boolean;
	cookies: CookieJar;
	url: URL;
}

export interface RequestScopedDb {
	/** Per-request Kysely instance backed by a fresh pg Pool. */
	db: Kysely<any>;
	/**
	 * No per-request state to persist (Hyperdrive routes and caches itself, so
	 * there are no bookmark cookies). Kept to satisfy the adapter contract.
	 */
	commit: () => void;
	/**
	 * Close the per-request pool. The middleware calls this once the response
	 * body has fully streamed — not before — because Astro streams HTML and the
	 * Live loader issues queries while the body streams; tearing the pool down
	 * any earlier yields "driver has already been destroyed". Draining is handed
	 * to `waitUntil` so it never blocks, while the socket stays valid for the
	 * whole request it was opened in.
	 */
	close: () => void;
}

/**
 * Create a fresh, request-scoped Kysely backed by its own pg Pool. EmDash
 * middleware calls this once per request, stashes `db` in ALS for the duration
 * of next(), then closes it once the response body has streamed.
 *
 * Hyperdrive itself routes reads/writes and handles caching, so this adapter
 * does not need bookmark cookies or read-replica constraints — every request
 * gets an equivalent connection.
 */
export function createRequestScopedDb(opts: RequestScopedDbOpts): RequestScopedDb | null {
	const binding = getBinding(opts.config);
	// No binding at runtime: fall back to the singleton path (which will throw
	// a descriptive error if the binding is genuinely missing).
	if (!binding?.connectionString) return null;

	const pool = createPool(binding.connectionString, opts.config.max ?? DEFAULT_MAX);
	const db = new Kysely<any>({
		dialect: new PostgresDialect({ pool }),
		// Mirror the D1 adapter and the runtime singleton: route per-request
		// queries through the instrumentation logger so db.* Server-Timing
		// counters and EMDASH_QUERY_LOG capture Hyperdrive queries too. The
		// singleton built by createDialect gets this from core (it wraps the
		// dialect in a logged Kysely), but this request-scoped Kysely is built
		// here, so it must opt in itself.
		log: kyselyLogOption(),
	});

	let closed = false;
	return {
		db,
		// No bookmark/cookie state for Hyperdrive.
		commit() {},
		close() {
			if (closed) return;
			closed = true;
			// Destroy the Kysely (and its pool) once the body has streamed.
			// waitUntil keeps the isolate alive to drain without delaying the
			// response. The socket was opened in this request and is closed within
			// it, so there's no cross-request I/O.
			waitUntil(
				db.destroy().catch((error: unknown) => {
					console.error("[emdash][hyperdrive] failed to close request pool:", error);
				}),
			);
		},
	};
}

function getBinding(config: HyperdriveConfig): HyperdriveBinding | null {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- Worker binding accessed from untyped env object
	const binding = (env as Record<string, unknown>)[config.binding] as HyperdriveBinding | undefined;
	return binding ?? null;
}

function requireBinding(config: HyperdriveConfig): HyperdriveBinding {
	const binding = getBinding(config);
	if (!binding) {
		const example = JSON.stringify(
			{ hyperdrive: [{ binding: config.binding, id: "<your-hyperdrive-id-here>" }] },
			null,
			2,
		);
		throw new Error(
			`Hyperdrive binding "${config.binding}" not found in environment. ` +
				`Check your wrangler.jsonc configuration:\n\n${example}\n\n` +
				`Hyperdrive also requires compatibility_flags: ["nodejs_compat"] and ` +
				`compatibility_date >= "2024-09-23".`,
		);
	}
	if (!binding.connectionString) {
		throw new Error(
			`Hyperdrive binding "${config.binding}" is present but has no connectionString. ` +
				`Ensure the binding points at a valid Hyperdrive configuration.`,
		);
	}
	return binding;
}
