/**
 * The import analysis operation: validation, target inspection, and the plan,
 * driven in bounded steps under the operation's lease.
 *
 * Progress lives in the operation cursor plus a state file in the
 * operation's staging area keyed by that cursor's digest. A step writes the
 * state for its new cursor before it moves the cursor, so a step that dies
 * midway leaves the previous cursor and its state intact and the next step
 * repeats the work (package index writes are insert-if-absent).
 */

import type { Kysely } from "kysely";
import { z } from "zod";

import { detectDialect } from "../../database/dialect-helpers.js";
import { OptionsRepository } from "../../database/repositories/options.js";
import type { Database } from "../../database/types.js";
import type { Storage } from "../../storage/types.js";
import { isTransferError, TransferError } from "../errors.js";
import { canonicalJson, parseCanonicalJson } from "../format/canonical.js";
import { canonicalDigest, planDigest, sha256Hex, type Sha256Digest } from "../format/digest.js";
import { compareIds, portableIdSchema, RECORD_KINDS } from "../format/kinds.js";
import { TRANSFER_LIMITS } from "../format/limits.js";
import type { SitePackageManifest } from "../format/manifest.js";
import { MANIFEST_PATH, recordChunkPath } from "../format/paths.js";
import {
	mergeDecisions,
	siteImportDecisionsInputSchema,
	siteImportPlanSchema,
	type SiteImportPlan,
} from "../format/plan.js";
import type { TransferStepBudget } from "../ops/budget.js";
import { TransferOperationRepository, type TransferOperation } from "../ops/operations.js";
import { TransferStagedFileRepository } from "../ops/staged-files.js";
import { analysisCursorSchema, type AnalysisCursor, type TransferProgress } from "../ops/states.js";
import { getOrCreateSiteId } from "../site-id.js";
import { stagingPrefix } from "../staging/keys.js";
import { StagedPackageReader } from "../staging/package.js";
import { readStreamBytes, TransferStage } from "../staging/stage.js";
import {
	applyDecisions,
	buildBlockedPlan,
	buildPlan,
	defaultDecisions,
	type PrincipalBylines,
} from "./plan.js";
import {
	checkLocales,
	localeRecasing,
	findMissingUsers,
	findRedirectLoops,
	inspectTargetDomain,
	suggestPrincipalUsers,
	type AnalysisTargetContext,
} from "./target.js";
import {
	initialValidationState,
	parseValidationState,
	runValidationStep,
	summarizeValidation,
	type ValidationState,
	type ValidationStepResult,
} from "./validate.js";

const ANALYSIS_DIRECTORY = "_analysis/";
const MAX_STATE_BYTES = 64 * 1024 * 1024;
const MAX_PLAN_BYTES = 64 * 1024 * 1024;

const ANALYZABLE_STATES = ["uploading", "analyzing"] as const;

export interface AnalyzeImportStepInput {
	db: Kysely<Database>;
	storage: Storage;
	operationId: string;
	/** A lease the caller already holds on the operation; claimed here when omitted. */
	leaseToken?: string;
	budget: TransferStepBudget;
	targetContext: AnalysisTargetContext;
}

export interface AnalyzeImportStepResult {
	operation: TransferOperation;
	/** True once the operation is `planned` (or ended); false when more steps are needed. */
	done: boolean;
	plan: SiteImportPlan | null;
	planDigest: Sha256Digest | null;
}

const analysisContextSchema = z.strictObject({
	version: z.literal(1),
	principalBylineLocales: z.array(z.tuple([z.string(), z.array(z.string())])),
	principalsWithSharedLocaleBylines: z.array(z.string()),
});

type AnalysisContextFile = z.infer<typeof analysisContextSchema>;

function stageFor(storage: Storage, operation: TransferOperation): TransferStage {
	return new TransferStage(storage, stagingPrefix("import", operation.id, operation.stagingSecret));
}

async function stateKey(stage: TransferStage, cursor: AnalysisCursor): Promise<string> {
	return `${stage.prefix}${ANALYSIS_DIRECTORY}state-${await sha256Hex(canonicalJson(cursor))}.json`;
}

