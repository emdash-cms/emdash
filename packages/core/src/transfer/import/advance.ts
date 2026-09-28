/**
 * Import execution: one bounded `advanceImport` step at a time.
 *
 * Stages (`IMPORT_STAGES`): reserve → clear_scaffold → schema → media →
 * terms_bylines → content → relations → presentation → rebuild → verify.
 * Every step claims the operation's lease, runs units until the stage work
 * or the step budget runs out, and checkpoints the typed cursor after each
 * unit through the lease-fenced operation repository. Every unit is
 * idempotent, so an interrupted step is resumed by advancing again (after
 * the lease expires if the interrupted caller still held it). Cancellation
 * requested while a step runs is honored at the next checkpoint.
 */

import type { Kysely } from "kysely";
import type { z } from "zod";

import { isPostgres } from "../../database/dialect-helpers.js";
import type { Database } from "../../database/types.js";
import type { Storage } from "../../storage/types.js";
import { chunks, SQL_BATCH_SIZE } from "../../utils/chunks.js";
import { isMissingTableError } from "../../utils/db-errors.js";
import { VERSION } from "../../version.js";
import { inspectPortableDomain } from "../domain.js";
import { isTransferError, TransferError, type TransferErrorCode } from "../errors.js";
import { planDigest, type Sha256Digest } from "../format/digest.js";
import { IMPORT_RECORD_STAGES } from "../format/kinds.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import { isPlanExecutable, siteImportPlanSchema, type SiteImportPlan } from "../format/plan.js";
import { sealReceipt } from "../format/receipt.js";
import { SITE_PACKAGE_FORMAT_VERSION } from "../format/version.js";
import { TransferStepBudget } from "../ops/budget.js";
import { TransferOperationRepository, type TransferOperation } from "../ops/operations.js";
import { TransferStagedFileRepository } from "../ops/staged-files.js";
import {
	EXECUTING_IMPORT_STATES,
	type ImportCursor,
	IMPORT_STAGES,
	type ImportStage,
	isTerminalState,
} from "../ops/states.js";
import { getOrCreateSiteId } from "../site-id.js";
import { stagingPrefix } from "../staging/keys.js";
import { StagedPackageReader } from "../staging/package.js";
import { TransferStage } from "../staging/stage.js";
import { ImportContext } from "./context.js";
import { runRebuild } from "./rebuild.js";
import { clearScaffold, declaredScaffold } from "./scaffold.js";
import { firstPosition, ImportCancelledSignal, runRecordStage } from "./stages.js";

/** Delay the caller should wait before advancing again after a retry-later step. */
export const IMPORT_RETRY_MS = 2000;

export interface VerifyImportStepInput {
	db: Kysely<Database>;
	storage: Storage;
	operationId: string;
	reader: StagedPackageReader;
	plan: SiteImportPlan;
	/** The verifier's cursor from its previous step, or null on the first step. */
	cursor: unknown;
	budget: TransferStepBudget;
}

export type VerifyImportStepResult =
	| { done: false; cursor: unknown }
	| {
			done: true;
			logicalDigest: Sha256Digest;
			counts: Record<string, number>;
			mismatches: Array<{ kind: string; id: string; reason: string }>;
	  };

export type VerifyImportStep = (input: VerifyImportStepInput) => Promise<VerifyImportStepResult>;

export interface AdvanceImportOptions {
	db: Kysely<Database>;
	storage: Storage;
	operationId: string;
	/** Verification step (`verifyImportStep` from `transfer/export/verify.ts`). */
	verify: VerifyImportStep;
	/** Defaults to a budget over the current request's query metrics. */
	budget?: TransferStepBudget;
}

export interface AdvanceImportResult {
	operation: TransferOperation;
	/** When to advance again; null once the operation is terminal. */
	nextRequestInMs: number | null;
	/** Whether this step moved the import to a terminal state. */
	ended: boolean;
}

type StepResult = Omit<AdvanceImportResult, "ended">;

/** Errors another caller's lease explains; the step is abandoned without touching the operation. */
const LEASE_CODES: ReadonlySet<TransferErrorCode> = new Set([
	"TRANSFER_LEASE_LOST",
	"TRANSFER_LEASE_ACTIVE",
]);

