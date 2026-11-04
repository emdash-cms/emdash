/**
 * Site transfer handlers: capabilities, exports and their downloads, staged
 * import uploads, analysis, execution, operation status and control, and MCP
 * approval grants.
 *
 * Operations are always serialized with `toPublicOperation`, which drops the
 * staging secret and lease token.
 *
 * Import upload flow: `POST imports` with the manifest stages it and declares
 * the index chunks the manifest pins. Each index chunk upload declares every
 * file that chunk lists. A client uploads whatever `missing` lists, then asks
 * for `missing` again, until it is empty; index paths sort before record and
 * media paths, so they are listed first.
 */

import type { Permission, RoleLevel } from "@emdash-cms/auth";
import { hasPermission } from "@emdash-cms/auth";
import type { Kysely } from "kysely";

import {
	decodeCursor,
	encodeCursor,
	InvalidCursorError,
} from "../../database/repositories/types.js";
import type { Database } from "../../database/types.js";
import type { DownloadResult, Storage } from "../../storage/types.js";
import { analyzeImportStep, finalizePlan, loadImportPlan } from "../../transfer/analyze/step.js";
import type { AnalysisTargetContext } from "../../transfer/analyze/target.js";
import { validateStagedPackageStep } from "../../transfer/analyze/validate.js";
import { recordTransferAudit } from "../../transfer/audit.js";
import type { TransferApprovalAction } from "../../transfer/auth.js";
import { packSitePackage, type PackageFileSource } from "../../transfer/container/tar.js";
import { inspectPortableDomain } from "../../transfer/domain.js";
import { isTransferError, TransferError } from "../../transfer/errors.js";
import {
	advanceExport,
	createExport,
	exportOptionsSchema,
	openExportPackage,
	type ExportOptions,
	type ExportPackageValidator,
} from "../../transfer/export/exporter.js";
import { verifyImportStep } from "../../transfer/export/verify.js";
import {
	canonicalDigest,
	createHashingStream,
	createSha256,
	packageDigest,
	sha256Hex,
	type Sha256Digest,
} from "../../transfer/format/digest.js";
import { OPTIONAL_FEATURES, SITE_PACKAGE_FEATURES } from "../../transfer/format/features.js";
import { TRANSFER_LIMITS } from "../../transfer/format/limits.js";
import { parseManifest, type SitePackageManifest } from "../../transfer/format/manifest.js";
import { MANIFEST_PATH, parsePackagePath } from "../../transfer/format/paths.js";
import {
	isPlanExecutable,
	type SiteImportDecisionsInput,
	type SiteImportPlan,
} from "../../transfer/format/plan.js";
import type { SiteImportReceipt } from "../../transfer/format/receipt.js";
import { SUPPORTED_FORMAT_VERSIONS } from "../../transfer/format/version.js";
import { advanceImport, requestImportExecution } from "../../transfer/import/index.js";
import {
	TransferApprovalRepository,
	type ApprovalStatus,
	type TransferApproval,
} from "../../transfer/ops/approvals.js";
import { TransferStepBudget } from "../../transfer/ops/budget.js";
import {
	toPublicOperation,
	TransferOperationRepository,
	type PublicTransferOperation,
	type TransferOperation,
} from "../../transfer/ops/operations.js";
import { TransferStagedFileRepository } from "../../transfer/ops/staged-files.js";
import { stagingPrefix } from "../../transfer/staging/keys.js";
import { StagedPackageReader } from "../../transfer/staging/package.js";
import { TransferStage } from "../../transfer/staging/stage.js";
import type { ApiResult } from "../types.js";

/** Poll delay suggested while another request holds an operation's lease. */
const LEASE_RETRY_MS = 1000;

function isLeaseError(error: unknown): boolean {
	return (
		isTransferError(error) &&
		(error.code === "TRANSFER_LEASE_LOST" || error.code === "TRANSFER_LEASE_ACTIVE")
	);
}

const PAGE_LIMIT_DEFAULT = 50;
const PAGE_LIMIT_MAX = 100;

type ErrorResult = Extract<ApiResult<never>, { success: false }>;

function failure(code: string, message: string, details?: Record<string, unknown>): ErrorResult {
	return {
		success: false,
		error: details === undefined ? { code, message } : { code, message, details },
	};
}

function errorResult(error: unknown, fallbackCode: string, fallbackMessage: string): ErrorResult {
	if (isTransferError(error)) {
		return failure(error.code, error.message, error.detail ? { ...error.detail } : undefined);
	}
	if (error instanceof InvalidCursorError) {
		return failure("INVALID_CURSOR", "Invalid pagination cursor");
	}
	console.error(`[transfer] ${fallbackMessage}:`, error);
	return failure(fallbackCode, fallbackMessage);
}

function pageLimit(limit: number | undefined): number {
	return Math.min(Math.max(Math.trunc(limit ?? PAGE_LIMIT_DEFAULT), 1), PAGE_LIMIT_MAX);
}

function decodeTimeCursor(
	cursor: string | undefined,
): { createdAt: string; id: string } | undefined {
	if (cursor === undefined) return undefined;
	const { orderValue, id } = decodeCursor(cursor);
	return { createdAt: orderValue, id };
}

function stageFor(storage: Storage, operation: TransferOperation): TransferStage {
	return new TransferStage(
		storage,
		stagingPrefix(operation.kind, operation.id, operation.stagingSecret),
	);
}

