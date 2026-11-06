/**
 * Site transfer operations behind the `site_*` MCP tools.
 *
 * Every result is a bounded summary built field by field from operation rows,
 * plans, manifests, and receipts. Nothing here returns package contents,
 * record values, principal emails, staging secrets, lease tokens, storage
 * keys, or download URLs, and the tools never carry package bytes: imports
 * are uploaded over HTTP (CLI or admin) and referred to by operation id.
 *
 * Starting an export or an import needs the matching transfer scope on the
 * caller's token, or a one-time approval grant. A call without either creates
 * a pending grant bound to the user, the token, and the exact request, and
 * fails with `TRANSFER_APPROVAL_REQUIRED`; an admin approves it in the admin
 * UI, and the caller repeats the call with `approvalId`. Once a grant has
 * started an operation, the same user and token may keep driving and reading
 * that one operation without the scope.
 */

import type { Kysely } from "kysely";

import {
	exportParamsDigest,
	handleExportAdvance,
	handleExportCreate,
	handleExportGet,
	handleImportAdvance,
	handleImportAnalyze,
	handleImportExecute,
	handleImportGet,
	handleImportReceipt,
	handleTransferCapabilities,
	requestTransferApproval,
	type TransferCapabilities,
} from "../api/handlers/transfer.js";
import type { ApiResult } from "../api/types.js";
import type { Database } from "../database/types.js";
import { getI18nConfig } from "../i18n/config.js";
import type { Storage } from "../storage/types.js";
import { loadImportPlan } from "../transfer/analyze/step.js";
import { analysisTargetContext } from "../transfer/analyze/target.js";
import type { TransferApprovalAction } from "../transfer/auth.js";
import { isTransferError, TransferError } from "../transfer/errors.js";
import { openExportPackage } from "../transfer/export/exporter.js";
import type { Sha256Digest } from "../transfer/format/digest.js";
import { RECORD_KINDS, type RecordKind } from "../transfer/format/kinds.js";
import {
	isPlanExecutable,
	type PlanBlocker,
	type PlanWarning,
	type SiteImportDecisionsInput,
	type SiteImportPlan,
} from "../transfer/format/plan.js";
import type { SiteImportReceipt } from "../transfer/format/receipt.js";
import type { PlanTransformation } from "../transfer/format/transformations.js";
import { TransferApprovalRepository } from "../transfer/ops/approvals.js";
import {
	TransferOperationRepository,
	type PublicTransferOperation,
} from "../transfer/ops/operations.js";

/** Plan principals, warnings, and blockers listed per call; the totals are always reported. */
export const MCP_PLAN_LIST_LIMIT = 50;

/** The authenticated MCP caller, as the MCP route resolves it. */
export interface TransferCaller {
	userId: string;
	/** Id of the API or OAuth token; required to request or use an approval grant. */
	tokenId?: string;
}

export interface TransferContext {
	db: Kysely<Database>;
	storage: Storage | null;
	maxUploadSize?: number;
}

type Result<T> = ApiResult<T>;

function failure(code: string, message: string, details?: Record<string, unknown>): Result<never> {
	return {
		success: false,
		error: details === undefined ? { code, message } : { code, message, details },
	};
}

function transferFailure(error: unknown, fallbackCode: string): Result<never> {
	if (isTransferError(error)) return failure(error.code, error.message);
	// Storage errors can name staging keys, which carry the staging secret.
	console.error("[transfer] MCP tool failed:", error);
	return failure(fallbackCode, "Site transfer request failed");
}

function storageMissing(): Result<never> {
	return failure("STORAGE_NOT_CONFIGURED", "No storage backend is configured");
}

function tokenRequired(): Result<never> {
	return failure(
		"INSUFFICIENT_SCOPE",
		"Approval grants need a caller authenticated with an API or OAuth token",
	);
}

// ── Summaries ───────────────────────────────────────────────────

export interface OperationSummary {
	id: string;
	kind: "export" | "import";
	state: string;
	stage: string | null;
	progress: {
		done: number;
		total: number;
		records?: number;
		bytesDone?: number;
		bytesTotal?: number;
	} | null;
	packageDigest: string | null;
	planDigest: string | null;
	error: { code: string } | null;
	createdAt: string;
	updatedAt: string;
	completedAt: string | null;
	expiresAt: string | null;
}

