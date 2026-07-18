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
} from "./assessment-lifecycle.js";
import {
	createAssessmentRun,
	createSubject,
	deleteSubjectsByUri,
	getAssessment,
	listNonTerminalAssessmentsForUri,
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
import { issueAutomatedAssessmentLabel, LabelIssuanceUnavailableError } from "./service.js";
import { createRuntimeSigner, getRuntimeSigningSecret } from "./signing-runtime.js";

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
	ack(): void;
	retry(): void;
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
		try {
			// A delete suppresses assessment work (tombstone + cancel runs), so it
			// gets the same distrust as a create: confirm the record is genuinely
			// gone at the PDS before acting. A still-present record means a forged
			// or premature delete — dead-letter it, suppress nothing.
			const confirmAbsent = deps.confirmDeleted ?? confirmRecordAbsent;
			const absent = await confirmAbsent({
				uri,
				didDocumentResolver: deps.didDocumentResolver,
				...(deps.fetch ? { fetch: deps.fetch } : {}),
				...(deps.resolveHostname ? { resolveHostname: deps.resolveHostname } : {}),
			});
			if (!absent) {
				await writeDeadLetter(
					deps.db,
					job,
					"DELETE_RECORD_PRESENT",
					"record still resolves",
					now(),
				);
				controller.ack();
				return;
			}
			const cancelled = await applyDiscoveryDelete(deps.db, uri, now());
			await negatePendingForDeletedRuns(deps, cancelled, now());
			controller.ack();
		} catch (err) {
			await classifyDiscoveryError(err, job, deps, controller, now());
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
			controller.retry();
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

	await createSubject(deps.db, {
		uri,
		cid: job.cid,
		did: job.did,
		collection: job.collection,
		rkey: job.rkey,
		now,
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

	const { assessment } = await createAssessmentRun(deps.db, {
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
	});

	await advanceToPending(deps.db, assessment, now);

	await issueAutomatedAssessmentLabel(
		deps.db,
		deps.config,
		deps.signer,
		{
			actor: deps.config.labelerDid,
			type: "automated-assessment",
			assessmentId: assessment.id,
			reason: "initial discovery",
			idempotencyKey: automatedIdempotencyKey(runKey, "assessment-pending", false),
		},
		{ uri, cid: job.cid, val: "assessment-pending" },
		now,
	);

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

/** Tombstones the subject, cancels non-terminal runs, and returns the runs
 * that had already reached `pending` (so they carry an active
 * `assessment-pending` label the caller must negate). */
async function applyDiscoveryDelete(db: D1Database, uri: string, now: Date): Promise<Assessment[]> {
	await deleteSubjectsByUri(db, { uri, now });
	const runs = await listNonTerminalAssessmentsForUri(db, uri);
	const hadPending: Assessment[] = [];
	for (const run of runs) {
		if (
			run.state !== "observed" &&
			run.state !== "verifying" &&
			run.state !== "pending" &&
			run.state !== "running"
		)
			continue;
		if (run.state === "pending" || run.state === "running") hadPending.push(run);
		try {
			await transitionAssessmentState(db, { id: run.id, from: run.state, to: "cancelled", now });
		} catch (err) {
			// A concurrent invocation already moved this run past `from` —
			// harmless, the delete's intent (no non-terminal run survives) is
			// already satisfied.
			if (!(err instanceof AssessmentTransitionConflictError)) throw err;
		}
	}
	return hadPending;
}

/**
 * Negates the `assessment-pending` label each cancelled run issued, so a
 * deleted release stops advertising an in-progress assessment. Uses the
 * run's own assessment id and a deterministic idempotency key, so a
 * redelivered delete converges. Idempotent and best-effort per run: a run
 * whose pending is already negated (finalized) no-ops.
 */
async function negatePendingForDeletedRuns(
	deps: DiscoveryConsumerDeps,
	runs: Assessment[],
	now: Date,
): Promise<void> {
	for (const run of runs) {
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
		);
	}
}

function jobUri(job: DiscoveryJob): string {
	return `at://${job.did}/${job.collection}/${job.rkey}`;
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
