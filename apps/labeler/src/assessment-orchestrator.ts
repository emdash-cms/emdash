/**
 * Assessment workflow orchestrator (plan W6.4). Drives a run from `pending`
 * through `running`, the analysis stages, and atomic finalization (spec
 * §9.9, §10).
 *
 * BINDING DECISION: production wiring stops at `assessment-pending`
 * (discovery-consumer.ts). Nothing in a production code path constructs or
 * calls `AssessmentOrchestrator` — it ships as code, exercised only by
 * tests, until W7/W8 supply real stage adapters (acquire, deterministic
 * validation, dependency/SBOM, code/metadata AI, image AI). `stubStages` in
 * this module exists for that same reason: test fixtures, not production
 * defaults.
 */

import type { LabelSigner } from "@emdash-cms/registry-moderation";

import { automatedIdempotencyKey, type AssessmentState } from "./assessment-lifecycle.js";
import {
	buildFinalizationStatements,
	getAssessment,
	getNegatableAutomatedLabels,
	isSubjectCurrent,
	transitionAssessmentState,
	type Assessment,
} from "./assessment-store.js";
import type { LabelerConfig } from "./config.js";
import type { FindingSeverity } from "./evidence.js";
import { automatedBlockCategories, type ModerationPolicy } from "./policy.js";
import {
	buildIssuanceStatements,
	type AutomatedIssuanceAction,
	type AutomatedLabelProposal,
} from "./service.js";

export interface StageFinding {
	source: string;
	/** A label value from the policy vocabulary (matches
	 * `AutomatedLabelProposal.findingCategory` / warning label values). */
	category: string;
	severity: FindingSeverity;
	confidence?: number;
	title: string;
	publicSummary: string;
	privateDetail: string;
	evidenceRefs: readonly string[];
}

/** Thrown by a stage adapter for a retryable infrastructure failure
 * (network, model/scanner unavailability). Anything else a stage throws is
 * treated as non-retryable and aborts the run. */
export class StageTransientError extends Error {
	override readonly name = "StageTransientError";
}

export interface StageContext {
	readonly assessment: Assessment;
}

export type StageAdapter = (ctx: StageContext) => Promise<readonly StageFinding[]>;

export interface OrchestratorStages {
	acquire: StageAdapter;
	deterministic: StageAdapter;
	dependency: StageAdapter;
	codeAi: StageAdapter;
	imageAi: StageAdapter;
}

export interface OutcomeLabel {
	val: string;
	findingCategory?: string;
	severity?: FindingSeverity;
}

export interface PolicyOutcome {
	toState: "passed" | "warned" | "blocked";
	labels: readonly OutcomeLabel[];
}

/**
 * Pure resolution per spec §9.9 order (blocking findings first, then
 * warnings, else pass). A stub — W7/W8 replace this with the real policy
 * engine; this PR only needs enough to exercise the orchestrator's
 * finalization/negation plumbing in tests.
 */
export function resolvePolicyOutcome(
	findings: readonly StageFinding[],
	policy: ModerationPolicy,
): PolicyOutcome {
	const blockCategories = automatedBlockCategories(policy);
	const blocking = findings.find(
		(f) => f.severity === "critical" && blockCategories.has(f.category),
	);
	if (blocking) {
		return {
			toState: "blocked",
			labels: [
				{ val: blocking.category, findingCategory: blocking.category, severity: "critical" },
			],
		};
	}
	const warningVals = [
		...new Set(
			findings
				.filter((f) => policy.labelsByValue.get(f.category)?.category === "warning")
				.map((f) => f.category),
		),
	];
	if (warningVals.length > 0) {
		return { toState: "warned", labels: warningVals.map((val) => ({ val })) };
	}
	return { toState: "passed", labels: [{ val: "assessment-passed" }] };
}

const STAGE_ORDER = ["acquire", "deterministic", "dependency", "codeAi", "imageAi"] as const;

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
	}

	async runAssessment(runId: string): Promise<Assessment> {
		const now = this.now();
		const loaded = await getAssessment(this.db, runId);
		if (!loaded) throw new Error(`assessment ${runId} not found`);
		if (loaded.state !== "pending")
			throw new Error(`assessment ${runId} is not pending (state=${loaded.state})`);
		const assessment = await transitionAssessmentState(this.db, {
			id: runId,
			from: "pending",
			to: "running",
			now,
		});

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

		// Re-read subject currency immediately before finalizing: a deleted or
		// CID-superseded subject finalizes as `stale` — no labels, pointer
		// untouched.
		//
		// This read narrows but does NOT close the window: `finalize` signs each
		// label (an async round-trip) between here and `db.batch`, so a delete or
		// a cancel landing in that window still commits labels — the finalization
		// CAS guards its own row, but the issuance statements carry no
		// assessment-state guard. Closing it requires either the per-subject
		// workflow lock the spec mandates (§14.1) or an in-batch state guard on
		// every issuance statement. That belongs with wiring the orchestrator to
		// production in W7/W8; today the production-boundary test guarantees no
		// production path reaches this method.
		const current = await isSubjectCurrent(this.db, { uri: assessment.uri, cid: assessment.cid });
		if (!current) {
			return transitionAssessmentState(this.db, { id: runId, from: "running", to: "stale", now });
		}

		const outcome = transientExhausted ? null : resolvePolicyOutcome(findings, this.policy);
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

		const finalization = buildFinalizationStatements(this.db, {
			assessmentId: assessment.id,
			fromState: "running",
			toState,
			src: this.config.labelerDid,
			uri: assessment.uri,
			cid: assessment.cid,
			now,
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
			uri: assessment.uri,
			cid: assessment.cid,
		});
		const keep = new Set(positiveLabels.map((l) => l.val));
		for (const prior of priorActive) {
			if (prior.val === "assessment-pending" || keep.has(prior.val)) continue;
			await issue(prior.val, true);
		}

		// Final currency re-check with no signing between it and the commit, so
		// the delete/cancel window is two adjacent D1 ops rather than spanning
		// every label's signing round-trip above. Full closure still needs the
		// workflow lock (see the re-check before this method); this shrinks the
		// exposure in the interim.
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

		await this.db.batch(statements);
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
	deterministic: () => Promise.resolve([]),
	dependency: () => Promise.resolve([]),
	codeAi: () => Promise.resolve([]),
	imageAi: () => Promise.resolve([]),
};
