/**
 * Kysely dialect that runs SQL in-process against the SQLite storage of the
 * Durable Object that renders the site (see worker.ts). Queries never leave
 * the isolate, so a page render pays no per-query round trip.
 *
 * The site uses a single DO instance, so its storage is registered once on
 * globalThis when the object is constructed.
 */

import type { CollectionDeletionGuardInput, CollectionDeletionGuardResult } from "emdash";
import {
	type CompiledQuery,
	type DatabaseConnection,
	type Dialect,
	type Driver,
	type Kysely,
	type QueryResult,
	type TableMetadata,
	SqliteAdapter,
	SqliteIntrospector,
	SqliteQueryCompiler,
} from "kysely";

const STORAGE_KEY = Symbol.for("emdash-do-render:storage");
const globals = globalThis as Record<symbol, DurableObjectStorage | undefined>;
const READ_PATTERN = /^\s*(select|with|pragma\s+table_info|explain)\b/i;
const SLUG_PATTERN = /^[a-z][a-z0-9_]*$/;

export function registerStorage(objectStorage: DurableObjectStorage): void {
	globals[STORAGE_KEY] = objectStorage;
}

function storage(): DurableObjectStorage {
	const registered = globals[STORAGE_KEY];
	if (!registered) throw new Error("SQL is only available inside the site Durable Object");
	return registered;
}

function run(sql: SqlStorage, query: CompiledQuery): QueryResult<unknown> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely compiles only SQLite-bindable values
	const cursor = sql.exec(query.sql, ...(query.parameters as SqlStorageValue[]));
	const rows = cursor.toArray();
	// A write CTE starts like a read; rowsWritten catches it.
	if (READ_PATTERN.test(query.sql) && cursor.rowsWritten === 0) return { rows };
	// rowsWritten also counts index and trigger writes, so it is not the affected-row count.
	const changes = Number(sql.exec("SELECT changes() AS c").one().c);
	return { rows, numAffectedRows: BigInt(changes) };
}

class LocalConnection implements DatabaseConnection {
	async executeQuery<O>(query: CompiledQuery): Promise<QueryResult<O>> {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- Kysely trusts row shapes from the driver
		return run(storage().sql, query) as QueryResult<O>;
	}

	// oxlint-disable-next-line require-yield -- interface requires a generator
	async *streamQuery<O>(): AsyncIterableIterator<QueryResult<O>> {
		throw new Error("Streaming queries are not supported");
	}
}

class LocalDriver implements Driver {
	async init() {}
	async acquireConnection() {
		return new LocalConnection();
	}
	// EmDash's withTransaction() falls back to direct execution on this exact message.
	async beginTransaction(): Promise<never> {
		throw new Error("Transactions are not supported");
	}
	async commitTransaction(): Promise<never> {
		throw new Error("Transactions are not supported");
	}
	async rollbackTransaction(): Promise<never> {
		throw new Error("Transactions are not supported");
	}
	async releaseConnection() {}
	async destroy() {}
}

class LocalAdapter extends SqliteAdapter {
	async executeAtomicBatch(queries: readonly CompiledQuery[]) {
		const objectStorage = storage();
		return objectStorage.transactionSync(() =>
			queries.map((query) => run(objectStorage.sql, query)),
		);
	}
}

