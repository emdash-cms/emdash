/**
 * Files belonging to an operation's staged package.
 *
 * For an import, every file the manifest's index declares is `declared` with
 * its expected size and digest, then becomes `verified` once `putVerified`
 * stored exactly those bytes. For an export, each file the exporter writes is
 * recorded `verified` as it is written; finalization streams them in path
 * order into the index chunks. Verification stores each record chunk's
 * logical hash in `logical_sha256`.
 */

import { sql, type Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { TransferError } from "../errors.js";
import { rowsPerInsert } from "../format/limits.js";
import type { ExpectedFile } from "../staging/stage.js";
import { bytewise, likePrefix } from "./collation.js";
import { timestampNow } from "./time.js";

export type StagedFileState = "declared" | "verified";

export interface StagedFile {
	path: string;
	bytes: number;
	sha256: string;
	state: StagedFileState;
	verifiedAt: string | null;
	logicalSha256: string | null;
}

export interface DeclaredFile {
	path: string;
	bytes: number;
	sha256: string;
}

function toStagedFile(row: {
	path: string;
	bytes: number | string;
	sha256: string;
	state: string;
	verified_at: string | null;
	logical_sha256: string | null;
}): StagedFile {
	return {
		path: row.path,
		bytes: Number(row.bytes),
		sha256: row.sha256,
		state: row.state === "verified" ? "verified" : "declared",
		verifiedAt: row.verified_at,
		logicalSha256: row.logical_sha256,
	};
}

/** Bound values per inserted row: six columns plus the timestamp offset in `verified_at`. */
const STAGED_FILE_BINDS = 7;

export class TransferStagedFileRepository {
	constructor(private readonly db: Kysely<Database>) {}

	/**
	 * Declare expected files. Re-declaring an identical file is a no-op; a
	 * different size or digest for an existing path throws
	 * `TRANSFER_FILE_DIGEST_MISMATCH`.
	 */
	async declareMany(
		operationId: string,
		files: readonly DeclaredFile[],
		state: StagedFileState = "declared",
	): Promise<void> {
		for (const batch of chunks([...files], rowsPerInsert(STAGED_FILE_BINDS))) {
			await this.db
				.insertInto("_emdash_transfer_staged_files")
				.values(
					batch.map((file) => ({
						operation_id: operationId,
						path: file.path,
						bytes: file.bytes,
						sha256: file.sha256,
						state,
						verified_at: state === "verified" ? timestampNow(this.db) : null,
						logical_sha256: null,
					})),
				)
				.onConflict((conflict) => conflict.columns(["operation_id", "path"]).doNothing())
				.execute();
		}
		for (const batch of chunks([...files], SQL_BATCH_SIZE)) {
			const stored = await this.getMany(
				operationId,
				batch.map((file) => file.path),
			);
			for (const file of batch) {
				const existing = stored.get(file.path);
				if (!existing || existing.bytes !== file.bytes || existing.sha256 !== file.sha256) {
					throw new TransferError(
						"TRANSFER_FILE_DIGEST_MISMATCH",
						"File was already declared with a different size or digest",
						{ detail: { path: file.path } },
					);
				}
			}
		}
	}

	/** Record that the declared bytes were stored and verified. Returns false if the declaration differs. */
	async markVerified(operationId: string, file: DeclaredFile): Promise<boolean> {
		const result = await this.db
			.updateTable("_emdash_transfer_staged_files")
			.set({ state: "verified", verified_at: timestampNow(this.db) })
			.where("operation_id", "=", operationId)
			.where("path", "=", file.path)
			.where("bytes", "=", file.bytes)
			.where("sha256", "=", file.sha256)
			.executeTakeFirst();
		return Number(result.numUpdatedRows ?? 0n) > 0;
	}

	/**
	 * The size and digest each staged file of an operation was verified with,
	 * or null for a file that is not verified. Readers check what they read
	 * against these, since a later upload can replace a verified object.
	 */
	verifiedDigests(operationId: string): (path: string) => Promise<ExpectedFile | null> {
		return async (path) => {
			const file = await this.get(operationId, path);
			return file?.state === "verified" ? { bytes: file.bytes, sha256: file.sha256 } : null;
		};
	}

	async isVerified(operationId: string, path: string): Promise<boolean> {
		return (await this.get(operationId, path))?.state === "verified";
	}

	async setLogicalSha256(operationId: string, path: string, logicalSha256: string): Promise<void> {
		await this.db
			.updateTable("_emdash_transfer_staged_files")
			.set({ logical_sha256: logicalSha256 })
			.where("operation_id", "=", operationId)
			.where("path", "=", path)
			.execute();
	}

	async get(operationId: string, path: string): Promise<StagedFile | null> {
		const row = await this.db
			.selectFrom("_emdash_transfer_staged_files")
			.select(["path", "bytes", "sha256", "state", "verified_at", "logical_sha256"])
			.where("operation_id", "=", operationId)
			.where("path", "=", path)
			.executeTakeFirst();
		return row ? toStagedFile(row) : null;
	}

	async getMany(operationId: string, paths: readonly string[]): Promise<Map<string, StagedFile>> {
		const result = new Map<string, StagedFile>();
		for (const batch of chunks([...new Set(paths)], SQL_BATCH_SIZE)) {
			const rows = await this.db
				.selectFrom("_emdash_transfer_staged_files")
				.select(["path", "bytes", "sha256", "state", "verified_at", "logical_sha256"])
				.where("operation_id", "=", operationId)
				.where("path", "in", batch)
				.execute();
			for (const row of rows) result.set(row.path, toStagedFile(row));
		}
		return result;
	}

	/** Files in path order, optionally filtered by state or path prefix. */
	async list(
		operationId: string,
		options: { state?: StagedFileState; prefix?: string; after?: string; limit?: number } = {},
	): Promise<StagedFile[]> {
		let query = this.db
			.selectFrom("_emdash_transfer_staged_files")
			.select(["path", "bytes", "sha256", "state", "verified_at", "logical_sha256"])
			.where("operation_id", "=", operationId);
		if (options.state) query = query.where("state", "=", options.state);
		if (options.prefix !== undefined) {
			query = query.where(sql<boolean>`path LIKE ${likePrefix(options.prefix)} ESCAPE '\\'`);
		}
		const after = options.after;
		if (after !== undefined) {
			query = query.where(sql<boolean>`${bytewise(this.db, "path")} > ${after}`);
		}
		const rows = await query
			.orderBy(bytewise(this.db, "path"))
			.limit(Math.min(Math.max(options.limit ?? 500, 1), 1000))
			.execute();
		return rows.map(toStagedFile);
	}

	async countByState(operationId: string): Promise<Record<StagedFileState, number>> {
		const rows = await this.db
			.selectFrom("_emdash_transfer_staged_files")
			.select((eb) => ["state", eb.fn.countAll<number | string>().as("count")])
			.where("operation_id", "=", operationId)
			.groupBy("state")
			.execute();
		const counts: Record<StagedFileState, number> = { declared: 0, verified: 0 };
		for (const row of rows) {
			if (row.state === "declared" || row.state === "verified")
				counts[row.state] = Number(row.count);
		}
		return counts;
	}

	/** Delete up to `limit` rows for an operation; returns how many were deleted. */
	async deleteForOperation(operationId: string, limit = 500): Promise<number> {
		const paths = await this.db
			.selectFrom("_emdash_transfer_staged_files")
			.select("path")
			.where("operation_id", "=", operationId)
			.limit(limit)
			.execute();
		let deleted = 0;
		for (const batch of chunks(
			paths.map((row) => row.path),
			SQL_BATCH_SIZE,
		)) {
			const result = await this.db
				.deleteFrom("_emdash_transfer_staged_files")
				.where("operation_id", "=", operationId)
				.where("path", "in", batch)
				.executeTakeFirst();
			deleted += Number(result.numDeletedRows ?? 0n);
		}
		return deleted;
	}
}
