/**
 * Discovery queue consumer. Replaces the Jetstream-observed event with a
 * verified subject, an idempotent assessment run, an `assessment-pending`
 * label, and a dispatched assessment Workflow instance — spec §9.1 steps 5-7.
 * This file's job ends at dispatch: it never constructs
 * `AssessmentOrchestrator` itself. The instance id is the run's runKey
 * (assessment-dispatch.ts), so a redelivered discovery event dedups onto the
 * same instance while a later re-assessment (distinct trigger → distinct
 * runKey) gets its own. `AssessmentWorkflow` (assessment-workflow.ts) then
 * drives `pending → running → finalization` through the orchestrator's real
 * acquire → code → image → history stages.
 *
 * Error policy mirrors the aggregator's records-consumer with one
 * difference (spec §9.1): a forged or unverifiable event is ALWAYS a dead
 * letter, never a retry, matching "a forged or unverifiable event is
 * retained as an operational dead letter and produces no public label" —
 * there is no signed-label-ingest-style fail-closed stall here.
 *
 *   - Transient PDS failure (network, timeout, 5xx): `retry()`.
 *   - Verification failure (signature, MST, URI, DID resolution, CID
 *     mismatch): `dead_letters` row, ack. Never retry.
 *   - Unexpected programming errors: log loud, dead-letter, ack — never
 *     crash the worker or block the queue.
 *   - Delete events: confirm the record is genuinely absent at the PDS
 *     before tombstoning the subject and cancelling non-terminal runs; a
 *     still-resolving record is a forged/premature delete and dead-letters.
 */

import {
	AtprotoWebDidDocumentResolver,
	CompositeDidDocumentResolver,
	PlcDidDocumentResolver,
} from "@atcute/identity-resolver";
import type { LabelSigner } from "@emdash-cms/registry-moderation";
import { cloudflareDohResolver, type DnsResolver } from "emdash/security/ssrf";
import { ulid } from "ulidx";

import {
	AssessmentDispatchError,
	dispatchAssessmentWorkflow,
	type AssessmentWorkflowBinding,
} from "./assessment-dispatch.js";
import {
	AssessmentTransitionConflictError,
	automatedIdempotencyKey,
	computeRunKey,
	initialTriggerId,
	TERMINAL_STATES,
} from "./assessment-lifecycle.js";
import {
	buildAssessmentRunStatement,
	createSubject,
	deleteSubjectsByUri,
	getAssessment,
	getAssessmentByRunKey,
	listPendingBearingAssessmentsForUri,
	readDeleteGeneration,
	subjectMatchesGeneration,
	transitionAssessmentState,
	type Assessment,
} from "./assessment-store.js";
import { AutomationStateUnavailableError, isAutomationPaused } from "./automation-state.js";
import { getLabelerIdentityConfig, type LabelerConfig } from "./config.js";
import type { DiscoveryJob } from "./env.js";
import {
	isTransient,
	PdsVerificationError,
	type VerificationFailureReason,
	type VerifiedPdsRecord,
} from "./pds-verify.js";
import { MODERATION_POLICY } from "./policy.js";
import {
	confirmRecordAbsent,
	type DidDocumentResolverLike,
	fetchAndVerifyExactRecord,
	RecordVerificationError,
	type RecordVerificationFailureReason,
} from "./record-verification.js";
import {
	buildIssuanceStatements,
	issueAutomatedAssessmentLabel,
	LabelIssuanceUnavailableError,
	readIssuedLabelByActionKey,
	type AutomatedIssuanceAction,
	type AutomatedLabelProposal,
} from "./service.js";
import { createRuntimeSigner, getRuntimeSigningSecret } from "./signing-runtime.js";
import { createLabelPublisher, type LabelPublisher } from "./subscribe-labels.js";

