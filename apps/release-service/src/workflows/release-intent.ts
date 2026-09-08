import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { base64url } from "jose";

import type ReleaseVerifier from "../../../release-verifier/src/index.js";
import { encodeAwaitingApprovalState, type ApprovalEvidence } from "../approvals/digest.js";
import { invalidateApprovalChallenges } from "../approvals/invalidation.js";
import { writeOperationsMetric } from "../observability/metrics.js";
import type {
	IntentState,
	PublisherDurableObject,
	StoredIntent,
	TransitionIntentInput,
} from "../publisher-do/publisher-do.js";
import { reconcileReleaseRecord } from "../publishing/reconcile.js";
import {
	acquirePublicationCoordination,
	publishVerifiedIntent,
	readPersistedMaterializedRelease,
	releasePublicationCoordination,
} from "../publishing/workflow.js";
import {
	evaluateVerifiedRelease,
	normalizeVerifierReport,
	parseNormalizedVerifierReport,
	prepareVerifierInput,
} from "../verification/evaluate.js";
import {
	findProofVerifiedRelease,
	publisherSnapshotErrorCode,
	readPublisherVerificationSnapshot,
} from "../verification/pds.js";
import { verifyReleaseEvidence } from "../verification/staged-input.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const WORKFLOW_ACTOR = "release-service";

export interface ReleaseIntentWorkflowParams {
	publisherDid: string;
	intentId: string;
}

export interface ReleaseIntentWorkflowOutput {
	intentId: string;
	state: "conflict" | "expired" | "failed" | "invalid" | "published" | "ready" | "rejected";
	reasonCode: string | null;
}

interface AuthoritativeSummary {
	profileCid: string;
	baselineCid: string | null;
	baselineVersion: string | null;
	proposedRkey: string;
	releaseAbsent: boolean;
}

type AuthoritativeStepResult =
	| { success: true; value: AuthoritativeSummary }
	| {
			success: false;
			code:
				| "PROFILE_INVALID"
				| "RELEASE_EXISTS"
				| "RELEASE_LIST_INVALID"
				| "RELEASE_RECORD_INVALID";
	  };

interface WorkflowDecision {
	requiresApproval: boolean;
	approvalEvidence: ApprovalEvidence;
	approvers: string[];
	confirmation: "always" | "escalation-only";
	accessDiffJson: string;
}

type WorkflowEvaluation =
	| { success: true; value: WorkflowDecision }
	| { success: false; code: string; reasonCode: string };

type TransitionSummary =
	| { ok: true; state: IntentState; stateGeneration: number; expiresAt: number }
	| { ok: false; code: string };

