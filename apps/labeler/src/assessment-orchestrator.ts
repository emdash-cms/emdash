/**
 * Assessment workflow orchestrator (plan W6.4). Drives a run from `pending`
 * through `running`, the analysis stages, and atomic finalization (spec
 * §9.9, §10).
 *
 * Driven in production by `AssessmentWorkflow` (assessment-workflow.ts): each
 * run executes as one Workflow instance whose id is the run's runKey, so a
 * redelivered discovery event dedups onto the same instance rather than starting
 * a duplicate (see assessment-dispatch.ts). The Workflow constructs this
 * orchestrator per run and calls `runAssessment` with the real stage adapters
 * that `assessment-workflow.ts` `buildStages` assembles (acquire, code AI, image
 * AI, history). `stubStages` remains exported only for tests that need an
 * empty-findings pass; production never runs it.
 */

import type { LabelSigner } from "@emdash-cms/registry-moderation";

import { automatedIdempotencyKey, type AssessmentState } from "./assessment-lifecycle.js";
import {
	buildFinalizationStatements,
	getAssessment,
	getNegatableAutomatedLabels,
	isSubjectCurrent,
	listEvidenceObjectIds,
	transitionAssessmentState,
	type Assessment,
} from "./assessment-store.js";
import type { LabelerConfig } from "./config.js";
import { allowedFindingCategories, validateFindings, type NormalizedFinding } from "./findings.js";
import { resolvePolicyOutcome, type OutcomeLabel, type PolicyOutcome } from "./policy-resolver.js";
import type { ModerationPolicy } from "./policy.js";
import {
	buildIssuanceStatements,
	type AutomatedIssuanceAction,
	type AutomatedLabelProposal,
} from "./service.js";

/**
 * A stage's finding is the canonical normalized contract (`findings.ts`).
 * `category` is a label value from the policy vocabulary (matches
 * `AutomatedLabelProposal.findingCategory` / warning label values).
 */
export type StageFinding = NormalizedFinding;

/** Thrown by a stage adapter for a retryable infrastructure failure
 * (network, model/scanner unavailability). Anything else a stage throws is
 * treated as non-retryable and aborts the run. */
export class StageTransientError extends Error {
	override readonly name = "StageTransientError";
}

/**
 * Thrown when the finalization batch's CAS out of `running` changed no row — a
 * cancel or delete raced finalization. The in-batch state guard means no labels
 * were issued; this signals the caller (the Workflow step) to retry, where the
 * now-terminal row short-circuits.
 */
export class AssessmentFinalizationConflictError extends Error {
	override readonly name = "AssessmentFinalizationConflictError";
	constructor(
		readonly assessmentId: string,
		readonly expectedState: AssessmentState,
		readonly actualState: AssessmentState | null,
	) {
		super(
			`assessment ${assessmentId} finalization lost the race: expected ${expectedState}, found ${actualState ?? "missing"}`,
		);
	}
}

export interface StageContext {
	readonly assessment: Assessment;
}

export type StageAdapter = (ctx: StageContext) => Promise<readonly StageFinding[]>;

export interface OrchestratorStages {
	acquire: StageAdapter;
	codeAi: StageAdapter;
	imageAi: StageAdapter;
	/** Publisher-history context (plan W8.4). Runs last: its findings are
	 * context the resolver drops, never labels, so nothing downstream depends on
	 * them. Must be best-effort — a history stage that throws would fail the whole
	 * run and discard every other stage's findings; `analyzeHistory` swallows its
	 * own errors and returns `[]`. DB-bound — a real wiring passes a closure over
	 * `analyzeHistory`. */
	history: StageAdapter;
}

const STAGE_ORDER = ["acquire", "codeAi", "imageAi", "history"] as const;

