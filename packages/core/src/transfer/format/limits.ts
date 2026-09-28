/**
 * Hard limits for site packages and transfer operations.
 *
 * Package limits are part of the format contract: an exporter must never
 * produce a package that exceeds them and a reader must reject one that does
 * before doing expensive work. Operation limits bound one `advance` step so it
 * fits a Workers request on D1.
 */

const MiB = 1024 * 1024;

export const TRANSFER_LIMITS = Object.freeze({
	/** Maximum `manifest.json` size in bytes. */
	manifestBytes: 8 * MiB,
	/**
	 * Maximum bytes in one NDJSON line, excluding the newline. Kept under D1's
	 * 2 MB row/statement ceiling so every record can be written in one row.
	 */
	recordLineBytes: 1_900_000,
	/** Maximum bytes in one record or index chunk file. */
	chunkBytes: 4 * MiB,
	/** Maximum records (or index entries) in one chunk file. */
	chunkRecords: 1000,
	/** Maximum records across every kind. */
	totalRecords: 5_000_000,
	/** Maximum container nesting of any JSON value (root = 1). */
	jsonDepth: 64,
	/** Maximum files (record chunks + media blobs) listed by the index. */
	totalFiles: 1_000_000,
	/** Maximum index chunk files listed by the manifest. */
	indexChunks: 1000,
	/** Default per-blob ceiling; the target's `maxUploadSize` overrides it. */
	defaultMaxBlobBytes: 50 * MiB,

	/** Maximum length of a portable id (including synthetic composite ids). */
	idLength: 1024,
	/** Maximum length of short strings: slugs, names, labels, locales, mime types. */
	shortString: 4096,

	/** Operation step: stop starting work once this many queries ran in the request. */
	stepQueryCeiling: 900,
	/** Operation step: queries a unit of work may use; checked before starting it. */
	stepQueries: 150,
	/**
	 * Operation step: queries kept back from the ceiling for the writes that
	 * end a step once no more units start (a checkpoint and the lease
	 * release, or the read and write that record a failed step).
	 */
	stepClosingQueries: 2,
	/** Operation step: media bytes copied per step (a larger single blob gets its own step). */
	stepBytes: 32 * MiB,
	/** D1 bound parameters per statement. */
	d1BindParameters: 100,

	/** Operation lease duration. */
	leaseSeconds: 5 * 60,
	/** Uploading / analyzing / planned imports expire after this long. */
	pendingImportTtlSeconds: 24 * 60 * 60,
	/** Completed exports expire (and their staging is collected) after this long. */
	exportTtlSeconds: 7 * 24 * 60 * 60,
	/**
	 * MCP approval grant lifetime: a pending grant expires this long after it
	 * is requested, and an approved one this long after it is approved.
	 */
	approvalTtlSeconds: 15 * 60,
	/** Export attempts before failing with TRANSFER_EXPORT_CONCURRENT_WRITES. */
	exportFenceAttempts: 3,
	/** Maximum mismatches kept in a verification failure detail. */
	verificationMismatches: 50,
	/** Maximum warnings or blockers kept in a plan (the rest are summarized by count). */
	planIssues: 500,
});

export type TransferLimits = typeof TRANSFER_LIMITS;

/**
 * Rows per multi-row INSERT so a statement stays within D1's bound-parameter
 * limit. Returns 0 when a single row needs more parameters than the limit;
 * callers then insert core columns first and set the rest with batched
 * UPDATEs.
 */
export function rowsPerInsert(columnCount: number): number {
	if (!Number.isInteger(columnCount) || columnCount < 1) {
		throw new RangeError(`Invalid column count ${columnCount}`);
	}
	return Math.floor(TRANSFER_LIMITS.d1BindParameters / columnCount);
}