interface IntentSummary {
	state: IntentState;
	stateGeneration: number;
	expiresAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function stringField(value: Record<string, unknown>, key: string): string | null {
	const field = value[key];
	return typeof field === "string" ? field : null;
}

function parseStoredWorkflowDecision(value: string): WorkflowDecision | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(value);
	} catch {
		return null;
	}
	if (
		!isRecord(parsed) ||
		typeof parsed["requiresApproval"] !== "boolean" ||
		!isRecord(parsed["approvalEvidence"]) ||
		!Array.isArray(parsed["approvers"]) ||
		parsed["approvers"].some((approver) => typeof approver !== "string") ||
		(parsed["confirmation"] !== "always" && parsed["confirmation"] !== "escalation-only") ||
		typeof parsed["accessDiffJson"] !== "string"
	) {
		return null;
	}
	const source = parsed["approvalEvidence"];
	const intentId = stringField(source, "intentId");
	const publisherDid = stringField(source, "publisherDid");
	const packageSlug = stringField(source, "packageSlug");
	const version = stringField(source, "version");
	const workloadIdentityDigest = stringField(source, "workloadIdentityDigest");
	const releaseInputDigest = stringField(source, "releaseInputDigest");
	const profileCid = stringField(source, "profileCid");
	const artifactChecksum = stringField(source, "artifactChecksum");
	const provenanceChecksum = stringField(source, "provenanceChecksum");
	const declaredAccessDiffDigest = stringField(source, "declaredAccessDiffDigest");
	const verificationDigest = stringField(source, "verificationDigest");
	const baselineReleaseCid = source["baselineReleaseCid"];
	if (
		!intentId ||
		!publisherDid ||
		!packageSlug ||
		!version ||
		!Number.isSafeInteger(source["verificationGeneration"]) ||
		Number(source["verificationGeneration"]) < 3 ||
		!workloadIdentityDigest ||
		!releaseInputDigest ||
		!profileCid ||
		(baselineReleaseCid !== null && typeof baselineReleaseCid !== "string") ||
		!artifactChecksum ||
		!provenanceChecksum ||
		!declaredAccessDiffDigest ||
		!verificationDigest
	) {
		return null;
	}
	return {
		requiresApproval: parsed["requiresApproval"],
		approvalEvidence: {
			intentId,
			publisherDid,
			packageSlug,
			version,
			verificationGeneration: Number(source["verificationGeneration"]),
			workloadIdentityDigest,
			releaseInputDigest,
			profileCid,
			baselineReleaseCid,
			artifactChecksum,
			provenanceChecksum,
			declaredAccessDiffDigest,
			verificationDigest,
		},
		approvers: [...parsed["approvers"]],
		confirmation: parsed["confirmation"],
		accessDiffJson: parsed["accessDiffJson"],
	};
}

type ReleaseWorkflowEnv = Env & {
	RELEASE_VERIFIER: Service<typeof ReleaseVerifier>;
};

function validParams(value: ReleaseIntentWorkflowParams): boolean {
	return DID_PATTERN.test(value.publisherDid) && ULID_PATTERN.test(value.intentId);
}

async function digest(value: unknown): Promise<string> {
	const bytes = new TextEncoder().encode(JSON.stringify(value));
	return base64url.encode(new Uint8Array(await crypto.subtle.digest("SHA-256", bytes)));
}

function plainIntent(value: StoredIntent): StoredIntent {
	return {
		id: value.id,
		packageSlug: value.packageSlug,
		version: value.version,
		state: value.state,
		stateGeneration: value.stateGeneration,
		workloadPolicyVersion: value.workloadPolicyVersion,
		workloadIdentityDigest: value.workloadIdentityDigest,
		workloadIdempotencyDigest: value.workloadIdempotencyDigest,
		requestDigest: value.requestDigest,
		workloadIdentityJson: value.workloadIdentityJson,
		releaseInputJson: value.releaseInputJson,
		stateDataJson: value.stateDataJson,
		workflowId: value.workflowId,
		expiresAt: value.expiresAt,
		createdAt: value.createdAt,
		updatedAt: value.updatedAt,
	};
}

function requireIntent(
	value: StoredIntent | null,
	params: ReleaseIntentWorkflowParams,
	instanceId: string,
): StoredIntent {
	if (
		!value ||
		value.id !== params.intentId ||
		(value.state !== "verifying" && value.state !== "ready" && value.state !== "reconciling") ||
		value.workflowId !== instanceId
	) {
		throw new NonRetryableError("Release intent is not in the expected Workflow state");
	}
	return plainIntent(value);
}

async function transitionIntent(
	publisher: DurableObjectStub<PublisherDurableObject>,
	input: TransitionIntentInput,
): Promise<TransitionSummary> {
	const result = await publisher.transitionIntent(input);
	return result.ok
		? {
				ok: true,
				state: result.intent.state,
				stateGeneration: result.intent.stateGeneration,
				expiresAt: result.intent.expiresAt,
			}
		: { ok: false, code: result.code };
}

async function currentIntent(
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	intentId: string,
): Promise<IntentSummary | null> {
	const intent = await publisher.getIntent(publisherDid, intentId);
	return intent
		? {
				state: intent.state,
				stateGeneration: intent.stateGeneration,
				expiresAt: intent.expiresAt,
			}
		: null;
}