/**
 * Stub identifiers for the model/prompt/scanner-set components of the run
 * key (spec §9.2) until W7/W8 wire real stage adapters. Stable across
 * replays so redelivery of the same discovery event always computes the
 * same `runKey` and converges on the same assessment row.
 */
const DISCOVERY_MODEL_ID = "unassigned";
const DISCOVERY_PROMPT_HASH = "unassigned";
const DISCOVERY_SCANNER_SET_VERSION = "unassigned";

export interface DiscoveryConsumerDeps {
	db: D1Database;
	config: LabelerConfig;
	signer: LabelSigner;
	didDocumentResolver: DidDocumentResolverLike;
	/** The assessment Workflow binding. Once a verified subject reaches
	 * `pending`, the consumer dispatches its run; the instance id is the run's
	 * runKey, so a redelivered event dedups onto the same instance
	 * (assessment-dispatch.ts). */
	assessmentWorkflow: AssessmentWorkflowBinding;
	/** Live broadcast for the pending-label and deletion-negation issuances. When
	 * present they commit `publication_pending = 1` and notify the subscription DO
	 * post-commit (the same publisher the orchestrator path uses); the
	 * reconciliation sweep is the durable backstop for a dropped notify. Omitted in
	 * tests that don't exercise publication (labels then commit already-published,
	 * matching the orchestrator's no-publisher behaviour). */
	publisher?: LabelPublisher;
	fetch?: typeof fetch;
	/** Resolves each PDS hop's hostname for the SSRF egress guard; defaults to
	 * the DoH resolver used by artifact acquisition. */
	resolveHostname?: DnsResolver;
	now?: () => Date;
	/**
	 * Optional override for the record-verification step. Used by tests to
	 * inject synthetic `VerifiedPdsRecord` payloads without standing up a
	 * real CAR fixture — the FakeRepo/MockPds toolkit can't run inside the
	 * workers test pool (see `@atproto/repo`'s Node-crypto dependency).
	 * Defaults to `fetchAndVerifyExactRecord`.
	 */
	verify?: (opts: {
		uri: string;
		cid: string;
		didDocumentResolver: DidDocumentResolverLike;
		fetch?: typeof fetch;
		resolveHostname?: DnsResolver;
	}) => Promise<VerifiedPdsRecord>;
	/** Override for the delete-path absence check; defaults to
	 * `confirmRecordAbsent`. Returns `true` when the record is verifiably gone. */
	confirmDeleted?: (opts: {
		uri: string;
		didDocumentResolver: DidDocumentResolverLike;
		fetch?: typeof fetch;
		resolveHostname?: DnsResolver;
	}) => Promise<boolean>;
}

/** Subset of `cloudflare:workers` `Message` we use; defining inline so tests
 * don't need to import workerd types. */
export interface MessageController {
	/** 1 on first delivery, incremented on each redelivery. */
	readonly attempts: number;
	ack(): void;
	retry(options?: { delaySeconds?: number }): void;
}

/** Subset of a `MessageBatch`. Workers' real batch object satisfies this. */
export interface MessageBatchLike<T> {
	readonly messages: ReadonlyArray<MessageController & { body: T }>;
}

/** Reason codes written to `dead_letters.reason`. PDS-verification and
 * record-verification reasons pass through verbatim; the rest cover
 * unclassified failures. */
export type DiscoveryDeadLetterReason =
	| "RECORD_NOT_FOUND"
	| "RESPONSE_TOO_LARGE"
	| "INVALID_PROOF"
	| "PDS_HTTP_ERROR"
	| "PDS_HOST_BLOCKED"
	| "DELETE_RECORD_PRESENT"
	| RecordVerificationFailureReason
	| "UNEXPECTED_ERROR";