export interface AssessmentOrchestratorOptions {
	db: D1Database;
	config: LabelerConfig;
	signer: LabelSigner;
	policy: ModerationPolicy;
	stages: OrchestratorStages;
	now?: () => Date;
	/** Retries per stage before treating it as exhausted. Default 2. */
	maxStageRetries?: number;
	/** Sleep between stage retries; swap in tests to skip real waits. */
	sleep?: (ms: number) => Promise<void>;
	retryDelayMs?: number;
	/** Resolves the `coverage_json` to stamp on the finalized row, called once
	 * at finalization. The stage-wiring layer builds this over the coverage its
	 * AI stages accumulate (`assessment-stages.ts`); `undefined` (or an undefined
	 * return) leaves the stored value unchanged. */
	resolveCoverageJson?: () => string | undefined;
}

export class AssessmentOrchestrator {
	private readonly db: D1Database;
	private readonly config: LabelerConfig;
	private readonly signer: LabelSigner;
	private readonly policy: ModerationPolicy;
	private readonly stages: OrchestratorStages;
	private readonly now: () => Date;
	private readonly maxStageRetries: number;
	private readonly sleep: (ms: number) => Promise<void>;
	private readonly retryDelayMs: number;
	private readonly resolveCoverageJson: (() => string | undefined) | undefined;

	constructor(opts: AssessmentOrchestratorOptions) {
		this.db = opts.db;
		this.config = opts.config;
		this.signer = opts.signer;
		this.policy = opts.policy;
		this.stages = opts.stages;
		this.now = opts.now ?? (() => new Date());
		this.maxStageRetries = opts.maxStageRetries ?? 2;
		this.sleep = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
		this.retryDelayMs = opts.retryDelayMs ?? 0;
		this.resolveCoverageJson = opts.resolveCoverageJson;
	}

	async runAssessment(runId: string): Promise<Assessment> {
		const now = this.now();
		const loaded = await getAssessment(this.db, runId);
		if (!loaded) throw new Error(`assessment ${runId} not found`);
		// Accept a `running` row left by a crashed prior attempt and resume it: the
		// production driver is a Workflow step that retries `runAssessment`, and any
		// failure after the pending→running CAS (e.g. a transient D1 error in
		// `finalize`) leaves the row `running`. Re-running is safe — stages are
		// recomputed (findings are held in memory, not persisted mid-run) and every
		// label issuance is idempotency-keyed. A `pending` row is transitioned to
		// `running` first; a terminal row is the caller's to short-circuit.
		if (loaded.state !== "pending" && loaded.state !== "running")
			throw new Error(`assessment ${runId} is not resumable (state=${loaded.state})`);
		const assessment =
			loaded.state === "pending"
				? await transitionAssessmentState(this.db, {
						id: runId,
						from: "pending",
						to: "running",
						now,
					})
				: loaded;

		const findings: StageFinding[] = [];
		let transientExhausted = false;
		for (const name of STAGE_ORDER) {
			try {
				const result = await this.runStageWithRetry(this.stages[name], { assessment });
				findings.push(...result);
			} catch (err) {
				if (err instanceof StageTransientError) {
					transientExhausted = true;
					break;
				}
				throw err;
			}
		}

		// Validate and resolve the findings gathered so far even on transient
		// exhaustion: a stage that already returned a BLOCKING finding must not be
		// discarded because a LATER stage failed transiently. A block is monotonic —
		// no unfinished stage can lift it, only add labels — so finalizing `blocked`
		// on partial coverage is correct and safe, and it stops a crafted input that
		// reliably exhausts a later stage from suppressing a real block on every
		// rerun. Anything short of an already-confirmed block on an incomplete run
		// still finalizes `error` (below) and retries — an unrun stage might have
		// found a block.
		//
		// validateFindings throws on a malformed finding; uncaught, it aborts the
		// run (assessment stays `running`, like any non-transient stage error).
		// Resolution and persistence below read validatedFindings, never the raw
		// stage output.
		const resolvableEvidenceIds = await listEvidenceObjectIds(this.db, assessment.id);
		const validatedFindings = validateFindings(findings, {
			allowedCategories: allowedFindingCategories(this.policy),
			resolvableEvidenceIds,
		});

		// Re-read subject currency immediately before finalizing: a deleted or
		// CID-superseded subject finalizes as `stale` — no labels, pointer
		// untouched.
		//
		// This read narrows the delete/cancel window; `finalize` closes it. Between
		// here and `db.batch`, `finalize` signs each label (an async round-trip), so
		// a delete or an operator cancel can still land in that window — but every
		// issuance statement is gated on the run reaching `toState`
		// (`requireAssessmentState`, see `finalize`) and the whole finalization batch
		// is all-or-nothing against the run→toState CAS, so a race that moves the run
		// out of `running` no-ops the CAS AND every label. Nothing leaks; the lost
		// race raises `AssessmentFinalizationConflictError`.
		const current = await isSubjectCurrent(this.db, { uri: assessment.uri, cid: assessment.cid });
		if (!current) {
			return transitionAssessmentState(this.db, { id: runId, from: "running", to: "stale", now });
		}

		const resolved = resolvePolicyOutcome(validatedFindings, this.policy);
		// On transient exhaustion, honor an already-confirmed block; every other
		// incomplete outcome (clean or warn) is an `error` to retry, never a
		// `passed`/`warned` finalized over an unrun stage.
		const outcome = transientExhausted
			? resolved.toState === "blocked"
				? resolved
				: null
			: resolved;
		return this.finalize(assessment, outcome, now);
	}