async function failVerifyingIntent(
	publisher: DurableObjectStub<PublisherDurableObject>,
	params: ReleaseIntentWorkflowParams,
	intent: StoredIntent,
	reasonCode: "VERIFICATION_STEP_CONFLICT" | "VERIFIER_INPUT_INVALID",
): Promise<never> {
	const transitioned = await transitionIntent(publisher, {
		publisherDid: params.publisherDid,
		intentId: params.intentId,
		expectedState: "verifying",
		expectedGeneration: intent.stateGeneration,
		toState: "failed",
		transitionDigest: await digest(["verification-failed", reasonCode]),
		actorRealm: "system",
		actorIdentity: WORKFLOW_ACTOR,
		reasonCode,
		stateDataJson: JSON.stringify({ code: reasonCode }),
	});
	if (!transitioned.ok) throw new NonRetryableError(transitioned.code);
	throw new NonRetryableError(reasonCode);
}

export class ReleaseIntentWorkflow extends WorkflowEntrypoint<
	ReleaseWorkflowEnv,
	ReleaseIntentWorkflowParams
> {
	override async run(
		event: Readonly<WorkflowEvent<ReleaseIntentWorkflowParams>>,
		step: WorkflowStep,
	): Promise<ReleaseIntentWorkflowOutput> {
		if (!validParams(event.payload) || event.instanceId !== event.payload.intentId) {
			throw new NonRetryableError("Invalid release-intent Workflow parameters");
		}
		const params = event.payload;
		const publisher = this.env.PUBLISHER_DO.getByName(params.publisherDid);
		const intent = await step.do<StoredIntent>("load-intent", async () =>
			requireIntent(
				await publisher.getIntent(params.publisherDid, params.intentId),
				params,
				event.instanceId,
			),
		);
		if (intent.state === "ready" || intent.state === "reconciling") {
			const decision = await step.do<WorkflowDecision>("recovery-policy-decision", async () => {
				const stored = await publisher.getVerificationStep(
					params.publisherDid,
					params.intentId,
					"policy-decision",
				);
				const parsed = stored ? parseStoredWorkflowDecision(stored.resultJson) : null;
				if (!parsed) throw new NonRetryableError("Stored Workflow decision is invalid");
				return parsed;
			});
			const verificationIntent = {
				...intent,
				stateGeneration: decision.approvalEvidence.verificationGeneration - 2,
			};
			if (intent.state === "reconciling") {
				const coordination = await acquirePublicationCoordination(
					step,
					publisher,
					params.publisherDid,
					intent,
					"recovery",
				);
				if (!coordination) {
					return {
						intentId: params.intentId,
						state: "ready",
						reasonCode: "PUBLICATION_COORDINATION_BUSY",
					};
				}
				const reconciliation = await step.do("recovery-reconciliation", async () => {
					const materialized = await readPersistedMaterializedRelease(
						publisher,
						params.publisherDid,
						params.intentId,
						intent.requestDigest,
					);
					if (!materialized) {
						throw new NonRetryableError("Stored materialized release is unavailable");
					}
					const authoritative = await findProofVerifiedRelease(
						params.publisherDid,
						intent.packageSlug,
						intent.version,
					);
					return reconcileReleaseRecord(
						params.publisherDid,
						intent.packageSlug,
						intent.version,
						materialized.record,
						authoritative,
					);
				});
				if (reconciliation.outcome === "exact") {
					const published = await step.do<TransitionSummary>("recovery-published", async () =>
						transitionIntent(publisher, {
							publisherDid: params.publisherDid,
							intentId: params.intentId,
							expectedState: "reconciling",
							expectedGeneration: intent.stateGeneration,
							toState: "published",
							transitionDigest: await digest([
								"recovery-published",
								reconciliation.uri,
								reconciliation.cid,
							]),
							actorRealm: "system",
							actorIdentity: WORKFLOW_ACTOR,
							reasonCode: null,
							stateDataJson: JSON.stringify({
								resultUri: reconciliation.uri,
								resultCid: reconciliation.cid,
							}),
						}),
					);
					if (!published.ok) throw new NonRetryableError(published.code);
					await releasePublicationCoordination(
						step,
						publisher,
						params.publisherDid,
						coordination,
						"recovery-coordinate-release-published",
					);
					return { intentId: params.intentId, state: "published", reasonCode: null };
				}
				if (reconciliation.outcome === "conflict") {
					const conflict = await step.do<TransitionSummary>("recovery-conflict", async () =>
						transitionIntent(publisher, {
							publisherDid: params.publisherDid,
							intentId: params.intentId,
							expectedState: "reconciling",
							expectedGeneration: intent.stateGeneration,
							toState: "conflict",
							transitionDigest: await digest(["recovery-conflict", params.intentId]),
							actorRealm: "system",
							actorIdentity: WORKFLOW_ACTOR,
							reasonCode: "RELEASE_CONFLICT",
							stateDataJson: JSON.stringify({ reasonCode: "RELEASE_CONFLICT" }),
						}),
					);
					if (!conflict.ok) throw new NonRetryableError(conflict.code);
					await releasePublicationCoordination(
						step,
						publisher,
						params.publisherDid,
						coordination,
						"recovery-coordinate-release-conflict",
					);
					return {
						intentId: params.intentId,
						state: "conflict",
						reasonCode: "RELEASE_CONFLICT",
					};
				}
				const ready = await step.do<TransitionSummary>("recovery-absence", async () =>
					transitionIntent(publisher, {
						publisherDid: params.publisherDid,
						intentId: params.intentId,
						expectedState: "reconciling",
						expectedGeneration: intent.stateGeneration,
						toState: "ready",
						transitionDigest: await digest(["recovery-absence", params.intentId]),
						actorRealm: "system",
						actorIdentity: WORKFLOW_ACTOR,
						reasonCode: "PDS_RETRY_ABSENT",
						stateDataJson: JSON.stringify({ absenceConfirmed: true }),
					}),
				);
				if (!ready.ok) throw new NonRetryableError(ready.code);
				await releasePublicationCoordination(
					step,
					publisher,
					params.publisherDid,
					coordination,
					"recovery-coordinate-release-absent",
				);
			}
			return await publishVerifiedIntent(
				this.env,
				step,
				params.publisherDid,
				verificationIntent,
				decision.approvalEvidence,
			);
		}
		const authoritativeResult = await step.do<AuthoritativeStepResult>(
			"authoritative-records",
			async () => {
				let snapshot;
				try {
					snapshot = await readPublisherVerificationSnapshot(
						params.publisherDid,
						intent.packageSlug,
						intent.version,
					);
				} catch (error) {
					const code = publisherSnapshotErrorCode(error);
					if (
						code === "PROFILE_INVALID" ||
						code === "RELEASE_EXISTS" ||
						code === "RELEASE_LIST_INVALID" ||
						code === "RELEASE_RECORD_INVALID"
					) {
						return { success: false, code };
					}
					throw error;
				}
				const result: AuthoritativeSummary = {
					profileCid: snapshot.profile.cid,
					baselineCid: snapshot.baseline?.cid ?? null,
					baselineVersion: snapshot.baselineVersion,
					proposedRkey: snapshot.proposedRkey,
					releaseAbsent: snapshot.proposedReleaseAbsent,
				};
				const baseDigest = await digest([
					params.publisherDid,
					params.intentId,
					intent.requestDigest,
					intent.workloadIdentityDigest,
				]);
				const storedProfile = await publisher.putVerificationStep({
					publisherDid: params.publisherDid,
					intentId: params.intentId,
					name: "authoritative-profile",
					inputDigest: baseDigest,
					resultJson: JSON.stringify({ profileCid: result.profileCid }),
				});
				if (!storedProfile.ok) {
					if (storedProfile.code === "VERIFICATION_STEP_CONFLICT") {
						await failVerifyingIntent(publisher, params, intent, storedProfile.code);
					}
					throw new NonRetryableError(storedProfile.code);
				}
				const storedAbsence = await publisher.putVerificationStep({
					publisherDid: params.publisherDid,
					intentId: params.intentId,
					name: "release-absence",
					inputDigest: await digest([baseDigest, result.proposedRkey]),
					resultJson: JSON.stringify({
						proposedRkey: result.proposedRkey,
						absent: result.releaseAbsent,
					}),
				});
				if (!storedAbsence.ok) {
					if (storedAbsence.code === "VERIFICATION_STEP_CONFLICT") {
						await failVerifyingIntent(publisher, params, intent, storedAbsence.code);
					}
					throw new NonRetryableError(storedAbsence.code);
				}
				const storedBaseline = await publisher.putVerificationStep({
					publisherDid: params.publisherDid,
					intentId: params.intentId,
					name: "access-baseline",
					inputDigest: await digest([baseDigest, result.baselineCid, result.baselineVersion]),
					resultJson: JSON.stringify({
						baselineCid: result.baselineCid,
						baselineVersion: result.baselineVersion,
					}),
				});
				if (!storedBaseline.ok) {
					if (storedBaseline.code === "VERIFICATION_STEP_CONFLICT") {
						await failVerifyingIntent(publisher, params, intent, storedBaseline.code);
					}
					throw new NonRetryableError(storedBaseline.code);
				}
				return { success: true, value: result };
			},
		);
		if (!authoritativeResult.success) {
			const code = authoritativeResult.code;
			const state = code === "PROFILE_INVALID" || code === "RELEASE_EXISTS" ? "invalid" : "failed";
			const reasonCode = code === "PROFILE_INVALID" ? "PACKAGE_PROFILE_REQUIRED" : code;
			const transitioned = await step.do<TransitionSummary>("mark-snapshot-failed", async () =>
				transitionIntent(publisher, {
					publisherDid: params.publisherDid,
					intentId: params.intentId,
					expectedState: "verifying",
					expectedGeneration: intent.stateGeneration,
					toState: state,
					transitionDigest: await digest(["snapshot-failed", code]),
					actorRealm: "system",
					actorIdentity: WORKFLOW_ACTOR,
					reasonCode,
					stateDataJson: JSON.stringify({ code }),
				}),
			);
			if (!transitioned.ok) throw new NonRetryableError(transitioned.code);
			return { intentId: params.intentId, state, reasonCode };
		}
		const authoritative = authoritativeResult.value;
		const verifierJson = await step.do<string>("isolated-verifier", async () => {
			const snapshot = await readPublisherVerificationSnapshot(
				params.publisherDid,
				intent.packageSlug,
				intent.version,
			);
			const input = prepareVerifierInput(intent, snapshot);
			if (!input) {
				return await failVerifyingIntent(publisher, params, intent, "VERIFIER_INPUT_INVALID");
			}
			const report = normalizeVerifierReport(
				await verifyReleaseEvidence({ ...intent, publisherDid: params.publisherDid }, input, {
					bucket: this.env.PUBLICATION_STAGING,
					publicOrigin: this.env.PUBLIC_ORIGIN,
					verifier: this.env.RELEASE_VERIFIER,
				}),
			);
			if (!report.success) {
				writeOperationsMetric(
					{
						event: "verifier_failure",
						outcome: report.error.code,
						scope: "isolated",
					},
					this.env.OPERATIONS_METRICS,
				);
			}
			const resultJson = JSON.stringify(report);
			const stored = await publisher.putVerificationStep({
				publisherDid: params.publisherDid,
				intentId: params.intentId,
				name: "artifact-provenance",
				inputDigest: await digest(input),
				resultJson,
			});
			if (!stored.ok) {
				if (stored.code === "VERIFICATION_STEP_CONFLICT") {
					await failVerifyingIntent(publisher, params, intent, stored.code);
				}
				throw new NonRetryableError(stored.code);
			}
			return resultJson;
		});
		const evaluation = await step.do<WorkflowEvaluation>("policy-decision", async () => {
			const verifier = parseNormalizedVerifierReport(verifierJson);
			if (!verifier) throw new NonRetryableError("Stored verifier report is invalid");
			const snapshot = await readPublisherVerificationSnapshot(
				params.publisherDid,
				intent.packageSlug,
				intent.version,
			);
			let result: WorkflowEvaluation;
			if (
				snapshot.profile.cid !== authoritative.profileCid ||
				(snapshot.baseline?.cid ?? null) !== authoritative.baselineCid
			) {
				result = { success: false, code: "BASELINE_INVALID", reasonCode: "BASELINE_CHANGED" };
			} else {
				const workloadPolicy = await publisher.getWorkloadPolicy(
					params.publisherDid,
					intent.packageSlug,
				);
				const evaluated = await evaluateVerifiedRelease(
					params.publisherDid,
					intent,
					snapshot,
					workloadPolicy,
					verifier,
				);
				result = evaluated.success
					? {
							success: true,
							value: {
								requiresApproval: evaluated.value.requiresApproval,
								approvalEvidence: evaluated.value.approvalEvidence,
								approvers: [...evaluated.value.records.policy.approvers],
								confirmation: evaluated.value.records.policy.confirmation,
								accessDiffJson: JSON.stringify(evaluated.value.accessDiff),
							},
						}
					: evaluated;
			}
			const resultJson = JSON.stringify(result.success ? result.value : result);
			const stored = await publisher.putVerificationStep({
				publisherDid: params.publisherDid,
				intentId: params.intentId,
				name: "policy-decision",
				inputDigest: await digest({ authoritative, verifierJson }),
				resultJson,
			});
			if (!stored.ok) {
				if (stored.code === "VERIFICATION_STEP_CONFLICT") {
					await failVerifyingIntent(publisher, params, intent, stored.code);
				}
				throw new NonRetryableError(stored.code);
			}
			return result;
		});
		if (!evaluation.success) {
			const transitioned = await step.do<TransitionSummary>("mark-invalid", async () =>
				transitionIntent(publisher, {
					publisherDid: params.publisherDid,
					intentId: params.intentId,
					expectedState: "verifying",
					expectedGeneration: intent.stateGeneration,
					toState: "invalid",
					transitionDigest: await digest(["invalid", evaluation.code, evaluation.reasonCode]),
					actorRealm: "system",
					actorIdentity: WORKFLOW_ACTOR,
					reasonCode: evaluation.reasonCode,
					stateDataJson: JSON.stringify({ code: evaluation.code }),
				}),
			);
			if (!transitioned.ok) throw new NonRetryableError(transitioned.code);
			return { intentId: params.intentId, state: "invalid", reasonCode: evaluation.reasonCode };
		}
		const decision = evaluation.value;
		const verified = await step.do<TransitionSummary>("mark-verified", async () =>
			transitionIntent(publisher, {
				publisherDid: params.publisherDid,
				intentId: params.intentId,
				expectedState: "verifying",
				expectedGeneration: intent.stateGeneration,
				toState: "verified",
				transitionDigest: decision.approvalEvidence.verificationDigest,
				actorRealm: "system",
				actorIdentity: WORKFLOW_ACTOR,
				reasonCode: null,
				stateDataJson: JSON.stringify({
					verificationDigest: decision.approvalEvidence.verificationDigest,
				}),
			}),
		);
		if (!verified.ok) throw new NonRetryableError(verified.code);
		if (!decision.requiresApproval) {
			const ready = await step.do<TransitionSummary>("mark-ready", async () =>
				transitionIntent(publisher, {
					publisherDid: params.publisherDid,
					intentId: params.intentId,
					expectedState: "verified",
					expectedGeneration: verified.stateGeneration,
					toState: "ready",
					transitionDigest: await digest(["ready", decision.approvalEvidence.verificationDigest]),
					actorRealm: "system",
					actorIdentity: WORKFLOW_ACTOR,
					reasonCode: null,
					stateDataJson: JSON.stringify({
						verificationDigest: decision.approvalEvidence.verificationDigest,
					}),
				}),
			);
			if (!ready.ok) throw new NonRetryableError(ready.code);
			return await publishVerifiedIntent(
				this.env,
				step,
				params.publisherDid,
				intent,
				decision.approvalEvidence,
			);
		}
		const awaiting = await step.do<TransitionSummary>("await-approval", async () =>
			transitionIntent(publisher, {
				publisherDid: params.publisherDid,
				intentId: params.intentId,
				expectedState: "verified",
				expectedGeneration: verified.stateGeneration,
				toState: "awaiting_approval",
				transitionDigest: await digest(["awaiting-approval", decision.approvalEvidence]),
				actorRealm: "system",
				actorIdentity: WORKFLOW_ACTOR,
				reasonCode: "APPROVAL_REQUIRED",
				stateDataJson: await encodeAwaitingApprovalState(
					decision.approvalEvidence,
					decision.approvers,
				),
			}),
		);
		if (!awaiting.ok) throw new NonRetryableError(awaiting.code);
		let waitStartedAt = event.timestamp.getTime();
		let waitSequence = 1;
		for (;;) {
			const waitName =
				waitSequence === 1 ? "approval-decision" : `approval-decision-${waitSequence}`;
			try {
				await step.waitForEvent(waitName, {
					type: "approval-decision",
					timeout: Math.max(1, awaiting.expiresAt - waitStartedAt),
				});
				break;
			} catch {
				const timeoutStateName =
					waitSequence === 1 ? "approval-timeout-state" : `approval-timeout-state-${waitSequence}`;
				const timeoutState = await step.do<{ intent: IntentSummary | null; checkedAt: number }>(
					timeoutStateName,
					async () => ({
						intent: await currentIntent(publisher, params.publisherDid, params.intentId),
						checkedAt: Date.now(),
					}),
				);
				if (
					timeoutState.intent?.state === "awaiting_approval" &&
					timeoutState.checkedAt >= timeoutState.intent.expiresAt
				) {
					const expired = await step.do<TransitionSummary>("mark-expired", async () => {
						const result = await transitionIntent(publisher, {
							publisherDid: params.publisherDid,
							intentId: params.intentId,
							expectedState: "awaiting_approval",
							expectedGeneration: timeoutState.intent!.stateGeneration,
							toState: "expired",
							transitionDigest: await digest(["expired", decision.approvalEvidence]),
							actorRealm: "system",
							actorIdentity: WORKFLOW_ACTOR,
							reasonCode: "APPROVAL_EXPIRED",
							stateDataJson: JSON.stringify({ reasonCode: "APPROVAL_EXPIRED" }),
						});
						if (result.ok) {
							await invalidateApprovalChallenges(
								this.env.APPROVER_DO,
								decision.approvers,
								params.intentId,
								"EXPIRED",
								timeoutState.checkedAt,
							);
						}
						return result;
					});
					if (!expired.ok) throw new NonRetryableError(expired.code);
					return { intentId: params.intentId, state: "expired", reasonCode: "APPROVAL_EXPIRED" };
				}
				if (timeoutState.intent?.state === "awaiting_approval") {
					waitStartedAt = timeoutState.checkedAt;
					waitSequence += 1;
					continue;
				}
				break;
			}
		}
		const completed = await step.do<IntentSummary | null>("approval-result", () =>
			currentIntent(publisher, params.publisherDid, params.intentId),
		);
		if (completed?.state === "ready") {
			return await publishVerifiedIntent(
				this.env,
				step,
				params.publisherDid,
				intent,
				decision.approvalEvidence,
			);
		}
		if (completed?.state === "rejected") {
			return { intentId: params.intentId, state: "rejected", reasonCode: "REJECTED" };
		}
		throw new NonRetryableError("Approval event did not produce a terminal approval result");
	}
}
