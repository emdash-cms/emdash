/**
 * Hang guard for D1 Sessions API databases.
 *
 * With the `global_fetch_strictly_public` compatibility flag set, the
 * internal request the D1 Sessions API makes to route queries to read
 * replicas is silently blocked by the runtime's fetch-isolation policy:
 * every query issued through `withSession()` hangs until the Worker is
 * killed, with no error logged (`outcome: "canceled"`, empty exceptions).
 * See https://github.com/emdash-cms/emdash/issues/1273.
 *
 * The guard races session queries against a timeout while the session
 * transport's health is unknown (i.e. until the first query settles in this
 * isolate). On a hang it:
 *
 * - latches the isolate as "broken" and logs one descriptive error,
 * - transparently re-executes plain SELECTs on the direct (non-session)
 *   binding — reads are idempotent, so a late completion of the hung call
 *   is harmless,
 * - rejects anything else with a descriptive error rather than silently
 *   re-running a write that might still complete.
 *
 * Once latched, `createRequestScopedDb` skips sessions entirely for the
 * rest of the isolate's life, so only requests already holding a session
 * db pay the timeout. Once a query settles (success or SQL error — either
 * proves the transport round-trips), the guard steps aside and queries
 * pass through with zero overhead.
 */

/**
 * How long a session query may stay unsettled before the guard declares the
 * session transport broken. D1 queries normally settle in tens of
 * milliseconds; five seconds is far beyond any healthy p99 while still an
 * order of magnitude quicker than waiting for the Worker to be killed.
 * Only queries issued while health is still "unknown" are raced at all.
 */
const SESSION_HANG_TIMEOUT_MS = 5_000;

/**
 * Statements safe to re-execute after a timeout: plain SELECTs. Same
 * conservative pattern as the coalescing driver — `WITH` is excluded
 * because SQLite allows CTEs on writes.
 */
const SELECT_PATTERN = /^select\b/i;

type SessionHealth = "unknown" | "healthy" | "broken";

interface StatementMeta {
	/** The real session-bound statement. */
	statement: D1PreparedStatement;
	sql: string;
	params: unknown[];
}

type RaceOutcome<T> = { timedOut: false; value: T } | { timedOut: true };

/**
 * Race a promise against a timeout. Rejections propagate to the caller;
 * the timer is always cleared so it can't keep the isolate alive.
 */
async function raceTimeout<T>(promise: Promise<T>, ms: number): Promise<RaceOutcome<T>> {
	let timer: ReturnType<typeof setTimeout> | undefined;
	try {
		return await Promise.race([
			promise.then((value) => ({ timedOut: false as const, value })),
			new Promise<RaceOutcome<T>>((resolve) => {
				timer = setTimeout(resolve, ms, { timedOut: true });
			}),
		]);
	} finally {
		clearTimeout(timer);
	}
}

export interface D1SessionGuard {
	/**
	 * True once a session query has hung past the timeout in this isolate.
	 * `createRequestScopedDb` checks this to skip sessions for subsequent
	 * requests.
	 */
	isBroken(): boolean;
	/**
	 * Wrap a session-backed database so its queries are hang-guarded.
	 * `fallback` is the raw (non-session) binding used to re-execute reads
	 * after a hang.
	 */
	wrap(session: D1Database, fallback: D1Database): D1Database;
}

/**
 * Create a guard. One instance per isolate (module singleton in d1.ts);
 * tests create their own with a short timeout.
 */
