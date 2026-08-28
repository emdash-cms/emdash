import { WorkflowEntrypoint, type WorkflowEvent, type WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { base64url } from "jose";

import type ReleaseVerifier from "../../../release-verifier/src/index.js";
import { encodeAwaitingApprovalState, type ApprovalEvidence } from "../approvals/digest.js";
import { invalidateApprovalChallenges } from "../approvals/invalidation.js";
import type {
	IntentState,
	PublisherDurableObject,
	StoredIntent,
	TransitionIntentInput,
} from "../publisher-do/publisher-do.js";
import {
	evaluateVerifiedRelease,
	normalizeVerifierReport,
	parseNormalizedVerifierReport,
	prepareVerifierInput,
} from "../verification/evaluate.js";
import { readPublisherVerificationSnapshot } from "../verification/pds.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const WORKFLOW_ACTOR = "release-service";

export interface ReleaseIntentWorkflowParams {
	publisherDid: string;
	intentId: string;
}

export interface ReleaseIntentWorkflowOutput {
	intentId: string;
	state: "expired" | "invalid" | "ready" | "rejected";
	reasonCode: string | null;
}

interface AuthoritativeSummary {
	profileCid: string;
	baselineCid: string | null;
	baselineVersion: string | null;
	proposedRkey: string;
	releaseAbsent: boolean;
}

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
		value.state !== "verifying" ||
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
		const authoritative = await step.do<AuthoritativeSummary>("authoritative-records", async () => {
			const snapshot = await readPublisherVerificationSnapshot(
				params.publisherDid,
				intent.packageSlug,
				intent.version,
			);
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
			return result;
		});
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
			const report = normalizeVerifierReport(await this.env.RELEASE_VERIFIER.verifyRelease(input));
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
				const evaluated = await evaluateVerifiedRelease(
					params.publisherDid,
					intent,
					snapshot,
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
			return { intentId: params.intentId, state: "ready", reasonCode: null };
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
				stateDataJson: await encodeAwaitingApprovalState(decision.approvalEvidence),
			}),
		);
		if (!awaiting.ok) throw new NonRetryableError(awaiting.code);
		const timeout = Math.max(1, awaiting.expiresAt - event.timestamp.getTime());
		try {
			await step.waitForEvent("approval-decision", { type: "approval-decision", timeout });
		} catch {
			const timeoutState = await step.do<{ intent: IntentSummary | null; checkedAt: number }>(
				"approval-timeout-state",
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
				throw new Error("Approval wait ended before the intent deadline");
			}
		}
		const completed = await step.do<IntentSummary | null>("approval-result", () =>
			currentIntent(publisher, params.publisherDid, params.intentId),
		);
		if (completed?.state === "ready") {
			return { intentId: params.intentId, state: "ready", reasonCode: null };
		}
		if (completed?.state === "rejected") {
			return { intentId: params.intentId, state: "rejected", reasonCode: "REJECTED" };
		}
		throw new NonRetryableError("Approval event did not produce a terminal approval result");
	}
}