export async function processDiscoveryBatch(
	batch: MessageBatchLike<DiscoveryJob>,
	env: Env,
	depsOverride?: DiscoveryConsumerDeps,
): Promise<void> {
	const deps = depsOverride ?? (await createProductionDiscoveryDeps(env));
	// Process jobs independently — one failed verification must not fail the
	// whole batch and trigger redeliveries for already-acked messages.
	for (const message of batch.messages) {
		try {
			await processDiscoveryMessage(message.body, message, deps);
		} catch (err) {
			console.error("[labeler] discovery processMessage threw unexpectedly", {
				did: message.body.did,
				collection: message.body.collection,
				rkey: message.body.rkey,
				error: err instanceof Error ? err.message : String(err),
			});
			message.retry();
		}
	}
}

/**
 * Drain the discovery DLQ. Same posture as the aggregator's records DLQ:
 * log + write a `dead_letters` row, then ack so the DLQ doesn't grow
 * unbounded.
 */
export async function drainDiscoveryDeadLetterBatch(
	batch: MessageBatchLike<DiscoveryJob>,
	env: Env,
): Promise<void> {
	const now = new Date();
	for (const message of batch.messages) {
		const job = message.body;
		console.warn("[labeler] discovery DLQ drain: acking job", {
			did: job.did,
			collection: job.collection,
			rkey: job.rkey,
			operation: job.operation,
		});
		try {
			await writeDeadLetter(env.DB, job, "UNEXPECTED_ERROR", "drained from DLQ", now);
			message.ack();
		} catch (err) {
			console.error("[labeler] discovery DLQ drain: failed to write forensics row, retrying", {
				did: job.did,
				rkey: job.rkey,
				error: err instanceof Error ? err.message : String(err),
			});
			message.retry();
		}
	}
}

export async function processDiscoveryMessage(
	job: DiscoveryJob,
	controller: MessageController,
	deps: DiscoveryConsumerDeps,
): Promise<void> {
	const now = deps.now ?? (() => new Date());
	const uri = jobUri(job);

	if (job.operation === "delete") {
		// A delete suppresses assessment work (tombstone + cancel runs), so it gets
		// the same distrust as a create: confirm the record is genuinely gone at the
		// PDS before acting. A still-present record means a forged or premature
		// delete — dead-letter it, suppress nothing. A verification failure here
		// classifies like the create path (transient retries, permanent dead-letters).
		let absent: boolean;
		try {
			const confirmAbsent = deps.confirmDeleted ?? confirmRecordAbsent;
			absent = await confirmAbsent({
				uri,
				didDocumentResolver: deps.didDocumentResolver,
				...(deps.fetch ? { fetch: deps.fetch } : {}),
				...(deps.resolveHostname ? { resolveHostname: deps.resolveHostname } : {}),
			});
		} catch (err) {
			await classifyDiscoveryError(err, job, deps, controller, now());
			return;
		}
		if (!absent) {
			await writeDeadLetter(deps.db, job, "DELETE_RECORD_PRESENT", "record still resolves", now());
			controller.ack();
			return;
		}
		try {
			await applyDiscoveryDelete(deps, uri, now());
			controller.ack();
		} catch (err) {
			// The mutation phase (tombstone → pending-negation → cancellation) can
			// leave a run's `assessment-pending` label live on a now-deleted subject
			// if it fails partway. Acking here — as the create path's unexpected-error
			// policy would — strands that label forever, so ALWAYS retry. Redelivery
			// re-attempts idempotently; a genuinely permanent failure exhausts to the
			// DLQ, which is acceptable versus acking a live label on a deleted subject.
			console.error(
				"[labeler] discovery delete mutation failed; retrying to avoid a stranded label",
				{
					did: job.did,
					collection: job.collection,
					rkey: job.rkey,
					error: err instanceof Error ? err.message : String(err),
				},
			);
			controller.retry();
		}
		return;
	}

	try {
		if (await readAutomationPaused(deps.db)) {
			// Ingestion is paused (spec §11.3): retry so the event isn't lost —
			// resume re-drives it. Manual/admin issuance stays available because
			// the switch is checked here, not in the signing layer.
			controller.retry();
			return;
		}
		await verifyAndCreateRun(uri, job, deps, now());
		controller.ack();
	} catch (err) {
		await classifyDiscoveryError(err, job, deps, controller, now());
	}
}