async function requireImport(
	operations: TransferOperationRepository,
	operationId: string,
): Promise<TransferOperation> {
	const operation = await operations.get(operationId);
	if (!operation || operation.kind !== "import") {
		throw new TransferError("TRANSFER_OPERATION_NOT_FOUND", "Transfer operation not found");
	}
	return operation;
}

// ── Capabilities ────────────────────────────────────────────────

export interface TransferCapabilities {
	formatVersions: string[];
	features: string[];
	optionalFeatures: string[];
	limits: {
		manifestBytes: number;
		recordLineBytes: number;
		chunkBytes: number;
		chunkRecords: number;
		totalRecords: number;
		totalFiles: number;
		indexChunks: number;
		jsonDepth: number;
		maxBlobBytes: number;
	};
	portableDomain: {
		empty: boolean;
		blockers: Array<Record<string, string>>;
		seededScaffold: Array<Record<string, string>>;
	};
}

export async function handleTransferCapabilities(
	db: Kysely<Database>,
	target: AnalysisTargetContext,
): Promise<ApiResult<TransferCapabilities>> {
	try {
		const domain = await inspectPortableDomain(db);
		return {
			success: true,
			data: {
				formatVersions: [...SUPPORTED_FORMAT_VERSIONS],
				features: [...SITE_PACKAGE_FEATURES],
				optionalFeatures: [...OPTIONAL_FEATURES].toSorted(),
				limits: {
					manifestBytes: TRANSFER_LIMITS.manifestBytes,
					recordLineBytes: TRANSFER_LIMITS.recordLineBytes,
					chunkBytes: TRANSFER_LIMITS.chunkBytes,
					chunkRecords: TRANSFER_LIMITS.chunkRecords,
					totalRecords: TRANSFER_LIMITS.totalRecords,
					totalFiles: TRANSFER_LIMITS.totalFiles,
					indexChunks: TRANSFER_LIMITS.indexChunks,
					jsonDepth: TRANSFER_LIMITS.jsonDepth,
					maxBlobBytes: target.maxUploadSize,
				},
				portableDomain: {
					empty: domain.empty,
					blockers: domain.blockers.map((blocker) => ({ ...blocker })),
					seededScaffold: domain.seededScaffold.map((item) => ({ ...item })),
				},
			},
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_ANALYZE_ERROR", "Failed to read transfer capabilities");
	}
}

// ── Imports: creation and uploads ───────────────────────────────

export interface TransferMissingFiles {
	items: Array<{ path: string; bytes: number; sha256: string }>;
	nextCursor?: string;
}

async function listMissing(
	db: Kysely<Database>,
	operationId: string,
	options: { cursor?: string; limit?: number },
): Promise<TransferMissingFiles> {
	const limit = pageLimit(options.limit);
	const after = options.cursor === undefined ? undefined : decodeCursor(options.cursor).orderValue;
	const files = await new TransferStagedFileRepository(db).list(operationId, {
		state: "declared",
		after,
		limit: limit + 1,
	});
	const items = files
		.slice(0, limit)
		.map((file) => ({ path: file.path, bytes: file.bytes, sha256: file.sha256 }));
	const last = items.at(-1);
	return files.length > limit && last
		? { items, nextCursor: encodeCursor(last.path, last.path) }
		: { items };
}

async function stageManifest(
	db: Kysely<Database>,
	storage: Storage,
	operation: TransferOperation,
	manifest: SitePackageManifest,
	bytes: Uint8Array,
): Promise<void> {
	const staged = new TransferStagedFileRepository(db);
	const existing = await staged.get(operation.id, MANIFEST_PATH);
	if (existing?.state !== "verified") {
		const sha256 = await sha256Hex(bytes);
		await stageFor(storage, operation).putVerified(MANIFEST_PATH, bytes, bytes.byteLength, sha256, {
			contentType: "application/json",
			keepExistingOnFailure: () => staged.isVerified(operation.id, MANIFEST_PATH),
		});
		await staged.declareMany(
			operation.id,
			[{ path: MANIFEST_PATH, bytes: bytes.byteLength, sha256 }],
			"verified",
		);
	}
	await staged.declareMany(
		operation.id,
		manifest.index.map((ref) => ({ path: ref.path, bytes: ref.bytes, sha256: ref.sha256 })),
	);
}

export interface CreateImportInput {
	userId: string;
	/** Raw `manifest.json` bytes (canonical JSON). */
	manifest: Uint8Array;
	idempotencyKey?: string;
}

/**
 * Create an import from a manifest, stage the manifest, and return the first
 * page of files still to upload. The same idempotency key with the same
 * manifest returns the existing operation; with a different manifest it
 * fails with `TRANSFER_IDEMPOTENCY_CONFLICT`.
 */
export async function handleImportCreate(
	db: Kysely<Database>,
	storage: Storage,
	input: CreateImportInput,
): Promise<
	ApiResult<{ operation: PublicTransferOperation; created: boolean; missing: TransferMissingFiles }>
> {
	try {
		const manifest = parseManifest(input.manifest);
		const digest = await packageDigest(manifest);
		const domain = await inspectPortableDomain(db);
		if (!domain.empty) {
			throw new TransferError(
				"TRANSFER_TARGET_NOT_EMPTY",
				"This site already has content; import needs an empty site",
				{ detail: { blockers: domain.blockers.length } },
			);
		}
		const operations = new TransferOperationRepository(db);
		const { operation, created } = await operations.create({
			kind: "import",
			createdBy: input.userId,
			idempotencyKey: input.idempotencyKey,
			packageDigest: digest,
			originSiteId: manifest.originSiteId,
		});
		if (operation.kind !== "import") {
			throw new TransferError("TRANSFER_INVALID_STATE", "Operation is not an import");
		}
		if (created) {
			await recordTransferAudit(db, {
				actorId: input.userId,
				action: "transfer_import_create",
				resourceType: "transfer_operation",
				resourceId: operation.id,
				details: { packageDigest: digest },
			});
		}
		if (operation.state === "uploading") {
			await stageManifest(db, storage, operation, manifest, input.manifest);
		}
		return {
			success: true,
			data: {
				operation: toPublicOperation(operation),
				created,
				missing: await listMissing(db, operation.id, {}),
			},
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to create import");
	}
}

export async function handleImportMissing(
	db: Kysely<Database>,
	operationId: string,
	options: { cursor?: string; limit?: number },
): Promise<ApiResult<TransferMissingFiles>> {
	try {
		await requireImport(new TransferOperationRepository(db), operationId);
		return { success: true, data: await listMissing(db, operationId, options) };
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to list missing files");
	}
}

export interface UploadImportFileInput {
	operationId: string;
	path: string;
	/** `Content-Length` of the request. */
	contentLength: number;
	body: ReadableStream<Uint8Array> | null;
	/** Largest media blob the site accepts (`maxUploadSize`). */
	maxBlobBytes: number;
}

export interface UploadImportFileResult {
	path: string;
	bytes: number;
	/** True when the path was already verified and the body matched it. */
	alreadyVerified: boolean;
	/** Declared files still to upload. */
	remaining: number;
}

function fileLimit(type: "manifest" | "index" | "records" | "media", maxBlobBytes: number): number {
	switch (type) {
		case "manifest":
			return TRANSFER_LIMITS.manifestBytes;
		case "media":
			return maxBlobBytes;
		case "index":
		case "records":
			return TRANSFER_LIMITS.chunkBytes;
	}
}

async function digestOfBody(body: ReadableStream<Uint8Array> | null, bytes: number) {
	const hasher = await createSha256();
	const hashing = createHashingStream(hasher, {
		maxBytes: bytes,
		onLimitExceeded: () =>
			new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "File is larger than declared"),
	});
	if (body) await body.pipeThrough(hashing.stream).pipeTo(new WritableStream());
	return { sha256: await hasher.digest(), bytes: hashing.bytes() };
}

/**
 * Whether the staged object at `path` exists and still holds exactly the
 * bytes it was verified with. A storage error other than a missing object
 * is thrown rather than read as a mismatch.
 */
async function stagedFileIntact(
	stage: TransferStage,
	path: string,
	file: { bytes: number; sha256: string },
): Promise<boolean> {
	if (!(await stage.exists(path))) return false;
	let download: DownloadResult;
	try {
		download = await stage.storage.download(stage.keyFor(path));
	} catch (error) {
		throw new TransferError("TRANSFER_STORAGE_ERROR", "Failed to read a staged file", {
			cause: error,
		});
	}
	try {
		const stored = await digestOfBody(download.body, file.bytes);
		return stored.bytes === file.bytes && stored.sha256 === file.sha256;
	} catch (error) {
		if (isTransferError(error) && error.code === "TRANSFER_FILE_SIZE_MISMATCH") return false;
		throw error;
	}
}

/**
 * Stream one declared package file into staging, verifying its size and
 * digest. Uploading an index chunk declares the files it lists. A path that
 * is already verified is only compared, never written, while its staged
 * object still matches; once that object no longer matches (a failed
 * concurrent upload of the same path overwrote it), an upload replaces it.
 * An upload that is still streaming when analysis starts is refused.
 */
export async function handleImportFileUpload(
	db: Kysely<Database>,
	storage: Storage,
	input: UploadImportFileInput,
): Promise<ApiResult<UploadImportFileResult>> {
	try {
		const operations = new TransferOperationRepository(db);
		const operation = await requireImport(operations, input.operationId);
		if (operation.state !== "uploading") {
			throw new TransferError(
				"TRANSFER_INVALID_STATE",
				"Files can only be uploaded before analysis",
			);
		}
		const parsed = parsePackagePath(input.path);
		if (!parsed) {
			throw new TransferError("TRANSFER_PATH_INVALID", "Invalid package path");
		}
		const staged = new TransferStagedFileRepository(db);
		const file = await staged.get(operation.id, parsed.path);
		if (!file) {
			throw new TransferError("TRANSFER_FILE_NOT_DECLARED", "File is not declared by the package", {
				detail: { path: parsed.path },
			});
		}
		const limit = fileLimit(parsed.type, input.maxBlobBytes);
		if (file.bytes > limit) {
			throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "File is larger than this site accepts", {
				detail: { path: parsed.path, bytes: file.bytes, limit },
			});
		}
		if (input.contentLength !== file.bytes) {
			throw new TransferError(
				"TRANSFER_FILE_SIZE_MISMATCH",
				"Content-Length does not match the declared size",
				{ detail: { path: parsed.path, expected: file.bytes } },
			);
		}

		const stage = stageFor(storage, operation);
		if (file.state === "verified" && (await stagedFileIntact(stage, parsed.path, file))) {
			const received = await digestOfBody(input.body, file.bytes);
			if (received.bytes !== file.bytes) {
				throw new TransferError("TRANSFER_FILE_SIZE_MISMATCH", "File size does not match", {
					detail: { path: parsed.path, expected: file.bytes },
				});
			}
			if (received.sha256 !== file.sha256) {
				throw new TransferError("TRANSFER_FILE_DIGEST_MISMATCH", "File digest does not match", {
					detail: { path: parsed.path },
				});
			}
			return {
				success: true,
				data: {
					path: parsed.path,
					bytes: file.bytes,
					alreadyVerified: true,
					remaining: (await staged.countByState(operation.id)).declared,
				},
			};
		}

		await stage.putVerified(parsed.path, input.body ?? new Uint8Array(0), file.bytes, file.sha256, {
			keepExistingOnFailure: () => staged.isVerified(operation.id, parsed.path),
		});
		if ((await operations.require(operation.id)).state !== "uploading") {
			throw new TransferError(
				"TRANSFER_INVALID_STATE",
				"Files can only be uploaded before analysis",
			);
		}
		if (parsed.type === "index") {
			const entries = await new StagedPackageReader(stage).indexChunk(parsed.seq);
			await staged.declareMany(
				operation.id,
				entries.map((entry) => ({ path: entry.path, bytes: entry.bytes, sha256: entry.sha256 })),
			);
		}
		await staged.markVerified(operation.id, file);
		return {
			success: true,
			data: {
				path: parsed.path,
				bytes: file.bytes,
				alreadyVerified: false,
				remaining: (await staged.countByState(operation.id)).declared,
			},
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_STORAGE_ERROR", "Failed to store the uploaded file");
	}
}

// ── Imports: analysis and plan ──────────────────────────────────

export interface AnalyzeImportInput {
	operationId: string;
	decisions?: SiteImportDecisionsInput;
	target: AnalysisTargetContext;
	budget?: TransferStepBudget;
}

export interface AnalyzeImportResult {
	operation: PublicTransferOperation;
	plan?: SiteImportPlan;
	planDigest?: Sha256Digest;
	/** Milliseconds until the client should call again, or null when analysis has ended. */
	nextRequestInMs: number | null;
}

/**
 * Run one bounded analysis step. Once the import is planned, returns the plan
 * and, when `decisions` are given, applies them first. Decisions are refused
 * with `TRANSFER_INVALID_STATE` once execution has been requested.
 */
export async function handleImportAnalyze(
	db: Kysely<Database>,
	storage: Storage,
	input: AnalyzeImportInput,
): Promise<ApiResult<AnalyzeImportResult>> {
	try {
		const operations = new TransferOperationRepository(db);
		let operation = await requireImport(operations, input.operationId);
		let plan: SiteImportPlan | null = null;
		let digest: Sha256Digest | null = null;

		if (operation.state === "uploading") {
			const { declared } = await new TransferStagedFileRepository(db).countByState(operation.id);
			if (declared > 0) {
				throw new TransferError("TRANSFER_FILE_MISSING", "Some package files are not uploaded", {
					detail: { missing: declared },
				});
			}
		}

		if (operation.state === "uploading" || operation.state === "analyzing") {
			const step = await analyzeImportStep({
				db,
				storage,
				operationId: operation.id,
				budget: input.budget ?? new TransferStepBudget(),
				targetContext: input.target,
			}).catch((error: unknown) => {
				if (isTransferError(error) && error.code === "TRANSFER_LEASE_ACTIVE") return null;
				throw error;
			});
			if (!step) {
				return {
					success: true,
					data: {
						operation: toPublicOperation(await operations.require(operation.id)),
						nextRequestInMs: LEASE_RETRY_MS,
					},
				};
			}
			operation = step.operation;
			if (!step.done) {
				return {
					success: true,
					data: { operation: toPublicOperation(operation), nextRequestInMs: 0 },
				};
			}
			plan = step.plan;
			digest = step.planDigest;
		} else if (operation.state === "planned") {
			plan = await loadImportPlan(storage, operation);
			digest = operation.planDigest;
		} else {
			throw new TransferError("TRANSFER_INVALID_STATE", "Import is past analysis");
		}

		if (operation.state === "planned" && input.decisions !== undefined) {
			const finalized = await finalizePlan({
				db,
				storage,
				operationId: operation.id,
				decisions: input.decisions,
			});
			plan = finalized.plan;
			digest = finalized.planDigest;
			operation = await operations.require(operation.id);
		}

		return {
			success: true,
			data: {
				operation: toPublicOperation(operation),
				...(plan ? { plan } : {}),
				...(plan && digest ? { planDigest: digest } : {}),
				nextRequestInMs: null,
			},
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_ANALYZE_ERROR", "Failed to analyze import");
	}
}

export async function handleImportPlan(
	db: Kysely<Database>,
	storage: Storage,
	operationId: string,
): Promise<ApiResult<{ plan: SiteImportPlan; planDigest: Sha256Digest }>> {
	try {
		const operation = await requireImport(new TransferOperationRepository(db), operationId);
		const plan = operation.planDigest ? await loadImportPlan(storage, operation) : null;
		if (!plan || !operation.planDigest) {
			throw new TransferError("TRANSFER_INVALID_STATE", "Import has not been analyzed");
		}
		return { success: true, data: { plan, planDigest: operation.planDigest } };
	} catch (error) {
		return errorResult(error, "TRANSFER_ANALYZE_ERROR", "Failed to read import plan");
	}
}

// ── Imports: status and control ─────────────────────────────────

export async function handleImportGet(
	db: Kysely<Database>,
	operationId: string,
): Promise<
	ApiResult<{
		operation: PublicTransferOperation;
		files: { declared: number; verified: number };
	}>
> {
	try {
		const operation = await requireImport(new TransferOperationRepository(db), operationId);
		const files = await new TransferStagedFileRepository(db).countByState(operation.id);
		return { success: true, data: { operation: toPublicOperation(operation), files } };
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to read import");
	}
}

export async function handleImportList(
	db: Kysely<Database>,
	options: { cursor?: string; limit?: number },
): Promise<ApiResult<{ items: PublicTransferOperation[]; nextCursor?: string }>> {
	try {
		const page = await new TransferOperationRepository(db).list({
			kind: "import",
			limit: pageLimit(options.limit),
			cursor: decodeTimeCursor(options.cursor),
		});
		return {
			success: true,
			data: page.next
				? { items: page.items, nextCursor: encodeCursor(page.next.createdAt, page.next.id) }
				: { items: page.items },
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to list imports");
	}
}

/** Cancel an import; a step in flight stops after its current batch. */
export async function handleImportCancel(
	db: Kysely<Database>,
	operationId: string,
	userId: string,
): Promise<ApiResult<{ operation: PublicTransferOperation }>> {
	try {
		const operations = new TransferOperationRepository(db);
		await requireImport(operations, operationId);
		const operation = await operations.requestCancel(operationId);
		await recordTransferAudit(db, {
			actorId: userId,
			action: "transfer_import_cancel",
			resourceType: "transfer_operation",
			resourceId: operationId,
		});
		return { success: true, data: { operation: toPublicOperation(operation) } };
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to cancel import");
	}
}

/**
 * Abandon a failed or cancelled import. Lifts the site write fence; imported
 * data stays in place.
 */
export async function handleImportAbandon(
	db: Kysely<Database>,
	operationId: string,
	userId: string,
): Promise<ApiResult<{ operation: PublicTransferOperation }>> {
	try {
		const operations = new TransferOperationRepository(db);
		await requireImport(operations, operationId);
		const operation = await operations.abandon(operationId);
		await recordTransferAudit(db, {
			actorId: userId,
			action: "transfer_import_abandon",
			resourceType: "transfer_operation",
			resourceId: operationId,
		});
		return { success: true, data: { operation: toPublicOperation(operation) } };
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to abandon import");
	}
}

// ── Exports ─────────────────────────────────────────────────────

async function requireExport(
	operations: TransferOperationRepository,
	operationId: string,
): Promise<TransferOperation> {
	const operation = await operations.get(operationId);
	if (!operation || operation.kind !== "export") {
		throw new TransferError("TRANSFER_OPERATION_NOT_FOUND", "Transfer operation not found");
	}
	return operation;
}

async function requireCompleteExport(
	db: Kysely<Database>,
	operationId: string,
): Promise<TransferOperation> {
	const operation = await requireExport(new TransferOperationRepository(db), operationId);
	if (operation.state !== "complete") {
		throw new TransferError("TRANSFER_INVALID_STATE", "Export is not complete");
	}
	if (operation.stagingCollectedAt !== null) {
		throw new TransferError("TRANSFER_EXPIRED", "Export files are no longer available");
	}
	return operation;
}

/**
 * Run `start` after a grant was consumed for it, handing the grant back when
 * the operation does not start so the caller can retry with it.
 */
async function withGrantRestoredOnFailure<T>(
	approvals: TransferApprovalRepository,
	approval: TransferApprovalGrant | undefined,
	start: () => Promise<T>,
): Promise<T> {
	try {
		return await start();
	} catch (error) {
		if (approval) {
			await approvals.restore(approval.id).catch((restoreError: unknown) => {
				console.error("[transfer] Failed to restore an approval grant:", restoreError);
			});
		}
		throw error;
	}
}

/** Digest an export approval grant binds: the export options, normalized. */
export async function exportParamsDigest(options: ExportOptions): Promise<Sha256Digest> {
	return canonicalDigest(exportOptionsSchema.parse(options));
}

/** A one-time approval grant a caller without the transfer scope presents. */
export interface TransferApprovalGrant {
	id: string;
	/** The API token the caller is authenticated with, if any. */
	tokenId?: string;
}

export interface CreateExportInput {
	userId: string;
	options: ExportOptions;
	idempotencyKey?: string;
	/**
	 * Consumed before the export is created, and restored if creation fails;
	 * bound to the user and the options digest.
	 */
	approval?: TransferApprovalGrant;
}

/**
 * Create an export, or return the existing one for the same idempotency key.
 * With `approval`, the grant must be approved, unexpired, and bound to this
 * user, action `export`, these options, and the caller's token.
 */
export async function handleExportCreate(
	db: Kysely<Database>,
	input: CreateExportInput,
): Promise<ApiResult<{ operation: PublicTransferOperation; created: boolean }>> {
	try {
		const approvals = new TransferApprovalRepository(db);
		if (input.approval) {
			await approvals.consume(input.approval.id, {
				userId: input.userId,
				action: "export",
				paramsDigest: await exportParamsDigest(input.options),
				tokenId: input.approval.tokenId,
			});
		}
		const { operation, created } = await withGrantRestoredOnFailure(approvals, input.approval, () =>
			createExport({
				db,
				createdBy: input.userId,
				options: input.options,
				idempotencyKey: input.idempotencyKey,
			}),
		);
		if (input.approval) await approvals.linkOperation(input.approval.id, operation.id);
		if (created) {
			await recordTransferAudit(db, {
				actorId: input.userId,
				action: "transfer_export_create",
				resourceType: "transfer_operation",
				resourceId: operation.id,
			});
		}
		return { success: true, data: { operation: toPublicOperation(operation), created } };
	} catch (error) {
		return errorResult(error, "TRANSFER_EXPORT_ERROR", "Failed to create export");
	}
}

export interface AdvanceExportRouteInput {
	operationId: string;
	defaultLocale?: string;
	budget?: TransferStepBudget;
}

const validatePackage: ExportPackageValidator = (input) => validateStagedPackageStep(input);

/** Run one bounded export step. */
export async function handleExportAdvance(
	db: Kysely<Database>,
	storage: Storage,
	input: AdvanceExportRouteInput,
): Promise<ApiResult<{ operation: PublicTransferOperation; nextRequestInMs: number | null }>> {
	try {
		const operations = new TransferOperationRepository(db);
		await requireExport(operations, input.operationId);
		let step;
		try {
			step = await advanceExport({
				db,
				storage,
				operationId: input.operationId,
				budget: input.budget,
				defaultLocale: input.defaultLocale,
				validatePackage,
			});
		} catch (error) {
			if (isTransferError(error) && error.code === "TRANSFER_LEASE_LOST") {
				return {
					success: true,
					data: {
						operation: toPublicOperation(await operations.require(input.operationId)),
						nextRequestInMs: LEASE_RETRY_MS,
					},
				};
			}
			throw error;
		}
		const nextRequestInMs =
			step.outcome === "advanced" ? 0 : step.outcome === "busy" ? LEASE_RETRY_MS : null;
		return {
			success: true,
			data: { operation: toPublicOperation(step.operation), nextRequestInMs },
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_EXPORT_ERROR", "Failed to advance export");
	}
}

export async function handleExportGet(
	db: Kysely<Database>,
	operationId: string,
): Promise<ApiResult<{ operation: PublicTransferOperation }>> {
	try {
		const operation = await requireExport(new TransferOperationRepository(db), operationId);
		return { success: true, data: { operation: toPublicOperation(operation) } };
	} catch (error) {
		return errorResult(error, "TRANSFER_EXPORT_ERROR", "Failed to read export");
	}
}

export async function handleExportList(
	db: Kysely<Database>,
	options: { cursor?: string; limit?: number },
): Promise<ApiResult<{ items: PublicTransferOperation[]; nextCursor?: string }>> {
	try {
		const page = await new TransferOperationRepository(db).list({
			kind: "export",
			limit: pageLimit(options.limit),
			cursor: decodeTimeCursor(options.cursor),
		});
		return {
			success: true,
			data: page.next
				? { items: page.items, nextCursor: encodeCursor(page.next.createdAt, page.next.id) }
				: { items: page.items },
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_EXPORT_ERROR", "Failed to list exports");
	}
}

/** A package file ready to stream: its size and a body verified as it streams. */
export interface ExportFileStream {
	path: string;
	bytes: number;
	sha256: string;
	body: ReadableStream<Uint8Array>;
}

function exportFileMismatch(): TransferError {
	return new TransferError(
		"TRANSFER_FILE_DIGEST_MISMATCH",
		"Stored file no longer matches the export",
	);
}

/**
 * Pass `body` through, failing the stream if it does not carry exactly
 * `bytes` bytes hashing to `sha256`, so a changed source object never
 * reaches the client as a complete file.
 */
function verifyingStream(
	body: ReadableStream<Uint8Array>,
	expected: { bytes: number; sha256: string },
): ReadableStream<Uint8Array> {
	let hasher: Awaited<ReturnType<typeof createSha256>> | undefined;
	let total = 0;
	return body.pipeThrough(
		new TransformStream<Uint8Array, Uint8Array>({
			async start() {
				hasher = await createSha256();
			},
			transform(chunk, controller) {
				total += chunk.byteLength;
				if (total > expected.bytes) throw exportFileMismatch();
				hasher?.update(chunk);
				controller.enqueue(chunk);
			},
			async flush() {
				if (total !== expected.bytes || (await hasher?.digest()) !== expected.sha256) {
					throw exportFileMismatch();
				}
			},
		}),
	);
}

async function openExportFile(
	db: Kysely<Database>,
	storage: Storage,
	operation: TransferOperation,
	path: string,
): Promise<ExportFileStream> {
	const parsed = parsePackagePath(path);
	if (!parsed) throw new TransferError("TRANSFER_PATH_INVALID", "Invalid package path");
	const reader = openExportPackage({ db, storage, operation });
	if (parsed.type === "manifest") {
		const bytes = await reader.stage.readBytes(MANIFEST_PATH, TRANSFER_LIMITS.manifestBytes);
		return {
			path: MANIFEST_PATH,
			bytes: bytes.byteLength,
			sha256: await sha256Hex(bytes),
			body: new ReadableStream<Uint8Array>({
				start(controller) {
					controller.enqueue(bytes);
					controller.close();
				},
			}),
		};
	}
	const file = await new TransferStagedFileRepository(db).get(operation.id, parsed.path);
	if (!file || file.state !== "verified") {
		throw new TransferError("TRANSFER_FILE_NOT_DECLARED", "File is not part of this export", {
			detail: { path: parsed.path },
		});
	}
	const source =
		parsed.type === "media"
			? await reader.blob(parsed.sha256)
			: (await reader.stage.open(parsed.path)).body;
	return {
		path: file.path,
		bytes: file.bytes,
		sha256: file.sha256,
		body: verifyingStream(source, file),
	};
}

/**
 * Open one file of a complete export: `manifest.json`, an index or record
 * chunk from staging, or a media blob streamed from the origin object. The
 * body errors if the bytes no longer match the export's digest.
 */
export async function handleExportFile(
	db: Kysely<Database>,
	storage: Storage,
	operationId: string,
	path: string,
): Promise<ApiResult<ExportFileStream>> {
	try {
		const operation = await requireCompleteExport(db, operationId);
		return { success: true, data: await openExportFile(db, storage, operation, path) };
	} catch (error) {
		return errorResult(error, "TRANSFER_EXPORT_ERROR", "Failed to read export file");
	}
}

async function* exportArchiveFiles(
	db: Kysely<Database>,
	storage: Storage,
	operation: TransferOperation,
): AsyncGenerator<PackageFileSource> {
	const manifest = await openExportFile(db, storage, operation, MANIFEST_PATH);
	yield { path: manifest.path, bytes: manifest.bytes, body: () => manifest.body };
	const staged = new TransferStagedFileRepository(db);
	let after: string | undefined;
	for (;;) {
		const page = await staged.list(operation.id, { state: "verified", after, limit: 500 });
		for (const file of page) {
			if (file.path === MANIFEST_PATH) continue;
			yield {
				path: file.path,
				bytes: file.bytes,
				body: async () => (await openExportFile(db, storage, operation, file.path)).body,
			};
		}
		const last = page.at(-1);
		if (!last || page.length < 500) return;
		after = last.path;
	}
}

/**
 * Stream a complete export as one tar container: the manifest first, then
 * every index chunk, media blob, and record chunk in path order. Each file is
 * read and verified as it is written, so a failure mid-archive ends the
 * stream with an error rather than a short archive. On Workers the whole
 * archive must stream within one request's limits; large sites should
 * download files individually.
 */
export async function handleExportArchive(
	db: Kysely<Database>,
	storage: Storage,
	operationId: string,
): Promise<ApiResult<{ body: ReadableStream<Uint8Array> }>> {
	try {
		const operation = await requireCompleteExport(db, operationId);
		return {
			success: true,
			data: { body: packSitePackage(exportArchiveFiles(db, storage, operation)) },
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_EXPORT_ERROR", "Failed to read export archive");
	}
}

// ── Imports: execution ──────────────────────────────────────────

export interface ExecuteImportInput {
	operationId: string;
	userId: string;
	packageDigest: Sha256Digest;
	planDigest: Sha256Digest;
	/**
	 * Consumed before execution starts, and restored if it cannot start;
	 * bound to the user, action `import`, this operation, both digests, and
	 * the caller's token.
	 */
	approval?: TransferApprovalGrant;
}

/**
 * Request execution of a planned import. The digests must match the staged
 * package and the current plan (`TRANSFER_PACKAGE_DIGEST_MISMATCH` /
 * `TRANSFER_PLAN_DIGEST_MISMATCH`), and the plan must have no blockers.
 * Repeating the request for an import already executing returns it.
 */
export async function handleImportExecute(
	db: Kysely<Database>,
	storage: Storage,
	input: ExecuteImportInput,
): Promise<ApiResult<{ operation: PublicTransferOperation }>> {
	try {
		const operation = await requireImport(new TransferOperationRepository(db), input.operationId);
		if (operation.packageDigest !== input.packageDigest) {
			throw new TransferError("TRANSFER_PACKAGE_DIGEST_MISMATCH", "Package digest does not match");
		}
		if (operation.planDigest === null || operation.planDigest !== input.planDigest) {
			throw new TransferError("TRANSFER_PLAN_DIGEST_MISMATCH", "Plan digest does not match");
		}
		if (operation.state === "planned") {
			const plan = await loadImportPlan(storage, operation);
			if (!plan || !isPlanExecutable(plan)) {
				throw new TransferError("TRANSFER_PLAN_BLOCKED", "The import plan has blockers", {
					detail: { blockers: plan?.blockers.length ?? 0 },
				});
			}
		}
		const approvals = new TransferApprovalRepository(db);
		if (input.approval) {
			await approvals.consume(input.approval.id, {
				userId: input.userId,
				action: "import",
				operationId: operation.id,
				packageDigest: input.packageDigest,
				planDigest: input.planDigest,
				tokenId: input.approval.tokenId,
			});
		}
		const { operation: requested, requested: newlyRequested } = await withGrantRestoredOnFailure(
			approvals,
			input.approval,
			() =>
				requestImportExecution({
					db,
					operationId: operation.id,
					packageDigest: input.packageDigest,
					planDigest: input.planDigest,
				}),
		);
		if (newlyRequested) {
			await recordTransferAudit(db, {
				actorId: input.userId,
				action: "transfer_import_execute",
				resourceType: "transfer_operation",
				resourceId: operation.id,
				details: { packageDigest: input.packageDigest, planDigest: input.planDigest },
			});
		}
		return { success: true, data: { operation: toPublicOperation(requested) } };
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to execute import");
	}
}

/**
 * Run one bounded import step. Retryable failures are recorded on the
 * operation and reported through `nextRequestInMs`, as is a step that lost
 * its lease to another caller; it is null once the import has ended. The
 * step that completes or fails the import records it in the audit log as
 * `userId`'s.
 */
export async function handleImportAdvance(
	db: Kysely<Database>,
	storage: Storage,
	input: { operationId: string; userId: string; budget?: TransferStepBudget },
): Promise<ApiResult<{ operation: PublicTransferOperation; nextRequestInMs: number | null }>> {
	try {
		const operations = new TransferOperationRepository(db);
		await requireImport(operations, input.operationId);
		let step;
		try {
			step = await advanceImport({
				db,
				storage,
				operationId: input.operationId,
				verify: verifyImportStep,
				budget: input.budget,
			});
		} catch (error) {
			if (isLeaseError(error)) {
				return {
					success: true,
					data: {
						operation: toPublicOperation(await operations.require(input.operationId)),
						nextRequestInMs: LEASE_RETRY_MS,
					},
				};
			}
			throw error;
		}
		if (step.ended) await auditImportEnd(db, step.operation, input.userId);
		return {
			success: true,
			data: { operation: toPublicOperation(step.operation), nextRequestInMs: step.nextRequestInMs },
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to advance import");
	}
}

async function auditImportEnd(
	db: Kysely<Database>,
	operation: TransferOperation,
	userId: string,
): Promise<void> {
	if (operation.state === "complete") {
		const counts = operation.receipt?.counts ?? {};
		await recordTransferAudit(db, {
			actorId: userId,
			action: "transfer_import_complete",
			resourceType: "transfer_operation",
			resourceId: operation.id,
			details: {
				packageDigest: operation.packageDigest,
				planDigest: operation.planDigest,
				records: Object.values(counts).reduce((sum, count) => sum + count, 0),
			},
		});
	} else if (operation.state === "failed") {
		await recordTransferAudit(db, {
			actorId: userId,
			action: "transfer_import_fail",
			resourceType: "transfer_operation",
			resourceId: operation.id,
			details: { errorCode: operation.errorCode },
			status: "failure",
		});
	}
}

export async function handleImportReceipt(
	db: Kysely<Database>,
	operationId: string,
): Promise<ApiResult<{ receipt: SiteImportReceipt }>> {
	try {
		const operation = await requireImport(new TransferOperationRepository(db), operationId);
		if (operation.state !== "complete" || !operation.receipt) {
			throw new TransferError("TRANSFER_INVALID_STATE", "Import has no receipt");
		}
		return { success: true, data: { receipt: operation.receipt } };
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to read import receipt");
	}
}

// ── Approvals ───────────────────────────────────────────────────

const APPROVAL_PERMISSION: Readonly<Record<TransferApprovalAction, Permission>> = {
	export: "transfer:export",
	import: "transfer:import",
};

export async function handleApprovalList(
	db: Kysely<Database>,
	options: { status?: ApprovalStatus; cursor?: string; limit?: number },
): Promise<ApiResult<{ items: TransferApproval[]; nextCursor?: string }>> {
	try {
		const page = await new TransferApprovalRepository(db).list({
			status: options.status,
			limit: pageLimit(options.limit),
			cursor: decodeTimeCursor(options.cursor),
		});
		return {
			success: true,
			data: page.next
				? { items: page.items, nextCursor: encodeCursor(page.next.createdAt, page.next.id) }
				: { items: page.items },
		};
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to list approvals");
	}
}

/**
 * Approve or deny a pending grant. The deciding user needs the permission
 * for the grant's action. Callers must only reach this from a session, never
 * with a bearer token.
 */
export async function handleApprovalDecide(
	db: Kysely<Database>,
	input: {
		approvalId: string;
		decision: "approve" | "deny";
		user: { id: string; role: RoleLevel };
	},
): Promise<ApiResult<{ approval: TransferApproval }>> {
	try {
		const approvals = new TransferApprovalRepository(db);
		const approval = await approvals.get(input.approvalId);
		if (!approval) {
			throw new TransferError("TRANSFER_APPROVAL_INVALID", "Approval not found");
		}
		if (!hasPermission(input.user, APPROVAL_PERMISSION[approval.action])) {
			return failure("FORBIDDEN", "Insufficient permissions");
		}
		const decided =
			input.decision === "approve"
				? await approvals.approve(approval.id, input.user.id)
				: await approvals.deny(approval.id, input.user.id);
		await recordTransferAudit(db, {
			actorId: input.user.id,
			action: input.decision === "approve" ? "transfer_approval_approve" : "transfer_approval_deny",
			resourceType: "transfer_approval",
			resourceId: approval.id,
			details: {
				action: approval.action,
				userId: approval.userId,
				...(approval.operationId === null ? {} : { operationId: approval.operationId }),
			},
		});
		return { success: true, data: { approval: decided } };
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to decide approval");
	}
}

export interface RequestTransferApprovalInput {
	/** The user the grant is for: the caller that will consume it. */
	userId: string;
	action: TransferApprovalAction;
	/** The API token the caller is authenticated with, if any. */
	requestedByTokenId?: string;
	operationId?: string;
	paramsDigest?: Sha256Digest;
	packageDigest?: Sha256Digest;
	planDigest?: Sha256Digest;
}

/**
 * Create a pending approval grant for a caller that lacks the transfer scope
 * for `action`, and fail with `TRANSFER_APPROVAL_REQUIRED` carrying its id.
 * An unexpired pending grant with the same binding is returned instead of a
 * new one. An admin approves it in a session; the caller then retries with
 * the id and consumes the grant with `TransferApprovalRepository.consume`.
 */
export async function requestTransferApproval(
	db: Kysely<Database>,
	input: RequestTransferApprovalInput,
): Promise<ErrorResult> {
	try {
		const approvals = new TransferApprovalRepository(db);
		const approval =
			(await approvals.findPending({ ...input, tokenId: input.requestedByTokenId })) ??
			(await approvals.createPending(input));
		return failure("TRANSFER_APPROVAL_REQUIRED", "An admin must approve this transfer", {
			approvalId: approval.id,
			expiresAt: approval.expiresAt,
		});
	} catch (error) {
		return errorResult(error, "TRANSFER_IMPORT_ERROR", "Failed to request approval");
	}
}