export function createD1SessionGuard(timeoutMs: number = SESSION_HANG_TIMEOUT_MS): D1SessionGuard {
	let health: SessionHealth = "unknown";
	// Meta for statements produced by wrapped `prepare()`/`bind()`, so
	// `batch()` can unwrap them for the session call and rebuild them on the
	// fallback binding after a hang.
	const statementMeta = new WeakMap<D1PreparedStatement, StatementMeta>();

	function markBroken(): void {
		if (health === "broken") return;
		health = "broken";
		console.error(
			`[emdash] A D1 session query hung for ${timeoutMs}ms without settling. ` +
				"D1 read replica sessions appear to be broken in this environment — " +
				"falling back to the direct D1 binding and disabling sessions for the " +
				"rest of this isolate's life. Likely cause: the " +
				"`global_fetch_strictly_public` compatibility flag blocks the D1 " +
				"Sessions API (https://github.com/emdash-cms/emdash/issues/1273). " +
				'Remove the flag or set `d1({ session: "disabled" })` to silence this.',
		);
	}

	function markHealthy(): void {
		// A settled query (even a SQL error) proves the session transport
		// round-trips. Never un-latch "broken": requests created before the
		// latch may still race, and a late success must not re-enable sessions.
		if (health === "unknown") health = "healthy";
	}

	/**
	 * Execute `run` against the session statement, hang-guarded. On timeout,
	 * SELECTs are re-executed on the fallback binding; anything else rejects.
	 */
	async function guardedExec<T>(
		meta: StatementMeta,
		fallback: D1Database,
		run: (statement: D1PreparedStatement) => Promise<T>,
	): Promise<T> {
		if (health === "healthy") return run(meta.statement);
		const sessionCall = run(meta.statement);
		let outcome: RaceOutcome<T>;
		try {
			outcome = await raceTimeout(sessionCall, timeoutMs);
		} catch (error) {
			markHealthy();
			throw error;
		}
		if (!outcome.timedOut) {
			markHealthy();
			return outcome.value;
		}
		markBroken();
		// The hung call may still settle long after we've moved on; swallow it
		// so a late rejection doesn't surface as an unhandled rejection.
		sessionCall.catch(() => undefined);
		if (!SELECT_PATTERN.test(meta.sql.trim())) {
			throw new Error(
				`D1 session query hung for ${timeoutMs}ms and was abandoned. ` +
					"Refusing to re-run a non-SELECT statement on the direct binding " +
					"(the hung call might still complete, which would execute the " +
					"write twice). Retry the request — D1 sessions are now disabled " +
					"for this isolate.",
			);
		}
		return run(fallback.prepare(meta.sql).bind(...meta.params));
	}

	function wrapStatement(meta: StatementMeta, fallback: D1Database): D1PreparedStatement {
		const wrapped = {
			bind(...params: unknown[]): D1PreparedStatement {
				return wrapStatement(
					{ statement: meta.statement.bind(...params), sql: meta.sql, params },
					fallback,
				);
			},
			all<T>(): Promise<D1Result<T>> {
				return guardedExec(meta, fallback, (statement) => statement.all<T>());
			},
			raw<T>(options?: { columnNames?: boolean }): Promise<T[]> {
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- mirrors the D1PreparedStatement.raw overloads, which the generic passthrough can't express
				return guardedExec(meta, fallback, (statement) =>
					statement.raw(options as { columnNames: true }),
				) as Promise<T[]>;
			},
			first<T>(colName?: string): Promise<T | null> {
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- mirrors the D1PreparedStatement.first overloads, which the generic passthrough can't express
				return guardedExec(meta, fallback, (statement) =>
					colName === undefined ? statement.first<T>() : statement.first(colName),
				) as Promise<T | null>;
			},
			run<T>(): Promise<D1Result<T>> {
				return guardedExec(meta, fallback, (statement) => statement.run<T>());
			},
		};
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- structurally covers every D1PreparedStatement member the dialects use
		const statement = wrapped as unknown as D1PreparedStatement;
		statementMeta.set(statement, meta);
		return statement;
	}

	function wrap(session: D1Database, fallback: D1Database): D1Database {
		const wrapped = {
			prepare(sql: string): D1PreparedStatement {
				return wrapStatement({ statement: session.prepare(sql), sql, params: [] }, fallback);
			},
			async batch<T>(statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
				// Unwrap to the real session statements; statements not produced
				// by this guard (shouldn't happen) pass through untouched.
				const metas = statements.map(
					(statement) =>
						statementMeta.get(statement) ?? { statement, sql: "", params: [] as unknown[] },
				);
				const sessionStatements = metas.map((meta) => meta.statement);
				if (health === "healthy") return session.batch<T>(sessionStatements);
				const sessionCall = session.batch<T>(sessionStatements);
				let outcome: RaceOutcome<D1Result<T>[]>;
				try {
					outcome = await raceTimeout(sessionCall, timeoutMs);
				} catch (error) {
					markHealthy();
					throw error;
				}
				if (!outcome.timedOut) {
					markHealthy();
					return outcome.value;
				}
				markBroken();
				sessionCall.catch(() => undefined);
				// The coalescing driver only ever batches plain SELECTs, but
				// verify before re-running: a batch containing a write must not
				// execute twice.
				if (!metas.every((meta) => SELECT_PATTERN.test(meta.sql.trim()))) {
					throw new Error(
						`D1 session batch hung for ${timeoutMs}ms and was abandoned. ` +
							"Refusing to re-run it on the direct binding because it " +
							"contains non-SELECT statements. Retry the request — D1 " +
							"sessions are now disabled for this isolate.",
					);
				}
				return fallback.batch<T>(
					metas.map((meta) => fallback.prepare(meta.sql).bind(...meta.params)),
				);
			},
		};
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- structurally covers every D1Database member the dialects use (prepare/batch)
		return wrapped as unknown as D1Database;
	}

	return {
		isBroken: () => health === "broken",
		wrap,
	};
}