/**
 * Reads the automation kill-switch, failing closed: an unreadable switch
 * becomes a `LabelIssuanceUnavailableError` so `classifyDiscoveryError` retries
 * rather than letting ingestion issue past a switch it could not read.
 */
async function readAutomationPaused(db: D1Database): Promise<boolean> {
	try {
		return await isAutomationPaused(db);
	} catch (err) {
		if (err instanceof AutomationStateUnavailableError) {
			throw new LabelIssuanceUnavailableError("automation pause state unreadable", { cause: err });
		}
		throw err;
	}
}

/**
 * One classification for both the create and delete paths so they can't
 * diverge (spec §9.1): a transient failure retries; a permanent
 * verification failure dead-letters and acks; anything unexpected is logged,
 * dead-lettered, and acked rather than blocking the queue.
 */
async function classifyDiscoveryError(
	err: unknown,
	job: DiscoveryJob,
	deps: DiscoveryConsumerDeps,
	controller: MessageController,
	now: Date,
): Promise<void> {
	if (err instanceof LabelIssuanceUnavailableError) {
		// Signing paused or mid-rotation — retry so the label isn't lost.
		controller.retry();
		return;
	}
	if (err instanceof AssessmentDispatchError) {
		// Subject verified and pending; only the Workflow dispatch failed. Retry
		// so redelivery re-dispatches — every upstream step is idempotent.
		controller.retry();
		return;
	}
	if (err instanceof PdsVerificationError) {
		if (isTransient(err.reason, err.status)) {
			// Back off so a DNS-propagation or PDS blip has time to clear before
			// max_retries is exhausted; an immediate re-delivery would burn every
			// attempt in a couple of batches.
			controller.retry({ delaySeconds: transientRetryDelaySeconds(controller.attempts) });
			return;
		}
		let mapped: DiscoveryDeadLetterReason;
		try {
			mapped = mapPdsReason(err.reason);
		} catch (mapErr) {
			console.error("[labeler] mapPdsReason failed; falling back", {
				reason: err.reason,
				error: mapErr instanceof Error ? mapErr.message : String(mapErr),
			});
			mapped = "UNEXPECTED_ERROR";
		}
		await writeDeadLetter(deps.db, job, mapped, err.message, now);
		controller.ack();
		return;
	}
	if (err instanceof RecordVerificationError) {
		if (err.transient) {
			controller.retry();
			return;
		}
		await writeDeadLetter(deps.db, job, err.reason, err.message, now);
		controller.ack();
		return;
	}
	console.error("[labeler] unexpected discovery consumer error", {
		did: job.did,
		collection: job.collection,
		rkey: job.rkey,
		error: err instanceof Error ? (err.stack ?? err.message) : String(err),
	});
	await writeDeadLetter(
		deps.db,
		job,
		"UNEXPECTED_ERROR",
		err instanceof Error ? err.message : String(err),
		now,
	);
	controller.ack();
}