/**
 * Failures a later step may not hit again, and how many consecutive steps
 * may fail without progress before the import fails. A staged file that
 * cannot be read is usually gone for good, so it gets few attempts; storage
 * and database errors are more often passing. Every other transfer error
 * fails the import at once.
 */
const RETRY_LIMITS: Readonly<Partial<Record<TransferErrorCode, number>>> = {
	TRANSFER_FILE_MISSING: 3,
	TRANSFER_STORAGE_ERROR: 8,
	TRANSFER_IMPORT_ERROR: 8,
};

const MAX_RETRY_DELAY_MS = 60_000;

/** Delay before the `attempts`th retry: doubling from `IMPORT_RETRY_MS`. */
export function importRetryDelay(attempts: number): number {
	return Math.min(IMPORT_RETRY_MS * 2 ** Math.max(0, attempts - 1), MAX_RETRY_DELAY_MS);
}

const EXECUTABLE_STATES = ["planned", "running", "verifying"] as const;

function result(operation: TransferOperation, nextRequestInMs: number): StepResult {
	return {
		operation,
		nextRequestInMs: isTerminalState(operation.kind, operation.state) ? null : nextRequestInMs,
	};
}

/**
 * Mark a planned import for execution. Requires the digests the caller
 * reviewed; the first `advanceImport` then reserves the target. Repeating
 * the request for an import that already started returns it unchanged, with
 * `requested` false.
 */
export async function requestImportExecution(input: {
	db: Kysely<Database>;
	operationId: string;
	packageDigest: Sha256Digest;
	planDigest: Sha256Digest;
}): Promise<{ operation: TransferOperation; requested: boolean }> {
	const ops = new TransferOperationRepository(input.db);
	const operation = await ops.require(input.operationId);
	if (operation.kind !== "import") {
		throw new TransferError("TRANSFER_INVALID_STATE", "Operation is not an import");
	}
	if (operation.packageDigest !== input.packageDigest) {
		throw new TransferError("TRANSFER_PACKAGE_DIGEST_MISMATCH", "Package digest does not match");
	}
	if (operation.planDigest === null || operation.planDigest !== input.planDigest) {
		throw new TransferError("TRANSFER_PLAN_DIGEST_MISMATCH", "Plan digest does not match");
	}
	if (operation.state !== "planned" || operation.stage === "reserve") {
		const started =
			(EXECUTING_IMPORT_STATES as readonly string[]).includes(operation.state) ||
			operation.mutationStartedAt !== null;
		if (operation.state === "planned" || started) return { operation, requested: false };
		throw new TransferError("TRANSFER_INVALID_STATE", "Import cannot be executed in its state");
	}
	const claim = await ops.claim(operation.id, ["planned"]);
	if (claim.outcome === "lease_active") {
		throw new TransferError("TRANSFER_LEASE_ACTIVE", "Import is busy; try again");
	}
	if (claim.outcome === "invalid_state") {
		throw new TransferError("TRANSFER_INVALID_STATE", "Import cannot be executed in its state");
	}
	const requested = await ops.release(operation.id, claim.leaseToken, {
		stage: "reserve",
		cursor: { stage: "reserve" },
	});
	return { operation: requested, requested: true };
}

export async function advanceImport(options: AdvanceImportOptions): Promise<AdvanceImportResult> {
	const ops = new TransferOperationRepository(options.db);
	const claim = await ops.claim(options.operationId, EXECUTABLE_STATES);
	if (claim.outcome !== "claimed") {
		if (claim.operation.kind !== "import") {
			throw new TransferError("TRANSFER_INVALID_STATE", "Operation is not an import");
		}
		return { ...result(claim.operation, IMPORT_RETRY_MS), ended: false };
	}
	// Only the lease holder moves a claimed import to a terminal state.
	const step = await advanceClaimed(options, ops, claim.operation, claim.leaseToken);
	return { ...step, ended: isTerminalState(step.operation.kind, step.operation.state) };
}