export function summarizeOperation(operation: PublicTransferOperation): OperationSummary {
	const progress = operation.progress;
	return {
		id: operation.id,
		kind: operation.kind,
		state: operation.state,
		stage: operation.stage,
		progress: progress
			? {
					done: progress.done,
					total: progress.total,
					...(progress.records === undefined ? {} : { records: progress.records }),
					...(progress.bytesDone === undefined ? {} : { bytesDone: progress.bytesDone }),
					...(progress.bytesTotal === undefined ? {} : { bytesTotal: progress.bytesTotal }),
				}
			: null,
		packageDigest: operation.packageDigest,
		planDigest: operation.planDigest,
		error: operation.errorCode ? { code: operation.errorCode } : null,
		createdAt: operation.createdAt,
		updatedAt: operation.updatedAt,
		completedAt: operation.completedAt,
		expiresAt: operation.expiresAt,
	};
}

export interface PlanIssueSummary {
	code: string;
	message: string;
	kind?: RecordKind;
	id?: string;
	count?: number;
	detail?: Record<string, string | number | boolean | null>;
}

function summarizeIssue(issue: PlanBlocker | PlanWarning): PlanIssueSummary {
	return {
		code: issue.code,
		message: issue.message,
		...(issue.kind === undefined ? {} : { kind: issue.kind }),
		...(issue.id === undefined ? {} : { id: issue.id }),
		...(issue.count === undefined ? {} : { count: issue.count }),
		...(issue.detail === undefined ? {} : { detail: { ...issue.detail } }),
	};
}

export interface PlanSummary {
	packageDigest: string;
	planDigest: string;
	executable: boolean;
	origin: { siteId: string; packageId: string; createdAt: string; emdashVersion: string };
	counts: Partial<Record<RecordKind, number>>;
	bytes: { records: number; media: number };
	/** Origin users the package references, most referenced first. Emails are never listed here. */
	principals: {
		total: number;
		items: Array<{
			id: string;
			displayName: string;
			references: number;
			suggestedUserId: string | null;
			mappedUserId: string | null;
		}>;
	};
	decisions: { siteTitle: "package" | "target"; siteTagline: "package" | "target" };
	transformations: Array<{ code: string; kind?: string; count: number }>;
	warnings: { total: number; items: PlanIssueSummary[] };
	blockers: { total: number; items: PlanIssueSummary[] };
	estimatedSteps: number;
}

/** How many records a transformation touches; its listed ids and values are not returned. */
function transformationCount(item: PlanTransformation): number {
	switch (item.code) {
		case "redirect_loop_disabled":
		case "search_unsupported":
			return item.ids.length;
		case "locale_recased":
			return item.locales.length;
		default:
			return item.count;
	}
}

export function summarizePlan(plan: SiteImportPlan, planDigest: string): PlanSummary {
	return {
		packageDigest: plan.packageDigest,
		planDigest,
		executable: isPlanExecutable(plan),
		origin: {
			siteId: plan.origin.siteId,
			packageId: plan.origin.packageId,
			createdAt: plan.origin.createdAt,
			emdashVersion: plan.origin.createdByEmDashVersion,
		},
		counts: { ...plan.counts },
		bytes: { records: plan.bytes.records, media: plan.bytes.media },
		principals: {
			total: plan.principals.length,
			items: plan.principals
				.toSorted((a, b) => b.references - a.references || a.id.localeCompare(b.id))
				.slice(0, MCP_PLAN_LIST_LIMIT)
				.map((principal) => ({
					id: principal.id,
					displayName: principal.displayName,
					references: principal.references,
					suggestedUserId: principal.suggestedUserId ?? null,
					mappedUserId: plan.decisions.principalMappings[principal.id] ?? null,
				})),
		},
		decisions: {
			siteTitle: plan.decisions.siteTitle,
			siteTagline: plan.decisions.siteTagline,
		},
		transformations: plan.transformations.map((item) => ({
			code: item.code,
			...("kind" in item ? { kind: item.kind } : {}),
			count: transformationCount(item),
		})),
		warnings: {
			total: plan.warnings.length,
			items: plan.warnings.slice(0, MCP_PLAN_LIST_LIMIT).map(summarizeIssue),
		},
		blockers: {
			total: plan.blockers.length,
			items: plan.blockers.slice(0, MCP_PLAN_LIST_LIMIT).map(summarizeIssue),
		},
		estimatedSteps: plan.estimatedSteps,
	};
}

// ── Access ──────────────────────────────────────────────────────

/**
 * Whether `caller` may drive or read `operationId` through a grant it
 * consumed for it, in place of the transfer scope.
 */
export async function hasOperationGrant(
	db: Kysely<Database>,
	caller: TransferCaller,
	action: TransferApprovalAction,
	operationId: string,
): Promise<boolean> {
	if (caller.tokenId === undefined) return false;
	return new TransferApprovalRepository(db).hasConsumed({
		userId: caller.userId,
		action,
		operationId,
		tokenId: caller.tokenId,
	});
}

// ── Capabilities ────────────────────────────────────────────────