async function verifyAndCreateRun(
	uri: string,
	job: DiscoveryJob,
	deps: DiscoveryConsumerDeps,
	now: Date,
): Promise<void> {
	// Capture the subject's tombstone generation BEFORE verifying. Every commit
	// below (subject-undelete, run creation, label issuance) is gated on the
	// generation not having advanced past this — so a delete that lands during the
	// (slow) verify is seen as a newer generation and the whole create is rejected
	// obsolete, while a create that captured the post-delete generation proceeds.
	const generation = await readDeleteGeneration(deps.db, { uri, cid: job.cid });

	const verifyFn = deps.verify ?? fetchAndVerifyExactRecord;
	// Propagates PdsVerificationError / RecordVerificationError untouched —
	// the caller classifies retry vs dead-letter.
	await verifyFn({
		uri,
		cid: job.cid,
		didDocumentResolver: deps.didDocumentResolver,
		...(deps.fetch ? { fetch: deps.fetch } : {}),
		...(deps.resolveHostname ? { resolveHostname: deps.resolveHostname } : {}),
	});

	// Generation-gated: a re-observation only clears `deleted_at` if no delete has
	// advanced the generation since the capture. A stale verify cannot resurrect a
	// subject deleted after it read state.
	await createSubject(deps.db, {
		uri,
		cid: job.cid,
		did: job.did,
		collection: job.collection,
		rkey: job.rkey,
		now,
		expectedGeneration: generation,
	});

	const triggerId = initialTriggerId(job.cid);
	const runKey = await computeRunKey({
		uri,
		cid: job.cid,
		policyVersion: MODERATION_POLICY.policyVersion,
		modelId: DISCOVERY_MODEL_ID,
		promptHash: DISCOVERY_PROMPT_HASH,
		scannerSetVersion: DISCOVERY_SCANNER_SET_VERSION,
		triggerId,
	});

	// Generation-gated run creation: no orphan run for a subject the delete removed
	// between the capture and here.
	await buildAssessmentRunStatement(deps.db, {
		id: `asmt_${ulid()}`,
		runKey,
		uri,
		cid: job.cid,
		trigger: "initial",
		triggerId,
		policyVersion: MODERATION_POLICY.policyVersion,
		modelId: DISCOVERY_MODEL_ID,
		promptHash: DISCOVERY_PROMPT_HASH,
		coverageJson: "{}",
		now,
		requireSubjectGeneration: generation,
	}).run();
	const assessment = await getAssessmentByRunKey(deps.db, runKey);
	if (!assessment) {
		// The run insert matched no row: a delete advanced the generation before it
		// committed. Obsolete — nothing to advance, issue, or dispatch.
		return;
	}

	await advanceToPending(deps.db, assessment, now);

	const outcome = await issueInitialPendingLabel(
		deps,
		assessment.id,
		runKey,
		uri,
		job.cid,
		generation,
		now,
	);
	if (outcome === "obsolete") {
		// A concurrent delete tombstoned the subject (advancing the generation) or
		// cancelled the run before the positive assessment-pending could commit — the
		// run is moot. The issuance no-op'd, so there is nothing to publish and
		// nothing to assess; the delete owns tombstone + cancel + negation. Do not
		// dispatch a Workflow for a label that never committed.
		return;
	}

	// Hand the run to its Workflow instance. The instance id is the run's runKey,
	// so a redelivered event (same runKey) converges on the same instance rather
	// than starting a second run. A dispatch infra failure throws
	// AssessmentDispatchError → the message retries; upstream steps are all
	// idempotent, so redelivery re-dispatches.
	await dispatchAssessmentWorkflow(deps.assessmentWorkflow, {
		runKey,
		assessmentId: assessment.id,
	});
}

/**
 * Issues the initial positive `assessment-pending` label, atomically gated at
 * commit on BOTH the run still being `pending` AND the subject `(uri, cid)` still
 * undeleted (`buildIssuanceStatements`' `requireAssessmentState` +
 * `requireSubjectNotDeleted`). A concurrent delete that tombstones the subject or
 * cancels the run in the gap after `advanceToPending` makes the guarded insert
 * match no row: the issuance is obsolete — no label commits, so this returns
 * without publishing or signalling a dispatch, and the delete's negation owns the
 * stream. A non-persist NOT explained by the guard (a signing flip mid-batch)
 * throws `LabelIssuanceUnavailableError` so the message retries. Reuses the same
 * guarded-issuance machinery as finalization and the console path (no second SQL
 * path); `readIssuedLabelByActionKey` tolerates a legitimate no-op without the
 * signing-diagnosis throw `issueLabel`'s post-commit applies.
 */