async function advanceClaimed(
	options: AdvanceImportOptions,
	ops: TransferOperationRepository,
	operation: TransferOperation,
	leaseToken: string,
): Promise<StepResult> {
	if (
		operation.kind !== "import" ||
		(operation.state === "planned" && operation.stage !== "reserve")
	) {
		await ops.release(operation.id, leaseToken);
		throw new TransferError(
			"TRANSFER_INVALID_STATE",
			"Import has not been requested for execution",
		);
	}

	try {
		if (await mediaUsageActivating(options.db)) {
			return result(await ops.release(operation.id, leaseToken), IMPORT_RETRY_MS);
		}
		const context = await loadContext(options, ops, operation, leaseToken);
		return await runStep(context, options.verify);
	} catch (error) {
		if (error instanceof ImportCancelledSignal) {
			return result(await ops.finishCancelled(operation.id, leaseToken), 0);
		}
		if (isTransferError(error) && LEASE_CODES.has(error.code)) throw error;
		const code: TransferErrorCode = isTransferError(error) ? error.code : "TRANSFER_IMPORT_ERROR";
		const detail = isTransferError(error) ? error.detail : undefined;
		const limit = RETRY_LIMITS[code];
		if (limit === undefined || (isTransferError(error) && code === "TRANSFER_IMPORT_ERROR")) {
			return result(await ops.fail(operation.id, leaseToken, { code, detail }), 0);
		}
		if (!isTransferError(error)) console.error("[transfer] import step failed:", error);
		const latest = await ops.require(operation.id);
		const attempts = retryAttempts(latest) + 1;
		const retryDetail = { ...detail, attempts };
		if (attempts >= limit) {
			return result(await ops.fail(operation.id, leaseToken, { code, detail: retryDetail }), 0);
		}
		const released = await ops.release(operation.id, leaseToken, {
			retryError: { code, detail: retryDetail },
		});
		return result(released, importRetryDelay(attempts));
	}
}

/** Consecutive failed steps recorded since the import last made progress. */
function retryAttempts(operation: TransferOperation): number {
	if (operation.errorCode === null || isTerminalState(operation.kind, operation.state)) return 0;
	const attempts = operation.errorDetail?.attempts;
	return typeof attempts === "number" ? attempts : 0;
}

async function mediaUsageActivating(db: Kysely<Database>): Promise<boolean> {
	try {
		const row = await db
			.selectFrom("_emdash_media_usage_activation")
			.select("state")
			.where("task_key", "=", "incremental_capture")
			.executeTakeFirst();
		return row?.state === "activating";
	} catch (error) {
		if (isMissingTableError(error)) return false;
		throw error;
	}
}

async function loadContext(
	options: AdvanceImportOptions,
	ops: TransferOperationRepository,
	operation: TransferOperation,
	leaseToken: string,
): Promise<ImportContext> {
	const stage = new TransferStage(
		options.storage,
		stagingPrefix("import", operation.id, operation.stagingSecret),
	);
	const reader = new StagedPackageReader(
		stage,
		new TransferStagedFileRepository(options.db).verifiedDigests(operation.id),
	);
	const manifest = await reader.manifest();
	const packageDigest = await reader.digest();
	if (operation.packageDigest !== packageDigest) {
		throw new TransferError("TRANSFER_PACKAGE_DIGEST_MISMATCH", "Staged package does not match");
	}
	const planText = await stage.readAux("plan", TRANSFER_LIMITS.manifestBytes);
	if (planText === null) {
		throw new TransferError("TRANSFER_PLAN_DIGEST_MISMATCH", "Import plan is missing");
	}
	const parsed = siteImportPlanSchema.safeParse(JSON.parse(planText));
	if (!parsed.success || (await planDigest(parsed.data)) !== operation.planDigest) {
		throw new TransferError("TRANSFER_PLAN_DIGEST_MISMATCH", "Import plan does not match");
	}
	const plan = parsed.data;
	if (plan.packageDigest !== packageDigest) {
		throw new TransferError("TRANSFER_PLAN_DIGEST_MISMATCH", "Plan is for another package");
	}
	if (!isPlanExecutable(plan)) {
		throw new TransferError("TRANSFER_PLAN_BLOCKED", "Import plan has blockers");
	}
	return new ImportContext(
		options.db,
		options.storage,
		ops,
		operation,
		leaseToken,
		plan,
		manifest,
		reader,
		options.budget ?? new TransferStepBudget(),
	);
}