	private async runStageWithRetry(
		stage: StageAdapter,
		ctx: StageContext,
	): Promise<readonly StageFinding[]> {
		const maxAttempts = this.maxStageRetries + 1;
		let lastErr: unknown;
		for (let attempt = 0; attempt < maxAttempts; attempt++) {
			try {
				return await stage(ctx);
			} catch (err) {
				if (!(err instanceof StageTransientError)) throw err;
				lastErr = err;
				if (attempt < maxAttempts - 1) await this.sleep(this.retryDelayMs);
			}
		}
		throw lastErr instanceof Error ? lastErr : new StageTransientError(String(lastErr));
	}

	/**
	 * Builds and commits the finalization batch in one `db.batch`: the CAS
	 * transition out of `running` (+ pointer move for passed/warned/blocked),
	 * the outcome's positive label(s), the `assessment-pending` negation, and
	 * negations for any prior active automated label this outcome no longer
	 * supports (decision: never a manually-issued one — `getNegatableAutomatedLabels`
	 * only returns `automated-assessment`-provenanced labels).
	 *
	 * `outcome === null` means transient-exhaustion: finalize as `error`,
	 * issuing only `assessment-error` (no positive outcome labels).
	 */
	private async finalize(
		assessment: Assessment,
		outcome: PolicyOutcome | null,
		now: Date,
	): Promise<Assessment> {
		const toState: AssessmentState = outcome?.toState ?? "error";
		const positiveLabels: readonly OutcomeLabel[] = outcome?.labels ?? [];

		const coverageJson = this.resolveCoverageJson?.();
		const finalization = buildFinalizationStatements(this.db, {
			assessmentId: assessment.id,
			fromState: "running",
			toState,
			src: this.config.labelerDid,
			uri: assessment.uri,
			cid: assessment.cid,
			now,
			...(coverageJson !== undefined ? { coverageJson } : {}),
		});

		const statements = [...finalization.statements];
		const postCommits: Array<() => Promise<unknown>> = [];

		const issue = async (
			val: string,
			neg: boolean,
			proposal: Partial<AutomatedLabelProposal> = {},
		) => {
			const idempotencyKey = automatedIdempotencyKey(assessment.runKey, val, neg);
			const action: AutomatedIssuanceAction = {
				actor: this.config.labelerDid,
				type: "automated-assessment",
				assessmentId: assessment.id,
				reason: `assessment ${toState}`,
				idempotencyKey,
			};
			const built = await buildIssuanceStatements(
				this.db,
				this.config,
				this.signer,
				action,
				{
					uri: assessment.uri,
					cid: assessment.cid,
					val,
					...(neg ? { neg: true } : {}),
					...proposal,
				},
				now,
				false,
				// Gate every finalization label on the run reaching `toState`, so a
				// concurrent cancel/delete that no-ops the CAS also no-ops the labels.
				{ requireAssessmentState: toState },
			);
			statements.push(...built.statements);
			postCommits.push(built.postCommit);
		};

		for (const label of positiveLabels) {
			await issue(label.val, false, {
				...(label.findingCategory !== undefined ? { findingCategory: label.findingCategory } : {}),
				...(label.severity !== undefined ? { severity: label.severity } : {}),
			});
		}
		if (toState === "error") {
			await issue("assessment-error", false);
		}
		// Spec §9.9 point 9: always negate this run's own assessment-pending.
		await issue("assessment-pending", true);

		// Spec §9.9 point 8 / §10: negate prior active automated labels this
		// outcome no longer supports.
		const priorActive = await getNegatableAutomatedLabels(this.db, {
			src: this.config.labelerDid,
			uri: assessment.uri,
			cid: assessment.cid,
		});
		// Keep this run's own positive labels — including the assessment-error it
		// just issued — so the negation pass below doesn't retract a label this
		// same outcome is issuing.
		const keep = new Set(positiveLabels.map((l) => l.val));
		if (toState === "error") keep.add("assessment-error");
		for (const prior of priorActive) {
			if (prior.val === "assessment-pending" || keep.has(prior.val)) continue;
			await issue(prior.val, true);
		}

		// Final currency re-check with no signing between it and the commit, so the
		// delete/cancel window is two adjacent D1 ops rather than spanning every
		// label's signing round-trip above.
		//
		// The batch is all-or-nothing against the run→toState CAS: every issuance
		// action is gated on the assessment reaching `toState`
		// (buildIssuanceStatements' requireAssessmentState), and the CAS's row count
		// is checked after commit (below). A cancel or delete that moves the run out
		// of `running` in this gap therefore no-ops the CAS AND every label — nothing
		// leaks — and the lost race raises AssessmentFinalizationConflictError.
		//
		// Narrower gaps remain, tracked with the real-stage wiring:
		//   - a signing-state flip mid-batch: the label inserts are guarded on active
		//     signing state and no-op if it flips, but the CAS is not, so a flip could
		//     commit the terminal state with its labels suppressed (the CAS still
		//     changed a row, so the postCommit below surfaces it as a signing error);
		//   - a CID supersession landing in this gap does not move the run out of
		//     `running`, so the CAS succeeds and this run finalizes labels for its own
		//     CID (the pointer upsert is guarded on created-at ordering);
		//   - `transitionAssessmentState` in the stale branch below can throw
		//     `AssessmentTransitionConflictError` under a racing delete.
		const stillCurrent = await isSubjectCurrent(this.db, {
			uri: assessment.uri,
			cid: assessment.cid,
		});
		if (!stillCurrent) {
			return transitionAssessmentState(this.db, {
				id: assessment.id,
				from: "running",
				to: "stale",
				now,
			});
		}

		const results = await this.db.batch(statements);
		// If the finalization CAS changed no row, a cancel/delete moved the run out
		// of `running` between the currency re-check and commit. The in-batch state
		// guard on every issuance statement means NO labels were written, so skip
		// the postCommits (each would otherwise mis-diagnose the absent label as a
		// signing failure and throw) and surface the lost race loudly — the Workflow
		// step retries and short-circuits on the now-terminal row.
		const casChanged = results[finalization.assessmentUpdateIndex]?.meta.changes ?? 0;
		if (casChanged !== 1) {
			const raced = await getAssessment(this.db, assessment.id);
			throw new AssessmentFinalizationConflictError(assessment.id, toState, raced?.state ?? null);
		}
		for (const postCommit of postCommits) await postCommit();

		const finalised = await getAssessment(this.db, assessment.id);
		if (!finalised) throw new Error(`assessment ${assessment.id} disappeared after finalization`);
		return finalised;
	}
}

/**
 * Deterministic stub stage adapters: every stage resolves with no findings.
 * Used only in tests exercising the happy path; other test scenarios
 * (warnings, blocking findings, transient exhaustion) construct their own
 * stage adapters directly.
 */
export const stubStages: OrchestratorStages = {
	acquire: () => Promise.resolve([]),
	codeAi: () => Promise.resolve([]),
	imageAi: () => Promise.resolve([]),
	history: () => Promise.resolve([]),
};