async function issueInitialPendingLabel(
	deps: DiscoveryConsumerDeps,
	assessmentId: string,
	runKey: string,
	uri: string,
	cid: string,
	generation: number,
	now: Date,
): Promise<"issued" | "obsolete"> {
	const idempotencyKey = automatedIdempotencyKey(runKey, "assessment-pending", false);
	const action: AutomatedIssuanceAction = {
		actor: deps.config.labelerDid,
		type: "automated-assessment",
		assessmentId,
		reason: "initial discovery",
		idempotencyKey,
	};
	const proposal: AutomatedLabelProposal = { uri, cid, val: "assessment-pending" };

	// A redelivery whose first attempt already committed the label converges here:
	// re-drive the live notify (best-effort) and treat it as issued.
	const existing = await readIssuedLabelByActionKey(deps.db, idempotencyKey);
	if (existing) {
		if (deps.publisher) await deps.publisher.publish(existing);
		return "issued";
	}

	const { statements } = await buildIssuanceStatements(
		deps.db,
		deps.config,
		deps.signer,
		action,
		proposal,
		now,
		deps.publisher !== undefined,
		{
			requireAssessmentState: "pending",
			requireSubjectNotDeleted: { uri, cid, generation },
		},
	);
	await deps.db.batch(statements);

	const issued = await readIssuedLabelByActionKey(deps.db, idempotencyKey);
	if (issued) {
		if (deps.publisher) await deps.publisher.publish(issued);
		return "issued";
	}

	// The guarded insert matched no row. If the run is no longer `pending` or the
	// subject was tombstoned / re-deleted (generation advanced), a concurrent delete
	// won — a benign no-op. Anything else (the signing guard no-op'ing on a mid-batch
	// pause/rotation) is retryable.
	const run = await getAssessment(deps.db, assessmentId);
	if (
		!run ||
		run.state !== "pending" ||
		!(await subjectMatchesGeneration(deps.db, { uri, cid, generation }))
	)
		return "obsolete";
	throw new LabelIssuanceUnavailableError("initial pending label did not persist");
}

/**
 * Advances a freshly-created (or redelivered) run from `observed` to
 * `pending`, tolerating a concurrent invocation that already did some or all
 * of the work — redelivery of the same discovery event must converge on the
 * same outcome rather than throw on the second attempt.
 */
async function advanceToPending(db: D1Database, assessment: Assessment, now: Date): Promise<void> {
	let current = assessment;
	if (current.state === "observed") {
		current = await transitionOrObserve(db, current, "observed", "verifying", now);
	}
	if (current.state === "verifying") {
		await transitionOrObserve(db, current, "verifying", "pending", now);
	}
}

async function transitionOrObserve(
	db: D1Database,
	assessment: Assessment,
	from: Assessment["state"],
	to: Assessment["state"],
	now: Date,
): Promise<Assessment> {
	try {
		return await transitionAssessmentState(db, { id: assessment.id, from, to, now });
	} catch (err) {
		if (!(err instanceof AssessmentTransitionConflictError)) throw err;
		const current = await getAssessment(db, assessment.id);
		if (!current)
			throw new Error(`assessment ${assessment.id} disappeared mid-transition`, { cause: err });
		return current;
	}
}

/**
 * Tombstones the subject (advancing its `delete_generation`) and retires every
 * run that could still carry a live positive `assessment-pending` — including any
 * terminal run still holding a committed, un-negated positive (a `stale` run that
 * self-transitioned on a deleted/superseded subject, or a decision run that
 * suppressed its own pending-negation while a sibling was in flight). For each such
 * run the negation is issued BEFORE any cancellation, so a failed or paused
 * negation (signing mid-rotation) leaves a non-terminal run non-terminal and
 * re-discoverable on redelivery; cancelling first would drop it from the scan set,
 * stranding the pending live once the message acks.
 *
 * The negation is keyed on the run having committed a live positive — NOT on its
 * lifecycle state — because an operator rerun issues its positive while the run is
 * still `observed`, and a terminal run keeps its positive after finalizing.
 * Cancellation applies only to non-terminal runs (a terminal run needs none). The
 * invariant: a run is cancelled only after any positive it committed has been
 * negated, and the message cannot ack while a negation is still owed (a throw
 * propagates to the delete handler's mutation-phase catch, which always retries),
 * so no active `assessment-pending` survives an acked delete.
 */