function stageProgress(stage: ImportStage) {
	return { done: IMPORT_STAGES.indexOf(stage), total: IMPORT_STAGES.length };
}

async function checkpoint(
	context: ImportContext,
	cursor: ImportCursor,
	patch: { state?: "running" | "verifying"; markMutationStarted?: true } = {},
): Promise<void> {
	const operation = await context.ops.advance(context.operationId, context.leaseToken, {
		...patch,
		...(context.operation.errorCode === null ? {} : { retryError: null }),
		stage: cursor.stage,
		cursor,
		progress: stageProgress(cursor.stage),
	});
	context.operation = operation;
	if (operation.cancelRequestedAt !== null) throw new ImportCancelledSignal();
}

function currentCursor(operation: TransferOperation): ImportCursor {
	const cursor = operation.cursor;
	if (cursor === null) return { stage: "reserve" };
	if (!(IMPORT_STAGES as readonly string[]).includes(cursor.stage)) {
		throw new TransferError("TRANSFER_INVALID_STATE", "Operation cursor is not an import cursor");
	}
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- stage checked against IMPORT_STAGES
	return cursor as ImportCursor;
}

function nextRecordStageCursor(stage: ImportStage): ImportCursor {
	const next = IMPORT_STAGES[IMPORT_STAGES.indexOf(stage) + 1];
	if (next === "rebuild") return { stage: "rebuild", step: "search", after: null };
	const recordStage = IMPORT_RECORD_STAGES.find((candidate: string) => candidate === next);
	if (!recordStage) throw new Error(`No record stage follows ${stage}`);
	return { stage: recordStage, position: firstPosition(recordStage) };
}

/** The checkpoint that moves the cursor to the next stage. */
const TRANSITION_STATEMENTS = 1;

async function yieldStep(context: ImportContext, nextRequestInMs: number): Promise<StepResult> {
	return result(
		await context.ops.release(context.operationId, context.leaseToken),
		nextRequestInMs,
	);
}

async function runStep(context: ImportContext, verify: VerifyImportStep): Promise<StepResult> {
	for (;;) {
		const cursor = currentCursor(context.operation);
		switch (cursor.stage) {
			case "reserve":
				await reserve(context);
				break;
			case "clear_scaffold": {
				const progress = await clearScaffold(context, cursor.step, (step) =>
					checkpoint(context, { stage: "clear_scaffold", step }),
				);
				if (progress.state === "continue") return yieldStep(context, 0);
				if (progress.state === "wait") return yieldStep(context, IMPORT_RETRY_MS);
				if (!context.budget.canStart({ queries: TRANSITION_STATEMENTS })) {
					return yieldStep(context, 0);
				}
				await checkpoint(context, { stage: "schema", position: firstPosition("schema") });
				break;
			}
			case "schema":
			case "media":
			case "terms_bylines":
			case "content":
			case "relations":
			case "presentation": {
				const stage = cursor.stage;
				const remaining = await runRecordStage(context, stage, cursor.position, (position) =>
					checkpoint(context, { stage, position }),
				);
				if (remaining || !context.budget.canStart({ queries: TRANSITION_STATEMENTS })) {
					return yieldStep(context, 0);
				}
				await checkpoint(context, nextRecordStageCursor(stage));
				break;
			}
			case "rebuild": {
				const remaining = await runRebuild(
					context,
					{ step: cursor.step, after: cursor.after },
					(position) => checkpoint(context, { stage: "rebuild", ...position }),
				);
				if (remaining) return yieldStep(context, 0);
				await checkpoint(
					context,
					{ stage: "verify", position: null, mediaAfter: null, mismatches: 0 },
					{ state: "verifying" },
				);
				break;
			}
			case "verify":
				return runVerify(context, verify, cursor.verifier ?? null);
		}
	}
}

