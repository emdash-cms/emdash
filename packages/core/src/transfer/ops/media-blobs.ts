/**
 * Export-side record of each exported media row's blob digest and size,
 * computed by hashing the origin object during the export's media stage.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { rowsPerInsert } from "../format/limits.js";
import { bytewise } from "./collation.js";

export interface MediaBlobEntry {
	mediaId: string;
	sha256: string;
	bytes: number;
}

export class TransferMediaBlobRepository {
	constructor(
		private readonly db: Kysely<Database>,
		private readonly operationId: string,
	) {}

	/** Record blobs; re-recording a media id (retried batch) overwrites it with the new hash. */
	async putMany(entries: readonly MediaBlobEntry[]): Promise<void> {
		for (const batch of chunks([...entries], rowsPerInsert(4))) {
			await this.db
				.insertInto("_emdash_transfer_media_blobs")
				.values(
					batch.map((entry) => ({
						operation_id: this.operationId,
						media_id: entry.mediaId,
						sha256: entry.sha256,
						bytes: entry.bytes,
					})),
				)
				.onConflict((conflict) =>
					conflict.columns(["operation_id", "media_id"]).doUpdateSet({
						sha256: (eb) => eb.ref("excluded.sha256"),
						bytes: (eb) => eb.ref("excluded.bytes"),
					}),
				)
				.execute();
		}
	}

	async getMany(mediaIds: readonly string[]): Promise<Map<string, MediaBlobEntry>> {
		const result = new Map<string, MediaBlobEntry>();
		for (const batch of chunks([...new Set(mediaIds)], SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_transfer_media_blobs")
				.select(["media_id", "sha256", "bytes"])
				.where("operation_id", "=", this.operationId)
				.where("media_id", "in", batch)
				.execute();
			for (const row of rows) {
				result.set(row.media_id, {
					mediaId: row.media_id,
					sha256: row.sha256,
					bytes: Number(row.bytes),
				});
			}
		}
		return result;
	}

	/** Blob entries in media-id order. */
	async list(options: { after?: string; limit?: number } = {}): Promise<MediaBlobEntry[]> {
		let query = this.db
			.selectFrom("_emdash_transfer_media_blobs")
			.select(["media_id", "sha256", "bytes"])
			.where("operation_id", "=", this.operationId);
		const after = options.after;
		if (after !== undefined) {
			query = query.where(sql<boolean>`${bytewise(this.db, "media_id")} > ${after}`);
		}
		const rows = await query
			.orderBy(bytewise(this.db, "media_id"))
			.limit(Math.min(Math.max(options.limit ?? 500, 1), 1000))
			.execute();
		return rows.map((row) => ({
			mediaId: row.media_id,
			sha256: row.sha256,
			bytes: Number(row.bytes),
		}));
	}

	/** Distinct blobs (by digest) with their size, in digest order. */
	async listDistinctBlobs(
		options: { after?: string; limit?: number } = {},
	): Promise<Array<{ sha256: string; bytes: number }>> {
		let query = this.db
			.selectFrom("_emdash_transfer_media_blobs")
			.select(["sha256", (eb) => eb.fn.max("bytes").as("bytes")])
			.where("operation_id", "=", this.operationId)
			.groupBy("sha256");
		const after = options.after;
		if (after !== undefined) {
			query = query.where(sql<boolean>`${bytewise(this.db, "sha256")} > ${after}`);
		}
		const rows = await query
			.orderBy(bytewise(this.db, "sha256"))
			.limit(Math.min(Math.max(options.limit ?? 500, 1), 1000))
			.execute();
		return rows.map((row) => ({ sha256: row.sha256, bytes: Number(row.bytes) }));
	}

	async totals(): Promise<{ mediaRows: number; blobs: number; blobBytes: number }> {
		const row = await this.db
			.selectFrom("_emdash_transfer_media_blobs")
			.select((eb) => [
				eb.fn.countAll<number | string>().as("media_rows"),
				eb.fn.count<number | string>("sha256").distinct().as("blobs"),
			])
			.where("operation_id", "=", this.operationId)
			.executeTakeFirstOrThrow();
		const bytes = await this.db
			.selectFrom(
				this.db
					.selectFrom("_emdash_transfer_media_blobs")
					.select(["sha256", (eb) => eb.fn.max("bytes").as("bytes")])
					.where("operation_id", "=", this.operationId)
					.groupBy("sha256")
					.as("blob"),
			)
			.select((eb) => eb.fn.sum<number | string | null>("blob.bytes").as("total"))
			.executeTakeFirstOrThrow();
		return {
			mediaRows: Number(row.media_rows),
			blobs: Number(row.blobs),
			blobBytes: Number(bytes.total ?? 0),
		};
	}
}
