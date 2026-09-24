/**
 * Per-operation index of package records, filled while analysis parses the
 * record streams, so cross-reference checks run as bounded SQL lookups
 * instead of holding the package in memory.
 *
 * Conventions for what analysis stores:
 * - `group_id`: the record's `translationGroup`, or its `id` when it has none
 *   (what `by: "group"` references resolve against);
 * - `name_key`: the collection or block type `slug`, the menu `name`, or the
 *   block type version's `blockTypeVersionKey` (what `by: "slug"` and
 *   `by: "name"` references resolve against);
 * - `parent_id` and `depth` for topological kinds.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { compareIds, isRecordKind, type RecordKind, type ReferenceKey } from "../format/kinds.js";
import { rowsPerInsert } from "../format/limits.js";

export interface PackageIndexEntry {
	kind: RecordKind;
	id: string;
	groupId?: string | null;
	parentId?: string | null;
	nameKey?: string | null;
	depth?: number;
}

const KEY_COLUMN = {
	id: "id",
	group: "group_id",
	slug: "name_key",
	name: "name_key",
} as const satisfies Record<ReferenceKey, string>;

export class TransferPackageIndexRepository {
	constructor(
		private readonly db: Kysely<Database>,
		private readonly operationId: string,
	) {}

	/** Insert entries; an entry already present (a retried batch) is left as is. */
	async insertMany(entries: readonly PackageIndexEntry[]): Promise<void> {
		for (const batch of chunks([...entries], rowsPerInsert(7))) {
			await this.db
				.insertInto("_emdash_transfer_package_index")
				.values(
					batch.map((entry) => ({
						operation_id: this.operationId,
						kind: entry.kind,
						id: entry.id,
						group_id: entry.groupId ?? null,
						parent_id: entry.parentId ?? null,
						name_key: entry.nameKey ?? null,
						depth: entry.depth ?? 0,
					})),
				)
				.onConflict((conflict) => conflict.columns(["operation_id", "kind", "id"]).doNothing())
				.execute();
		}
	}

	async get(kind: RecordKind, id: string): Promise<PackageIndexEntry | null> {
		const row = await this.db
			.selectFrom("_emdash_transfer_package_index")
			.selectAll()
			.where("operation_id", "=", this.operationId)
			.where("kind", "=", kind)
			.where("id", "=", id)
			.executeTakeFirst();
		if (!row || !isRecordKind(row.kind)) return null;
		return {
			kind: row.kind,
			id: row.id,
			groupId: row.group_id,
			parentId: row.parent_id,
			nameKey: row.name_key,
			depth: Number(row.depth),
		};
	}

	/**
	 * Values from `values` that no indexed record of any of `kinds` matches on
	 * `key` (sorted, unique).
	 */
	async findMissing(
		kinds: readonly RecordKind[],
		key: ReferenceKey,
		values: readonly string[],
	): Promise<string[]> {
		const column = KEY_COLUMN[key];
		const unique = [...new Set(values)];
		const found = new Set<string>();
		for (const batch of chunks(unique, SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_transfer_package_index")
				.select(sql<string>`${sql.ref(column)}`.as("value"))
				.where("operation_id", "=", this.operationId)
				.where("kind", "in", [...kinds])
				.where(sql.ref(column), "in", batch)
				.execute();
			for (const row of rows) found.add(row.value);
		}
		return unique.filter((value) => !found.has(value)).toSorted(compareIds);
	}

	/** Depth of each indexed record of `kind` among `ids`. */
	async depths(kind: RecordKind, ids: readonly string[]): Promise<Map<string, number>> {
		const result = new Map<string, number>();
		for (const batch of chunks([...new Set(ids)], SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_transfer_package_index")
				.select(["id", "depth"])
				.where("operation_id", "=", this.operationId)
				.where("kind", "=", kind)
				.where("id", "in", batch)
				.execute();
			for (const row of rows) result.set(row.id, Number(row.depth));
		}
		return result;
	}

	async count(kind?: RecordKind): Promise<number> {
		let query = this.db
			.selectFrom("_emdash_transfer_package_index")
			.select((eb) => eb.fn.countAll<number | string>().as("count"))
			.where("operation_id", "=", this.operationId);
		if (kind) query = query.where("kind", "=", kind);
		const row = await query.executeTakeFirstOrThrow();
		return Number(row.count);
	}

	/** Delete up to `limit` entries; returns how many were deleted. */
	async deleteSome(limit = 500): Promise<number> {
		const rows = await this.db
			.selectFrom("_emdash_transfer_package_index")
			.select(["kind", "id"])
			.where("operation_id", "=", this.operationId)
			.limit(limit)
			.execute();
		let deleted = 0;
		const byKind = new Map<string, string[]>();
		for (const row of rows) byKind.set(row.kind, [...(byKind.get(row.kind) ?? []), row.id]);
		for (const [kind, ids] of byKind) {
			for (const batch of chunks(ids, SQL_BATCH_SIZE)) {
				const result = await this.db
					.deleteFrom("_emdash_transfer_package_index")
					.where("operation_id", "=", this.operationId)
					.where("kind", "=", kind)
					.where("id", "in", batch)
					.executeTakeFirst();
				deleted += Number(result.numDeletedRows ?? 0n);
			}
		}
		return deleted;
	}
}
