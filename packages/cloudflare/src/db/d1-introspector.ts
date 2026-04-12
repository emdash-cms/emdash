/**
 * D1-compatible SQLite Introspector
 *
 * D1 doesn't allow the correlated cross-join pattern that Kysely's default
 * SqliteIntrospector uses: `FROM tl, pragma_table_info(tl.name)`
 *
 * This introspector queries tables individually instead.
 */

import type {
	DatabaseIntrospector,
	DatabaseMetadata,
	Kysely,
	SchemaMetadata,
	TableMetadata,
} from "kysely";
import { sql } from "kysely";

// Kysely's default migration table names
const DEFAULT_MIGRATION_TABLE = "kysely_migration";
const DEFAULT_MIGRATION_LOCK_TABLE = "kysely_migration_lock";

type IntrospectorShape = Record<string, Record<string, unknown>>;

// Regex patterns for parsing CREATE TABLE statements
const SPLIT_PARENS_PATTERN = /[(),]/;
const WHITESPACE_PATTERN = /\s+/;
const QUOTES_PATTERN = /["`]/g;

export class D1Introspector<DB extends object = IntrospectorShape> implements DatabaseIntrospector {
	readonly #db: Kysely<DB & IntrospectorShape>;

	constructor(db: Kysely<DB>) {
		this.#db = db as Kysely<DB & IntrospectorShape>;
	}

	async getSchemas(): Promise<SchemaMetadata[]> {
		// SQLite doesn't support schemas
		return [];
	}

	async getTables(options: { withInternalKyselyTables?: boolean } = {}): Promise<TableMetadata[]> {
		// Get table names from sqlite_master
		let query = this.#db
			.selectFrom("sqlite_master")
			.where("type", "in", ["table", "view"])
			.where("name", "not like", "sqlite_%")
			.where("name", "not like", "_cf_%") // Skip Cloudflare internal tables
			.select(["name", "sql", "type"])
			.orderBy("name");

		if (!options.withInternalKyselyTables) {
			query = query
				.where("name", "!=", DEFAULT_MIGRATION_TABLE)
				.where("name", "!=", DEFAULT_MIGRATION_LOCK_TABLE);
		}

		const tables = await query.execute();

		// Query each table's columns individually (avoiding the problematic cross-join)
		const result: TableMetadata[] = [];

		for (const table of tables) {
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Kysely's DatabaseIntrospector returns untyped results
			const tableName = table.name as string;
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Kysely's DatabaseIntrospector returns untyped results
			const tableType = table.type as string;
			// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- Kysely's DatabaseIntrospector returns untyped results
			const tableSql = table.sql as string | null;

			// Get columns for this specific table
			// Use sql.raw() to insert table name directly into query string
			// D1 doesn't allow parameterized table names in pragma_table_info()
			// Note: tableName comes from sqlite_master so it's safe
			const columns = await sql<{
				cid: number;
				name: string;
				type: string;
				notnull: number;
				dflt_value: string | null;
				pk: number;
			}>`SELECT * FROM pragma_table_info('${sql.raw(tableName)}')`.execute(this.#db);

			// Try to find autoincrement column from CREATE TABLE statement
			let autoIncrementCol = tableSql
				?.split(SPLIT_PARENS_PATTERN)
				?.find((it) => it.toLowerCase().includes("autoincrement"))
				?.trimStart()
				?.split(WHITESPACE_PATTERN)?.[0]
				?.replace(QUOTES_PATTERN, "");

			// Otherwise, check for INTEGER PRIMARY KEY (implicit autoincrement)
			if (!autoIncrementCol) {
				const pkCols = columns.rows.filter((r) => r.pk > 0);
				if (pkCols.length === 1 && pkCols[0]!.type.toLowerCase() === "integer") {
					autoIncrementCol = pkCols[0]!.name;
				}
			}

			result.push({
				name: tableName,
				isView: tableType === "view",
				columns: columns.rows.map((col) => ({
					name: col.name,
					dataType: col.type,
					isNullable: !col.notnull,
					isAutoIncrementing: col.name === autoIncrementCol,
					hasDefaultValue: col.dflt_value != null,
					comment: undefined,
				})),
			});
		}

		return result;
	}

	async getMetadata(options?: { withInternalKyselyTables?: boolean }): Promise<DatabaseMetadata> {
		return {
			tables: await this.getTables(options),
		};
	}
}