async function reserve(context: ImportContext): Promise<void> {
	// Running fences site writes before the checks below, so none can slip in
	// between them and the first write; a failed check leaves no fence behind
	// because the mutation has not started.
	await checkpoint(context, { stage: "reserve" }, { state: "running" });
	const siteId = await getOrCreateSiteId(context.db);
	const dialect = isPostgres(context.db) ? "postgres" : "sqlite";
	if (siteId !== context.plan.target.siteId || dialect !== context.plan.target.dialect) {
		throw new TransferError("TRANSFER_PLAN_DIGEST_MISMATCH", "Plan was made for another target");
	}
	await assertMappedUsersExist(context);
	const domain = await inspectPortableDomain(context.db);
	const declared = new Set(declaredScaffold(context).map((item) => `${item.type}:${item.id}`));
	const undeclared = domain.seededScaffold.filter(
		(item) => !declared.has(`${item.type}:${item.id}`),
	);
	if (!domain.empty || undeclared.length > 0) {
		throw new TransferError("TRANSFER_TARGET_NOT_EMPTY", "The target site is not empty", {
			detail: { blockers: domain.blockers.length, undeclaredScaffold: undeclared.length },
		});
	}
	await checkpoint(context, { stage: "clear_scaffold", step: 0 }, { markMutationStarted: true });
}

async function assertMappedUsersExist(context: ImportContext): Promise<void> {
	const mappings = Object.entries(context.plan.decisions.principalMappings);
	const userIds = [...new Set(mappings.flatMap(([, userId]) => (userId === null ? [] : [userId])))];
	const found = new Set<string>();
	for (const batch of chunks(userIds, SQL_BATCH_SIZE)) {
		const rows = await context.db
			.selectFrom("users")
			.select("id")
			.where("id", "in", batch)
			.execute();
		for (const row of rows) found.add(row.id);
	}
	const missing = mappings.find(([, userId]) => userId !== null && !found.has(userId));
	if (missing) {
		throw new TransferError("TRANSFER_DECISIONS_INVALID", "A mapped target user no longer exists", {
			detail: { principal: missing[0] },
		});
	}
}

async function runVerify(
	context: ImportContext,
	verify: VerifyImportStep,
	start: unknown,
): Promise<StepResult> {
	const step = await verify({
		db: context.db,
		storage: context.storage,
		operationId: context.operationId,
		reader: context.reader,
		plan: context.plan,
		cursor: start,
		budget: context.budget,
	});
	// The verifier runs until its budget is spent, so an unfinished step ends this one.
	if (!step.done) {
		await checkpoint(context, {
			stage: "verify",
			position: null,
			mediaAfter: null,
			mismatches: 0,
			verifier: toJson(step.cursor),
		});
		return yieldStep(context, 0);
	}
	if (step.mismatches.length > 0) {
		const detail: Record<string, string | number> = { mismatches: step.mismatches.length };
		step.mismatches.slice(0, TRANSFER_LIMITS.verificationMismatches).forEach((mismatch, index) => {
			detail[`mismatch_${index}`] = `${mismatch.kind}:${mismatch.id}:${mismatch.reason}`.slice(
				0,
				512,
			);
		});
		throw new TransferError(
			"TRANSFER_VERIFICATION_FAILED",
			"Imported site does not match the package",
			{
				detail,
			},
		);
	}
	const operation = context.operation;
	if (operation.packageDigest === null || operation.planDigest === null) {
		throw new TransferError("TRANSFER_INVALID_STATE", "Import digests are missing");
	}
	const receipt = await sealReceipt({
		operationId: operation.id,
		packageDigest: operation.packageDigest,
		planDigest: operation.planDigest,
		targetSiteId: context.plan.target.siteId,
		originSiteId: context.manifest.originSiteId,
		formatVersion: SITE_PACKAGE_FORMAT_VERSION,
		importerEmDashVersion: VERSION,
		completedAt: new Date().toISOString(),
		logicalDigest: step.logicalDigest,
		counts: step.counts,
		warnings: context.plan.warnings
			.slice(0, 500)
			.map((warning) => ({ code: warning.code, message: warning.message })),
		verification: "verified",
	});
	const completed = await context.ops.complete(operation.id, context.leaseToken, {
		receipt,
		progress: { done: IMPORT_STAGES.length, total: IMPORT_STAGES.length },
	});
	return result(completed, 0);
}

function toJson(value: unknown): z.infer<ReturnType<typeof z.json>> {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion -- the verifier's cursor is plain JSON by contract; the cursor schema validates it on write
	return value as z.infer<ReturnType<typeof z.json>>;
}