export async function transferCapabilities(
	context: TransferContext,
): Promise<Result<TransferCapabilities>> {
	return handleTransferCapabilities(
		context.db,
		analysisTargetContext({ i18n: getI18nConfig(), maxUploadSize: context.maxUploadSize }),
	);
}

// ── Export ──────────────────────────────────────────────────────

export interface StartExportInput {
	comments?: boolean;
	approvalId?: string;
	/** Whether the caller's token holds `transfer:export`. */
	scoped: boolean;
}

export async function startExport(
	context: TransferContext,
	caller: TransferCaller,
	input: StartExportInput,
): Promise<Result<{ operation: OperationSummary }>> {
	const options = input.comments === undefined ? {} : { comments: input.comments };
	if (!input.scoped) {
		if (caller.tokenId === undefined) return tokenRequired();
		if (input.approvalId === undefined) {
			return withInstruction(
				await requestTransferApproval(context.db, {
					userId: caller.userId,
					action: "export",
					paramsDigest: await exportParamsDigest(options),
					requestedByTokenId: caller.tokenId,
				}),
			);
		}
	}
	const created = await handleExportCreate(context.db, {
		userId: caller.userId,
		options,
		...(input.scoped || input.approvalId === undefined
			? {}
			: { approval: { id: input.approvalId, tokenId: caller.tokenId } }),
	});
	if (!created.success) return created;
	return { success: true, data: { operation: summarizeOperation(created.data.operation) } };
}

/**
 * Put the approval id and the next step in the message text, which is all
 * many MCP clients show the model; `details` carries the same values.
 */
function withInstruction(result: Result<never>): Result<never> {
	if (result.success || result.error.code !== "TRANSFER_APPROVAL_REQUIRED") return result;
	const details = result.error.details ?? {};
	const approvalId = String(details.approvalId);
	const expiresAt = String(details.expiresAt);
	return failure(
		"TRANSFER_APPROVAL_REQUIRED",
		`Approval ${approvalId} is pending until ${expiresAt}. An admin must approve it in the ` +
			"EmDash admin under Settings → Transfer. Then call this tool again with the same " +
			`arguments and approvalId "${approvalId}".`,
		details,
	);
}

export interface ExportTotals {
	records: { total: number; byKind: Partial<Record<RecordKind, number>> };
	media: { count: number; totalBytes: number };
	files: { count: number; totalBytes: number };
}

async function exportTotals(
	db: Kysely<Database>,
	storage: Storage,
	operationId: string,
): Promise<ExportTotals> {
	const operation = await new TransferOperationRepository(db).require(operationId);
	const manifest = await openExportPackage({ db, storage, operation }).manifest();
	const byKind: Partial<Record<RecordKind, number>> = {};
	let total = 0;
	for (const kind of RECORD_KINDS) {
		const summary = manifest.records[kind];
		if (!summary) continue;
		byKind[kind] = summary.count;
		total += summary.count;
	}
	return {
		records: { total, byKind },
		media: { count: manifest.media.count, totalBytes: manifest.media.totalBytes },
		files: { count: manifest.files.count, totalBytes: manifest.files.totalBytes },
	};
}

export interface ExportStatus {
	operation: OperationSummary;
	/** Present once the export is complete. */
	totals?: ExportTotals;
	/** Milliseconds until the next call makes progress, or null once the export has ended. */
	nextRequestInMs: number | null;
}

export async function exportStatus(
	context: TransferContext,
	input: { operationId: string; advance: boolean },
): Promise<Result<ExportStatus>> {
	let operation: PublicTransferOperation;
	let nextRequestInMs: number | null;
	if (input.advance) {
		if (!context.storage) return storageMissing();
		const step = await handleExportAdvance(context.db, context.storage, {
			operationId: input.operationId,
		});
		if (!step.success) return step;
		operation = step.data.operation;
		nextRequestInMs = step.data.nextRequestInMs;
	} else {
		const read = await handleExportGet(context.db, input.operationId);
		if (!read.success) return read;
		operation = read.data.operation;
		nextRequestInMs = operation.state === "pending" || operation.state === "running" ? 0 : null;
	}
	const status: ExportStatus = { operation: summarizeOperation(operation), nextRequestInMs };
	if (operation.state === "complete" && operation.stagingCollectedAt === null) {
		if (!context.storage) return storageMissing();
		try {
			status.totals = await exportTotals(context.db, context.storage, operation.id);
		} catch (error) {
			return transferFailure(error, "TRANSFER_EXPORT_ERROR");
		}
	}
	return { success: true, data: status };
}

// ── Import ──────────────────────────────────────────────────────

export interface AnalyzeStatus {
	operation: OperationSummary;
	plan?: PlanSummary;
	nextRequestInMs: number | null;
}

