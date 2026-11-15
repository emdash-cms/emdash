type PrimarySession = Pick<D1DatabaseSession, "prepare" | "batch" | "getBookmark">;

/**
 * `first-primary` only constrains a session's first operation. Authoritative
 * reads need a fresh session per operation so an earlier request's bookmark
 * cannot restore stale state after waiting for a reconciliation lock.
 */
export function createPrimaryD1Session(binding: D1Database): PrimarySession {
	let bookmark: string | null = null;
	let operationSequence = 0;
	let bookmarkSequence = 0;
	const statements = new WeakMap<D1PreparedStatement, { sql: string; parameters: unknown[] }>();

	async function execute<T>(run: (session: D1DatabaseSession) => Promise<T>): Promise<T> {
		const sequence = ++operationSequence;
		const session = binding.withSession("first-primary");
		try {
			return await run(session);
		} finally {
			const nextBookmark = session.getBookmark?.();
			if (nextBookmark && sequence > bookmarkSequence) {
				bookmark = nextBookmark;
				bookmarkSequence = sequence;
			}
		}
	}

	function prepare(sql: string, parameters: unknown[] = []): D1PreparedStatement {
		const withStatement = <T>(run: (statement: D1PreparedStatement) => Promise<T>) =>
			execute((session) => run(session.prepare(sql).bind(...parameters)));
		const wrapped = {
			bind(...values: unknown[]): D1PreparedStatement {
				return prepare(sql, values);
			},
			all<T>(): Promise<D1Result<T>> {
				return withStatement((statement) => statement.all<T>());
			},
			run<T>(): Promise<D1Result<T>> {
				return withStatement((statement) => statement.run<T>());
			},
			first<T>(column?: string): Promise<T | null> {
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- mirrors D1PreparedStatement.first overloads
				return withStatement((statement) =>
					column === undefined ? statement.first<T>() : statement.first(column),
				) as Promise<T | null>;
			},
			raw<T>(options?: { columnNames?: boolean }): Promise<T[]> {
				// eslint-disable-next-line typescript/no-unsafe-type-assertion -- mirrors D1PreparedStatement.raw overloads
				return withStatement((statement) =>
					// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the boolean columnNames option is represented by D1's overload pair
					statement.raw(options as { columnNames: true }),
				) as Promise<T[]>;
			},
		};
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- overload-compatible D1 statement wrapper
		const statement = wrapped as unknown as D1PreparedStatement;
		statements.set(statement, { sql, parameters });
		return statement;
	}

	return {
		prepare,
		batch<T>(batch: D1PreparedStatement[]): Promise<D1Result<T>[]> {
			return execute((session) =>
				session.batch<T>(
					batch.map((statement) => {
						const meta = statements.get(statement);
						if (!meta) throw new Error("D1 primary batch contains a statement from another scope");
						return session.prepare(meta.sql).bind(...meta.parameters);
					}),
				),
			);
		},
		getBookmark: () => bookmark,
	};
}