async function applyDiscoveryDelete(
	deps: DiscoveryConsumerDeps,
	uri: string,
	now: Date,
): Promise<void> {
	await deleteSubjectsByUri(deps.db, { uri, now });
	const runs = await listPendingBearingAssessmentsForUri(deps.db, uri);
	for (const run of runs) {
		// Negate (before any cancel) any run — non-terminal OR terminal `stale` —
		// that committed a positive pending and has not already been negated.
		const positive = await readIssuedLabelByActionKey(
			deps.db,
			automatedIdempotencyKey(run.runKey, "assessment-pending", false),
		);
		if (positive) {
			const negated = await readIssuedLabelByActionKey(
				deps.db,
				automatedIdempotencyKey(run.runKey, "assessment-pending", true),
			);
			if (!negated) await negateRunPendingLabel(deps, run, now);
		}
		if (TERMINAL_STATES.has(run.state)) continue; // already terminal — negated, nothing to cancel
		try {
			await transitionAssessmentState(deps.db, {
				id: run.id,
				from: run.state,
				to: "cancelled",
				now,
			});
		} catch (err) {
			// A concurrent invocation already moved this run past `from` —
			// harmless, the delete's intent (no non-terminal run survives) is
			// already satisfied.
			if (!(err instanceof AssessmentTransitionConflictError)) throw err;
		}
	}
}

/**
 * Negates one run's `assessment-pending` label so a deleted release stops
 * advertising an in-progress assessment. Deterministic idempotency key (the
 * run's runKey), so a redelivered delete converges and a run whose pending is
 * already negated (finalized) no-ops. Publishes best-effort with the sweep as
 * backstop. Throws `LabelIssuanceUnavailableError` when signing is paused — the
 * caller must let that propagate so the delete retries.
 */
async function negateRunPendingLabel(
	deps: DiscoveryConsumerDeps,
	run: Assessment,
	now: Date,
): Promise<void> {
	await issueAutomatedAssessmentLabel(
		deps.db,
		deps.config,
		deps.signer,
		{
			actor: deps.config.labelerDid,
			type: "automated-assessment",
			assessmentId: run.id,
			reason: "subject deleted",
			idempotencyKey: automatedIdempotencyKey(run.runKey, "assessment-pending", true),
		},
		{ uri: run.uri, cid: run.cid, val: "assessment-pending", neg: true },
		now,
		deps.publisher,
	);
}

function jobUri(job: DiscoveryJob): string {
	return `at://${job.did}/${job.collection}/${job.rkey}`;
}

/** Capped exponential backoff for a transient PDS failure. The queue has no
 * `retry_delay`, so a bare `retry()` re-delivers in the next batch — with only
 * `max_retries` attempts, an immediate loop can exhaust every attempt before
 * ordinary DNS propagation completes (the empty-answer/resolver-failure path
 * routes propagation lag here). Delaying each retry gives the host time to
 * resolve without an unbounded backlog. */
const RETRY_BASE_DELAY_SECONDS = 15;
const RETRY_MAX_DELAY_SECONDS = 300;

function transientRetryDelaySeconds(attempts: number): number {
	const exponent = Math.max(0, attempts - 1);
	return Math.min(RETRY_BASE_DELAY_SECONDS * 2 ** exponent, RETRY_MAX_DELAY_SECONDS);
}