function contextKey(stage: TransferStage): string {
	return `${stage.prefix}${ANALYSIS_DIRECTORY}context.json`;
}

async function readJson(storage: Storage, key: string, maxBytes: number): Promise<unknown> {
	if (!(await storage.exists(key))) return null;
	const download = await storage.download(key);
	return JSON.parse(new TextDecoder().decode(await readStreamBytes(download.body, maxBytes)));
}

async function writeJson(storage: Storage, key: string, value: unknown): Promise<void> {
	await storage.upload({
		key,
		body: new TextEncoder().encode(JSON.stringify(value)),
		contentType: "application/json",
	});
}

function cursorFor(state: ValidationState): AnalysisCursor {
	const kind = RECORD_KINDS[state.kindIndex];
	switch (state.phase) {
		case "structure":
			return { stage: "analyze_structure", nextIndexSeq: state.nextIndexSeq };
		case "records":
			if (kind) {
				return { stage: "analyze_records", position: { kind, seq: state.seq, line: 0 } };
			}
			return { stage: "analyze_references", check: state.kindIndex, after: null };
		case "references":
			return {
				stage: "analyze_references",
				check: state.kindIndex,
				after: kind && state.seq > 0 ? recordChunkPath(kind, state.seq - 1) : null,
			};
		case "done":
			return { stage: "analyze_target" };
	}
}

function chunksBefore(
	manifest: SitePackageManifest | null,
	kindIndex: number,
	seq: number,
): { before: number; total: number } {
	let before = 0;
	let total = 0;
	RECORD_KINDS.forEach((kind, index) => {
		const chunks = manifest?.records[kind]?.chunks ?? 0;
		total += chunks;
		if (index < kindIndex) before += chunks;
	});
	return { before: before + seq, total };
}

function progressFor(
	state: ValidationState,
	manifest: SitePackageManifest | null,
): TransferProgress {
	const indexChunks = manifest?.index.length ?? 0;
	const { before, total: recordChunks } = chunksBefore(manifest, state.kindIndex, state.seq);
	const total = indexChunks + 2 * recordChunks + 1;
	switch (state.phase) {
		case "structure":
			return { done: Math.min(state.nextIndexSeq, indexChunks), total };
		case "records":
			return { done: indexChunks + before, total };
		case "references":
			return { done: indexChunks + recordChunks + before, total };
		case "done":
			return { done: total - 1, total };
	}
}

async function loadValidationState(
	stage: TransferStage,
	cursor: TransferOperation["cursor"],
): Promise<ValidationState> {
	const analysisCursor = analysisCursorSchema.safeParse(cursor);
	if (!analysisCursor.success) return initialValidationState();
	const raw = await readJson(
		stage.storage,
		await stateKey(stage, analysisCursor.data),
		MAX_STATE_BYTES,
	);
	return raw === null ? initialValidationState() : parseValidationState(raw);
}

async function readManifestSafely(
	reader: StagedPackageReader,
): Promise<SitePackageManifest | null> {
	try {
		return await reader.manifest();
	} catch (error) {
		if (isTransferError(error)) return null;
		throw error;
	}
}

const looseIdentitySchema = z.looseObject({
	packageId: portableIdSchema,
	originSiteId: portableIdSchema,
	createdAt: z.string().min(1).max(64),
	createdByEmDashVersion: z.string().min(1).max(128),
});

/**
 * Identity and digest of a manifest that failed full validation, when its
 * identity fields are still well-formed.
 */