export async function analyzeImport(
	context: TransferContext,
	input: { operationId: string; decisions?: SiteImportDecisionsInput },
): Promise<Result<AnalyzeStatus>> {
	if (!context.storage) return storageMissing();
	const result = await handleImportAnalyze(context.db, context.storage, {
		operationId: input.operationId,
		decisions: input.decisions,
		target: analysisTargetContext({
			i18n: getI18nConfig(),
			maxUploadSize: context.maxUploadSize,
		}),
	});
	if (!result.success) return result;
	const { operation, plan, planDigest, nextRequestInMs } = result.data;
	return {
		success: true,
		data: {
			operation: summarizeOperation(operation),
			...(plan && planDigest ? { plan: summarizePlan(plan, planDigest) } : {}),
			nextRequestInMs,
		},
	};
}

export interface StartImportInput {
	operationId: string;
	packageDigest: Sha256Digest;
	planDigest: Sha256Digest;
	approvalId?: string;
	/** Whether the caller's token holds `transfer:execute`. */
	scoped: boolean;
}

/**
 * Check what `handleImportExecute` would, before a pending grant is created,
 * so an admin is only ever asked to approve an import that can run.
 */
async function assertExecutable(
	context: TransferContext & { storage: Storage },
	input: StartImportInput,
): Promise<void> {
	const operation = await new TransferOperationRepository(context.db).get(input.operationId);
	if (!operation || operation.kind !== "import") {
		throw new TransferError("TRANSFER_OPERATION_NOT_FOUND", "Transfer operation not found");
	}
	if (operation.packageDigest !== input.packageDigest) {
		throw new TransferError("TRANSFER_PACKAGE_DIGEST_MISMATCH", "Package digest does not match");
	}
	if (operation.planDigest === null || operation.planDigest !== input.planDigest) {
		throw new TransferError("TRANSFER_PLAN_DIGEST_MISMATCH", "Plan digest does not match");
	}
	if (operation.state !== "planned") {
		throw new TransferError("TRANSFER_INVALID_STATE", "Import is not waiting to be started");
	}
	const plan = await loadImportPlan(context.storage, operation);
	if (!plan || !isPlanExecutable(plan)) {
		throw new TransferError("TRANSFER_PLAN_BLOCKED", "The import plan has blockers");
	}
}

export async function startImport(
	context: TransferContext,
	caller: TransferCaller,
	input: StartImportInput,
): Promise<Result<{ operation: OperationSummary }>> {
	const storage = context.storage;
	if (!storage) return storageMissing();
	if (!input.scoped) {
		if (caller.tokenId === undefined) return tokenRequired();
		if (input.approvalId === undefined) {
			try {
				await assertExecutable({ ...context, storage }, input);
			} catch (error) {
				return transferFailure(error, "TRANSFER_IMPORT_ERROR");
			}
			return withInstruction(
				await requestTransferApproval(context.db, {
					userId: caller.userId,
					action: "import",
					operationId: input.operationId,
					packageDigest: input.packageDigest,
					planDigest: input.planDigest,
					requestedByTokenId: caller.tokenId,
				}),
			);
		}
	}
	const executed = await handleImportExecute(context.db, storage, {
		operationId: input.operationId,
		userId: caller.userId,
		packageDigest: input.packageDigest,
		planDigest: input.planDigest,
		...(input.scoped || input.approvalId === undefined
			? {}
			: { approval: { id: input.approvalId, tokenId: caller.tokenId } }),
	});
	if (!executed.success) return executed;
	return { success: true, data: { operation: summarizeOperation(executed.data.operation) } };
}

export interface ImportStatus {
	operation: OperationSummary;
	files: { declared: number; verified: number };
}

export async function importStatus(
	context: TransferContext,
	operationId: string,
): Promise<Result<ImportStatus>> {
	const result = await handleImportGet(context.db, operationId);
	if (!result.success) return result;
	return {
		success: true,
		data: {
			operation: summarizeOperation(result.data.operation),
			files: { declared: result.data.files.declared, verified: result.data.files.verified },
		},
	};
}

export async function resumeImport(
	context: TransferContext,
	caller: TransferCaller,
	operationId: string,
): Promise<Result<{ operation: OperationSummary; nextRequestInMs: number | null }>> {
	if (!context.storage) return storageMissing();
	const step = await handleImportAdvance(context.db, context.storage, {
		operationId,
		userId: caller.userId,
	});
	if (!step.success) return step;
	return {
		success: true,
		data: {
			operation: summarizeOperation(step.data.operation),
			nextRequestInMs: step.data.nextRequestInMs,
		},
	};
}

export async function importReceipt(
	context: TransferContext,
	operationId: string,
): Promise<Result<{ receipt: SiteImportReceipt }>> {
	return handleImportReceipt(context.db, operationId);
}