/**
 * Translate a permanent `PdsVerificationError.reason` to its
 * `DiscoveryDeadLetterReason` counterpart. Transient reasons
 * (`PDS_NETWORK_ERROR` today) are unreachable because the caller filters
 * them via `isTransient` first; throw rather than silently dead-letter to
 * surface the broken invariant loudly.
 */
function mapPdsReason(reason: VerificationFailureReason): DiscoveryDeadLetterReason {
	switch (reason) {
		case "RECORD_NOT_FOUND":
		case "RESPONSE_TOO_LARGE":
		case "INVALID_PROOF":
		case "PDS_HTTP_ERROR":
		case "PDS_HOST_BLOCKED":
			return reason;
		case "PDS_NETWORK_ERROR":
			throw new Error(
				"unreachable: PDS_NETWORK_ERROR should have been retried by isTransient before reaching mapPdsReason",
			);
		default: {
			const exhaustive: never = reason;
			throw new Error(`unhandled PdsVerificationError reason: ${String(exhaustive)}`);
		}
	}
}

// ─── Production wiring ─────────────────────────────────────────────────────

async function createProductionDiscoveryDeps(env: Env): Promise<DiscoveryConsumerDeps> {
	const identityConfig = await getLabelerIdentityConfig(env);
	const versioned = await createRuntimeSigner(identityConfig, getRuntimeSigningSecret(env));
	return {
		db: env.DB,
		config: identityConfig,
		signer: versioned.signer,
		assessmentWorkflow: env.ASSESSMENT_WORKFLOW,
		publisher: bestEffortPublisher(createLabelPublisher(env)),
		didDocumentResolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver({ fetch: boundFetch }),
				web: new AtprotoWebDidDocumentResolver({ fetch: boundFetch }),
			},
		}),
		// pds-verify uses this fetch for the CAR fetch. workerd's `fetch`
		// rejects calls made through a stored reference, so we hand off the
		// bound wrapper rather than letting pds-verify.ts fall back to bare
		// global `fetch`.
		fetch: boundFetch,
		// SSRF egress guard for the publisher-controlled PDS endpoint and any
		// redirect it serves — the same DoH resolver artifact acquisition uses.
		resolveHostname: cloudflareDohResolver,
	};
}

const boundFetch: typeof fetch = globalThis.fetch.bind(globalThis);

/**
 * Wraps the subscription-DO publisher so a failed live broadcast never fails the
 * discovery message: the label has already committed `publication_pending = 1`,
 * so a dropped notify is recovered by the reconciliation sweep. Mirrors the
 * orchestrator's best-effort post-commit publication. Keeps `managesPublicationState`
 * so `issueLabel` leaves the flag set (the DO clears it on a successful notify).
 */
export function bestEffortPublisher(base: LabelPublisher): LabelPublisher {
	return {
		managesPublicationState: base.managesPublicationState,
		async publish(issued) {
			try {
				await base.publish(issued);
			} catch (error) {
				console.error("[labeler] discovery label publication failed", {
					sequence: issued.sequence,
					error: error instanceof Error ? error.message : String(error),
				});
			}
		},
	};
}

async function writeDeadLetter(
	db: D1Database,
	job: DiscoveryJob,
	reason: DiscoveryDeadLetterReason,
	detail: string | null,
	now: Date,
): Promise<void> {
	// Persist the whole discovery job (identity + operation + cid + the unverified
	// Jetstream record) so an operator retry can re-enqueue an identical job for a
	// re-drive (design §6); the record alone would lose the cid a re-verify needs.
	const payload = JSON.stringify(job);
	const payloadBytes = new TextEncoder().encode(payload);
	await db
		.prepare(
			`INSERT INTO dead_letters
			   (did, collection, rkey, reason, detail, payload, received_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?)`,
		)
		.bind(job.did, job.collection, job.rkey, reason, detail, payloadBytes, now.toISOString())
		.run();
}
