/**
 * `(operation, kind, portableId) → targetId` mappings for one import.
 *
 * Portable ids are written verbatim whenever possible, and a verbatim id
 * needs no row. Rows exist only for rewritten ids and for derived target
 * values (media storage keys, recorded under kind `media_storage_key`).
 * Mappings are scoped to the import operation, so a later import of the same
 * origin after an abandoned one starts with a clean namespace.
 * `origin_site_id` is recorded for diagnostics only.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { TransferError } from "../errors.js";
import { rowsPerInsert } from "../format/limits.js";
import { bytewise } from "./collation.js";

/** Identity-map kind for a media row's target storage key. */
export const MEDIA_STORAGE_KEY_ENTITY = "media_storage_key";

export interface IdentityMapping {
	portableId: string;
	targetId: string;
}

export class TransferIdentityMapRepository {
	constructor(
		private readonly db: Kysely<Database>,
		private readonly originSiteId: string,
		private readonly operationId: string,
	) {}

	/**
	 * Record mappings; re-recording the same mapping is a no-op. Throws
	 * `TRANSFER_REFERENCE_INVALID` if a portable id is already mapped to a
	 * different target id in this operation.
	 */
	async putMany(entityKind: string, mappings: readonly IdentityMapping[]): Promise<void> {
		if (mappings.length === 0) return;
		for (const batch of chunks([...mappings], rowsPerInsert(5))) {
			await this.db
				.insertInto("_emdash_transfer_identity_map")
				.values(
					batch.map((mapping) => ({
						origin_site_id: this.originSiteId,
						entity_kind: entityKind,
						portable_id: mapping.portableId,
						target_id: mapping.targetId,
						operation_id: this.operationId,
					})),
				)
				.onConflict((conflict) =>
					conflict.columns(["operation_id", "entity_kind", "portable_id"]).doNothing(),
				)
				.execute();
		}
		const stored = await this.getMany(
			entityKind,
			mappings.map((mapping) => mapping.portableId),
		);
		for (const mapping of mappings) {
			if (stored.get(mapping.portableId) !== mapping.targetId) {
				throw new TransferError("TRANSFER_REFERENCE_INVALID", "Conflicting identity mapping", {
					detail: { kind: entityKind, id: mapping.portableId },
				});
			}
		}
	}

	async put(entityKind: string, mapping: IdentityMapping): Promise<void> {
		await this.putMany(entityKind, [mapping]);
	}

	async get(entityKind: string, portableId: string): Promise<string | null> {
		const row = await this.db
			.selectFrom("_emdash_transfer_identity_map")
			.select("target_id")
			.where("operation_id", "=", this.operationId)
			.where("entity_kind", "=", entityKind)
			.where("portable_id", "=", portableId)
			.executeTakeFirst();
		return row?.target_id ?? null;
	}

	/** Mapped target ids by portable id (missing ids are absent from the map). */
	async getMany(entityKind: string, portableIds: readonly string[]): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		for (const batch of chunks([...new Set(portableIds)], SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_transfer_identity_map")
				.select(["portable_id", "target_id"])
				.where("operation_id", "=", this.operationId)
				.where("entity_kind", "=", entityKind)
				.where("portable_id", "in", batch)
				.execute();
			for (const row of rows) result.set(row.portable_id, row.target_id);
		}
		return result;
	}

	/** Portable ids by target id (reverse lookup for verification). */
	async getPortableIds(
		entityKind: string,
		targetIds: readonly string[],
	): Promise<Map<string, string>> {
		const result = new Map<string, string>();
		for (const batch of chunks([...new Set(targetIds)], SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_transfer_identity_map")
				.select(["portable_id", "target_id"])
				.where("operation_id", "=", this.operationId)
				.where("entity_kind", "=", entityKind)
				.where("target_id", "in", batch)
				.execute();
			for (const row of rows) result.set(row.target_id, row.portable_id);
		}
		return result;
	}

	/** Mappings of one kind in portable-id order, for bounded iteration. */
	async list(
		entityKind: string,
		options: { after?: string; limit?: number } = {},
	): Promise<IdentityMapping[]> {
		let query = this.db
			.selectFrom("_emdash_transfer_identity_map")
			.select(["portable_id", "target_id"])
			.where("operation_id", "=", this.operationId)
			.where("entity_kind", "=", entityKind);
		const after = options.after;
		if (after !== undefined) {
			query = query.where(sql<boolean>`${bytewise(this.db, "portable_id")} > ${after}`);
		}
		const rows = await query
			.orderBy(bytewise(this.db, "portable_id"))
			.limit(Math.min(Math.max(options.limit ?? 500, 1), 1000))
			.execute();
		return rows.map((row) => ({ portableId: row.portable_id, targetId: row.target_id }));
	}
}