// DO SQLite denies reads of its internal `_cf_*` tables (SQLITE_AUTH).
class LocalIntrospector extends SqliteIntrospector {
	override async getTables(
		options: { withInternalKyselyTables?: boolean } = {},
	): Promise<TableMetadata[]> {
		const { sql } = storage();
		const hidden = options.withInternalKyselyTables
			? []
			: ["kysely_migration", "kysely_migration_lock"];
		const tables = sql
			.exec<{ name: string; type: string }>(
				"SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' AND substr(name, 1, 4) <> '_cf_' ORDER BY name",
			)
			.toArray()
			.filter((table) => !hidden.includes(table.name));
		return tables.map((table) => {
			const columns = sql
				.exec<{
					name: string;
					type: string;
					notnull: number;
					dflt_value: string | null;
					pk: number;
				}>(
					'SELECT name, type, "notnull", dflt_value, pk FROM pragma_table_info(?) ORDER BY cid',
					table.name,
				)
				.toArray();
			const primary = columns.filter((column) => column.pk > 0);
			const autoIncrement =
				primary.length === 1 && primary[0]?.type.toLowerCase() === "integer"
					? primary[0].name
					: undefined;
			return {
				name: table.name,
				isView: table.type === "view",
				isForeign: false,
				columns: columns.map((column) => ({
					name: column.name,
					dataType: column.type,
					isNullable: !column.notnull,
					isAutoIncrementing: column.name === autoIncrement,
					hasDefaultValue: column.dflt_value != null,
				})),
			};
		});
	}
}

export function createDialect(): Dialect {
	return {
		createAdapter: () => new LocalAdapter(),
		createDriver: () => new LocalDriver(),
		createQueryCompiler: () => new SqliteQueryCompiler(),
		createIntrospector: (db: Kysely<unknown>) => new LocalIntrospector(db),
	};
}

/** Same contract as `EmDashDB.executeCollectionDeletionGuard` in @emdash-cms/cloudflare. */
export async function executeCollectionDeletionGuard(
	_config: unknown,
	input: CollectionDeletionGuardInput,
): Promise<CollectionDeletionGuardResult> {
	if (!input.collectionId || !input.leaseToken) {
		throw new Error("Collection deletion guard requires a collection ID and lease token");
	}
	if (!SLUG_PATTERN.test(input.collectionSlug) || input.collectionSlug.length > 63) {
		throw new Error("Collection deletion guard requires a valid collection slug");
	}
	const objectStorage = storage();
	const { sql } = objectStorage;
	return objectStorage.transactionSync((): CollectionDeletionGuardResult => {
		const guard = sql.exec(
			`SELECT collection_id FROM _emdash_media_usage_collection_deletions
			 WHERE collection_id = ? AND collection_slug = ? AND state = 'leased' AND phase = ?
			   AND lease_token = ? AND lease_expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`,
			input.collectionId,
			input.collectionSlug,
			input.action === "fence" ? "fence" : "table",
			input.leaseToken,
		);
		if (guard.toArray().length !== 1) return { outcome: "stale" };

		const contentTable = `ec_${input.collectionSlug}`;
		if (input.action === "fence") {
			if (!input.forceDelete) {
				const content = sql.exec(
					`SELECT 1 FROM "${contentTable}" WHERE deleted_at IS NULL LIMIT 1`,
				);
				if (content.toArray().length > 0) return { outcome: "has_content" };
			}
			sql.exec(
				`UPDATE _emdash_media_usage_index_status
				 SET capture_state = 'deleting', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
				 WHERE adapter_id = 'content-media' AND scope_type = 'collection' AND scope_key = ?
				   AND collection_id = ? AND capture_state = 'active'
				   AND EXISTS (SELECT 1 FROM _emdash_collections WHERE id = ? AND slug = ?)`,
				input.collectionSlug,
				input.collectionId,
				input.collectionId,
				input.collectionSlug,
			);
			const changes = Number(sql.exec("SELECT changes() AS c").one().c);
			return changes === 1 ? { outcome: "fenced" } : { outcome: "stale" };
		}

		const ftsTable = `_emdash_fts_${input.collectionSlug}`;
		for (const suffix of ["insert", "update", "delete"]) {
			sql.exec(`DROP TRIGGER IF EXISTS "${ftsTable}_${suffix}"`);
		}
		sql.exec(`DROP TABLE IF EXISTS "${ftsTable}"`);
		sql.exec(`DROP TABLE IF EXISTS "${contentTable}"`);
		return { outcome: "dropped" };
	});
}