async function looseManifestIdentity(stage: TransferStage): Promise<{
	digest: Sha256Digest;
	origin: z.infer<typeof looseIdentitySchema>;
} | null> {
	try {
		const bytes = await stage.readBytes(MANIFEST_PATH, TRANSFER_LIMITS.manifestBytes);
		const raw = parseCanonicalJson(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
		const identity = looseIdentitySchema.safeParse(raw);
		if (!identity.success) return null;
		return { digest: await canonicalDigest(raw), origin: identity.data };
	} catch {
		return null;
	}
}

async function readTargetSettings(
	db: Kysely<Database>,
): Promise<{ title?: string; tagline?: string }> {
	const options = new OptionsRepository(db);
	const title = await options.get("site:title");
	const tagline = await options.get("site:tagline");
	return {
		...(typeof title === "string" ? { title } : {}),
		...(typeof tagline === "string" ? { tagline } : {}),
	};
}

function principalBylinesFrom(file: AnalysisContextFile): PrincipalBylines {
	return {
		locales: new Map(file.principalBylineLocales.map(([id, locales]) => [id, new Set(locales)])),
		sharedLocale: new Set(file.principalsWithSharedLocaleBylines),
	};
}

async function storePlan(
	stage: TransferStage,
	plan: SiteImportPlan,
	context: AnalysisContextFile,
): Promise<Sha256Digest> {
	await writeJson(stage.storage, contextKey(stage), context);
	await stage.putAux("plan", canonicalJson(plan));
	return planDigest(plan);
}

async function buildAnalysisPlan(
	input: AnalyzeImportStepInput,
	stage: TransferStage,
	reader: StagedPackageReader,
	validation: ValidationStepResult,
): Promise<{ plan: SiteImportPlan; context: AnalysisContextFile } | null> {
	const { db, targetContext } = input;
	const target = {
		siteId: await getOrCreateSiteId(db),
		dialect: detectDialect(db),
		emdashVersion: targetContext.emdashVersion,
	};
	const manifest = await readManifestSafely(reader);
	if (!manifest) {
		const identity = await looseManifestIdentity(stage);
		if (!identity) return null;
		return {
			plan: buildBlockedPlan({
				packageDigest: identity.digest,
				origin: {
					siteId: identity.origin.originSiteId,
					packageId: identity.origin.packageId,
					createdAt: identity.origin.createdAt,
					createdByEmDashVersion: identity.origin.createdByEmDashVersion,
				},
				target,
				blockers: validation.blockers,
				warnings: validation.warnings,
			}),
			context: { version: 1, principalBylineLocales: [], principalsWithSharedLocaleBylines: [] },
		};
	}

	const summary = summarizeValidation(validation.state);
	const domain = await inspectTargetDomain(db, summary.collectionSlugs);
	const redirectLoops = await findRedirectLoops(
		manifest,
		stage,
		new TransferStagedFileRepository(db),
		input.operationId,
	);
	const context: AnalysisContextFile = {
		version: 1,
		principalBylineLocales: Array.from(
			summary.principalBylineLocales,
			([id, locales]): [string, string[]] => [id, [...locales].toSorted(compareIds)],
		).toSorted(([a], [b]) => compareIds(a, b)),
		principalsWithSharedLocaleBylines: [...summary.principalsWithSharedLocaleBylines].toSorted(
			compareIds,
		),
	};
	const plan = buildPlan(
		{
			packageDigest: await reader.digest(),
			manifest,
			target,
			summary,
			validationBlockers: validation.blockers,
			validationWarnings: validation.warnings,
			targetBlockers: [...domain.blockers, ...checkLocales(manifest, targetContext)],
			scaffold: domain.scaffold,
			redirectLoops,
			localeRecasing: localeRecasing(manifest, targetContext),
			suggestions: await suggestPrincipalUsers(db, summary.principals),
			targetSettings: await readTargetSettings(db),
		},
		principalBylinesFrom(context),
	);
	return { plan, context };
}

async function claimForAnalysis(
	repo: TransferOperationRepository,
	input: AnalyzeImportStepInput,
): Promise<{ operation: TransferOperation; leaseToken: string } | { planned: TransferOperation }> {
	if (input.leaseToken !== undefined) {
		const operation = await repo.require(input.operationId);
		if (operation.leaseToken !== input.leaseToken) {
			throw new TransferError("TRANSFER_LEASE_LOST", "Transfer operation lease was lost");
		}
		if (operation.kind !== "import" || !isAnalyzable(operation.state)) {
			throw new TransferError("TRANSFER_INVALID_STATE", "Import cannot be analyzed in this state");
		}
		return { operation, leaseToken: input.leaseToken };
	}
	const claim = await repo.claim(input.operationId, ANALYZABLE_STATES);
	switch (claim.outcome) {
		case "claimed":
			if (claim.operation.kind !== "import") {
				await repo.release(claim.operation.id, claim.leaseToken);
				throw new TransferError("TRANSFER_INVALID_STATE", "Only imports can be analyzed");
			}
			return { operation: claim.operation, leaseToken: claim.leaseToken };
		case "lease_active":
			throw new TransferError("TRANSFER_LEASE_ACTIVE", "Another step is running");
		case "invalid_state":
			if (claim.operation.kind === "import" && claim.operation.state === "planned") {
				return { planned: claim.operation };
			}
			throw new TransferError("TRANSFER_INVALID_STATE", "Import cannot be analyzed in this state");
	}
}

function isAnalyzable(state: string): boolean {
	return (ANALYZABLE_STATES as readonly string[]).includes(state);
}

/**
 * Run one bounded analysis step. The final step stores the plan (default
 * decisions) in staging as `_plan.json` and moves the operation to
 * `planned`. Calling it on a planned operation returns the stored plan.
 */
export async function analyzeImportStep(
	input: AnalyzeImportStepInput,
): Promise<AnalyzeImportStepResult> {
	const repo = new TransferOperationRepository(input.db);
	const claimed = await claimForAnalysis(repo, input);
	if ("planned" in claimed) {
		const plan = await loadImportPlan(input.storage, claimed.planned);
		return {
			operation: claimed.planned,
			done: true,
			plan,
			planDigest: plan ? await planDigest(plan) : null,
		};
	}
	const { operation, leaseToken } = claimed;

	try {
		if (operation.cancelRequestedAt !== null) {
			return {
				operation: await repo.finishCancelled(operation.id, leaseToken),
				done: true,
				plan: null,
				planDigest: null,
			};
		}

		const stage = stageFor(input.storage, operation);
		const reader = new StagedPackageReader(stage);
		const validationState = await loadValidationState(stage, operation.cursor);
		const validation = await runValidationStep(
			{
				db: input.db,
				reader,
				operationId: operation.id,
				state: validationState,
				budget: input.budget,
			},
			{
				target: {
					dialect: detectDialect(input.db),
					maxBlobBytes: input.targetContext.maxUploadSize,
				},
			},
		);
		const manifest = await readManifestSafely(reader);
		const cursor = cursorFor(validation.state);

		if (!validation.done || !input.budget.canStart()) {
			await writeJson(input.storage, await stateKey(stage, cursor), validation.state);
			const updated = await repo.release(operation.id, leaseToken, {
				state: "analyzing",
				stage: cursor.stage,
				cursor,
				progress: progressFor(validation.state, manifest),
			});
			return { operation: updated, done: false, plan: null, planDigest: null };
		}
		input.budget.start();

		const built = await buildAnalysisPlan(input, stage, reader, validation);
		if (!built) {
			const first = validation.blockers[0];
			return {
				operation: await repo.fail(operation.id, leaseToken, {
					code: "TRANSFER_MANIFEST_INVALID",
					detail: first ? { blocker: first.code } : undefined,
				}),
				done: true,
				plan: null,
				planDigest: null,
			};
		}
		const digest = await storePlan(stage, built.plan, built.context);
		const progress = progressFor(validation.state, manifest);
		const updated = await repo.releaseUnlessCancelled(operation.id, leaseToken, "planned", {
			stage: null,
			cursor: null,
			planDigest: digest,
			progress: { done: progress.total, total: progress.total },
		});
		if (updated.state === "cancelled") {
			return { operation: updated, done: true, plan: null, planDigest: null };
		}
		return { operation: updated, done: true, plan: built.plan, planDigest: digest };
	} catch (error) {
		if (!(isTransferError(error) && error.code === "TRANSFER_LEASE_LOST")) {
			await repo.release(operation.id, leaseToken).catch(() => undefined);
		}
		throw error;
	}
}

/** The stored plan of an analyzed import, or null when none has been stored. */
export async function loadImportPlan(
	storage: Storage,
	operation: TransferOperation,
): Promise<SiteImportPlan | null> {
	const text = await stageFor(storage, operation).readAux("plan", MAX_PLAN_BYTES);
	if (text === null) return null;
	return siteImportPlanSchema.parse(JSON.parse(text));
}

export interface FinalizePlanInput {
	db: Kysely<Database>;
	storage: Storage;
	operationId: string;
	/** Decisions to apply over the plan's defaults (unvalidated caller input). */
	decisions: unknown;
}

/**
 * Apply submitted decisions to a planned import: validate them, recompute the
 * decision-dependent blockers, warnings, and transformations, store the plan,
 * and record its digest on the operation. Unknown principal ids and mappings
 * to users that do not exist are rejected with `TRANSFER_DECISIONS_INVALID`.
 * Once execution is requested the plan is frozen: `TRANSFER_INVALID_STATE`.
 */
export async function finalizePlan(
	input: FinalizePlanInput,
): Promise<{ plan: SiteImportPlan; planDigest: Sha256Digest }> {
	const parsed = siteImportDecisionsInputSchema.safeParse(input.decisions);
	if (!parsed.success) {
		throw new TransferError("TRANSFER_DECISIONS_INVALID", "Decisions are malformed");
	}

	const repo = new TransferOperationRepository(input.db);
	const claim = await repo.claim(input.operationId, ["planned"]);
	if (claim.outcome === "lease_active") {
		throw new TransferError("TRANSFER_LEASE_ACTIVE", "Another step is running");
	}
	if (claim.outcome === "invalid_state" || claim.operation.kind !== "import") {
		if (claim.outcome === "claimed") await repo.release(claim.operation.id, claim.leaseToken);
		throw new TransferError("TRANSFER_INVALID_STATE", "Import has not been analyzed");
	}
	if (claim.operation.stage === "reserve") {
		await repo.release(claim.operation.id, claim.leaseToken);
		throw new TransferError(
			"TRANSFER_INVALID_STATE",
			"Import execution was requested; its plan can no longer change",
		);
	}
	const { operation, leaseToken } = claim;

	try {
		const stage = stageFor(input.storage, operation);
		const stored = await loadImportPlan(input.storage, operation);
		const contextRaw = await readJson(input.storage, contextKey(stage), MAX_STATE_BYTES);
		const context = analysisContextSchema.safeParse(contextRaw);
		if (!stored || !context.success) {
			throw new TransferError("TRANSFER_INVALID_STATE", "Import has no stored plan");
		}

		const known = new Set(stored.principals.map((principal) => principal.id));
		const submitted = Object.entries(parsed.data.principalMappings ?? {});
		const unknown = submitted.filter(([principalId]) => !known.has(principalId));
		if (unknown.length > 0) {
			throw new TransferError("TRANSFER_DECISIONS_INVALID", "Decisions name unknown principals", {
				detail: { principals: unknown.length },
			});
		}
		const missingUsers = await findMissingUsers(
			input.db,
			submitted.flatMap(([, userId]) => (userId === null ? [] : [userId])),
		);
		if (missingUsers.length > 0) {
			throw new TransferError("TRANSFER_DECISIONS_INVALID", "Decisions name unknown users", {
				detail: { users: missingUsers.length },
			});
		}

		const decisions = mergeDecisions(defaultDecisions(stored.principals), parsed.data);
		const plan = applyDecisions(stored, decisions, principalBylinesFrom(context.data));
		const digest = await storePlan(stage, plan, context.data);
		await repo.release(operation.id, leaseToken, { planDigest: digest });
		return { plan, planDigest: digest };
	} catch (error) {
		if (!(isTransferError(error) && error.code === "TRANSFER_LEASE_LOST")) {
			await repo.release(operation.id, leaseToken).catch(() => undefined);
		}
		throw error;
	}
}
