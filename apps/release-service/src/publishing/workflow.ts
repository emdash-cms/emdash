import { safeParse } from "@atcute/lexicons";
import { isDid } from "@atcute/lexicons/syntax";
import { PackageRelease } from "@emdash-cms/registry-lexicons";
import type { WorkflowStep } from "cloudflare:workers";
import { base64url } from "jose";

import type ReleaseVerifier from "../../../release-verifier/src/index.js";
import { computeApprovalEvidenceDigest, type ApprovalEvidence } from "../approvals/digest.js";
import { loadConfiguration } from "../config.js";
import {
	SERVICE_CONTROL_OBJECT_NAME,
	type ServiceControlDurableObject,
} from "../control-do/service-control-do.js";
import { createPublisherOAuthClient, OAuthCustodyError } from "../oauth/custody.js";
import type {
	IntentState,
	PublisherDurableObject,
	StoredIntent,
} from "../publisher-do/publisher-do.js";
import {
	evaluateVerifiedRelease,
	normalizeVerifierReport,
	prepareVerifierInput,
} from "../verification/evaluate.js";
import {
	findAuthoritativeRelease,
	readPublisherVerificationSnapshot,
} from "../verification/pds.js";
import { CreateReleaseError, createReleaseRecord } from "./create-only.js";
import { reconcileReleaseRecord } from "./reconcile.js";

const PUBLICATION_TTL_MS = 30_000;
const MAX_PUBLICATION_ATTEMPTS = 3;
const RECONCILIATION_STEP_CONFIG = {
	retries: { limit: 3, delay: "1 second", backoff: "exponential" },
	timeout: "2 minutes",
} as const;

export interface PublicationWorkflowOutput {
	intentId: string;
	state: "conflict" | "failed" | "invalid" | "published" | "ready";
	reasonCode: string | null;
}

type PublicationWorkflowEnv = Env & {
	RELEASE_VERIFIER: Service<typeof ReleaseVerifier>;
	SERVICE_CONTROL_DO: DurableObjectNamespace<ServiceControlDurableObject>;
};

type TransitionSummary =
	| { ok: true; state: IntentState; stateGeneration: number }
	| { ok: false; code: string };

type AttemptResult =
	| { state: "published"; uri: string; cid: string }
	| { state: "reconciling" }
	| { state: "blocked"; reasonCode: string }
	| { state: "failed"; reasonCode: string };

function isRetryablePublicationBlock(code: string): boolean {
	return (
		code === "PERMIT_EXPIRED" ||
		code === "PERMIT_STALE" ||
		code === "PUBLICATION_PAUSED" ||
		code === "PUBLISHER_SUSPENDED"
	);
}

async function digest(value: unknown): Promise<string> {
	return base64url.encode(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
		),
	);
}

export function releaseFromIntent(intent: StoredIntent): PackageRelease.Main | null {
	let parsed: unknown;
	try {
		parsed = JSON.parse(intent.releaseInputJson);
	} catch {
		return null;
	}
	if (
		parsed === null ||
		typeof parsed !== "object" ||
		Array.isArray(parsed) ||
		Object.keys(parsed).length !== 1 ||
		!("release" in parsed)
	) {
		return null;
	}
	const release = safeParse(PackageRelease.mainSchema, parsed.release);
	return release.ok ? release.value : null;
}

async function transition(
	publisher: DurableObjectStub<PublisherDurableObject>,
	input: Parameters<PublisherDurableObject["transitionIntent"]>[0],
): Promise<TransitionSummary> {
	const result = await publisher.transitionIntent(input);
	return result.ok
		? { ok: true, state: result.intent.state, stateGeneration: result.intent.stateGeneration }
		: { ok: false, code: result.code };
}

async function currentState(
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	intentId: string,
): Promise<{ state: IntentState; stateGeneration: number } | null> {
	const intent = await publisher.getIntent(publisherDid, intentId);
	return intent ? { state: intent.state, stateGeneration: intent.stateGeneration } : null;
}

export async function publishVerifiedIntent(
	env: PublicationWorkflowEnv,
	step: WorkflowStep,
	publisherDid: string,
	originalIntent: StoredIntent,
	approvalEvidence: ApprovalEvidence,
): Promise<PublicationWorkflowOutput> {
	if (!isDid(publisherDid)) {
		return { intentId: originalIntent.id, state: "invalid", reasonCode: "PUBLISHER_INVALID" };
	}
	const release = releaseFromIntent(originalIntent);
	if (!release) {
		return { intentId: originalIntent.id, state: "invalid", reasonCode: "RELEASE_INVALID" };
	}
	const publisher = env.PUBLISHER_DO.getByName(publisherDid);
	const control = env.SERVICE_CONTROL_DO.getByName(SERVICE_CONTROL_OBJECT_NAME);
	const expectedEvidenceDigest = await computeApprovalEvidenceDigest(approvalEvidence);

	for (let attempt = 1; attempt <= MAX_PUBLICATION_ATTEMPTS; attempt += 1) {
		const finalVerification = await step.do<
			{ ok: true; verificationDigest: string } | { ok: false; reasonCode: string }
		>(`final-verification-${attempt}`, async () => {
			const snapshot = await readPublisherVerificationSnapshot(
				publisherDid,
				originalIntent.packageSlug,
				originalIntent.version,
			);
			const verifierInput = prepareVerifierInput(originalIntent, snapshot);
			if (!verifierInput) return { ok: false, reasonCode: "FINAL_INPUT_INVALID" };
			const verifier = normalizeVerifierReport(
				await env.RELEASE_VERIFIER.verifyRelease(verifierInput),
			);
			const evaluation = await evaluateVerifiedRelease(
				publisherDid,
				originalIntent,
				snapshot,
				verifier,
			);
			if (!evaluation.success) return { ok: false, reasonCode: evaluation.reasonCode };
			if (
				(await computeApprovalEvidenceDigest(evaluation.value.approvalEvidence)) !==
				expectedEvidenceDigest
			) {
				return { ok: false, reasonCode: "FINAL_VERIFICATION_CHANGED" };
			}
			const stored = await publisher.putVerificationStep({
				publisherDid,
				intentId: originalIntent.id,
				name: "final-verification",
				inputDigest: expectedEvidenceDigest,
				resultJson: JSON.stringify({
					verificationDigest: evaluation.value.approvalEvidence.verificationDigest,
				}),
			});
			return stored.ok
				? {
						ok: true,
						verificationDigest: evaluation.value.approvalEvidence.verificationDigest,
					}
				: { ok: false, reasonCode: stored.code };
		});
		if (!finalVerification.ok) {
			const current = await step.do(`final-invalid-state-${attempt}`, () =>
				currentState(publisher, publisherDid, originalIntent.id),
			);
			if (current?.state === "ready") {
				await step.do<TransitionSummary>(`mark-final-invalid-${attempt}`, () =>
					transition(publisher, {
						publisherDid,
						intentId: originalIntent.id,
						expectedState: "ready",
						expectedGeneration: current.stateGeneration,
						toState: "invalid",
						transitionDigest: expectedEvidenceDigest,
						actorRealm: "system",
						actorIdentity: "release-service",
						reasonCode: finalVerification.reasonCode,
						stateDataJson: JSON.stringify({ reasonCode: finalVerification.reasonCode }),
					}),
				);
			}
			return {
				intentId: originalIntent.id,
				state: "invalid",
				reasonCode: finalVerification.reasonCode,
			};
		}

		const attemptResult = await step.do<AttemptResult>(
			`publication-attempt-${attempt}`,
			async () => {
				const current = await publisher.getIntent(publisherDid, originalIntent.id);
				if (current?.state === "published") {
					return { state: "published", uri: "", cid: "" };
				}
				if (current?.state === "reconciling") return { state: "reconciling" };
				if (!current || current.state !== "ready") {
					return { state: "failed", reasonCode: "INTENT_NOT_READY" };
				}
				const permit = await control.issuePublicationPermit(
					publisherDid,
					originalIntent.id,
					PUBLICATION_TTL_MS,
				);
				if (!permit.ok) return { state: "blocked", reasonCode: permit.code };
				const publishing = await transition(publisher, {
					publisherDid,
					intentId: originalIntent.id,
					expectedState: "ready",
					expectedGeneration: current.stateGeneration,
					toState: "publishing",
					transitionDigest: await digest(["publishing", attempt, expectedEvidenceDigest]),
					actorRealm: "system",
					actorIdentity: "release-service",
					reasonCode: null,
					stateDataJson: JSON.stringify({ attempt }),
				});
				if (!publishing.ok) return { state: "failed", reasonCode: publishing.code };
				const operation = await publisher.beginPublicationOperation(
					publisherDid,
					originalIntent.id,
					publishing.stateGeneration,
					PUBLICATION_TTL_MS,
				);
				if (!operation.ok) {
					const failed = await transition(publisher, {
						publisherDid,
						intentId: originalIntent.id,
						expectedState: "publishing",
						expectedGeneration: publishing.stateGeneration,
						toState: "failed",
						transitionDigest: await digest(["operation-failed", attempt, operation.code]),
						actorRealm: "system",
						actorIdentity: "release-service",
						reasonCode: operation.code,
						stateDataJson: JSON.stringify({ reasonCode: operation.code }),
					});
					return {
						state: "failed",
						reasonCode: failed.ok ? operation.code : failed.code,
					};
				}
				const completionBase = {
					publisherDid,
					intentId: originalIntent.id,
					generation: operation.lease.generation,
					token: operation.lease.token,
					expectedIntentGeneration: operation.lease.expectedIntentGeneration,
				};
				const failBeforeWrite = async (
					reasonCode: string,
					retryable = false,
				): Promise<AttemptResult> => {
					const completed = await publisher.completePublicationOperation({
						...completionBase,
						completionDigest: await digest(["failed", reasonCode, attempt, expectedEvidenceDigest]),
						outcome: retryable ? "blocked" : "failed",
						reasonCode,
						resultUri: null,
						resultCid: null,
					});
					if (completed.ok) {
						return retryable ? { state: "blocked", reasonCode } : { state: "failed", reasonCode };
					}
					const latest = await publisher.getIntent(publisherDid, originalIntent.id);
					if (latest?.state === "published") return { state: "published", uri: "", cid: "" };
					if (latest?.state === "reconciling") return { state: "reconciling" };
					return { state: "failed", reasonCode: completed.code };
				};
				let writeStarted = false;
				try {
					const configuration = await loadConfiguration(env);
					const flow = {
						purpose: "release_delegation",
						expectedDid: publisherDid,
						redirectTarget: "/",
					} as const;
					const oauth = createPublisherOAuthClient({
						namespace: env.PUBLISHER_DO,
						encryption: configuration.encryption,
						oauth: configuration.oauth,
						flow,
					});
					const restored = await oauth.restoreForPublication();
					const consumed = await control.consumePublicationPermit({
						id: permit.permit.id,
						token: permit.permit.token,
						publisherDid,
						intentId: originalIntent.id,
					});
					if (!consumed.ok) {
						return failBeforeWrite(consumed.code, isRetryablePublicationBlock(consumed.code));
					}
					const delegation = await publisher.getDelegation(publisherDid);
					if (
						delegation?.status !== "active" ||
						delegation.stateVersion !== restored.delegationVersion
					) {
						return failBeforeWrite("OAUTH_DELEGATION_UNAVAILABLE");
					}
					writeStarted = true;
					const created = await createReleaseRecord(restored.session, {
						publisherDid,
						rkey: `${originalIntent.packageSlug}:${originalIntent.version}`,
						record: release,
					});
					const completionDigest = await digest(["published", created.uri, created.cid]);
					const completed = await publisher.completePublicationOperation({
						...completionBase,
						completionDigest,
						outcome: "published",
						resultUri: created.uri,
						resultCid: created.cid,
					});
					if (completed.ok) return { state: "published", uri: created.uri, cid: created.cid };
					const ambiguous = await publisher.completePublicationOperation({
						...completionBase,
						completionDigest: await digest(["ambiguous", attempt, expectedEvidenceDigest]),
						outcome: "ambiguous",
						resultUri: null,
						resultCid: null,
					});
					if (ambiguous.ok) return { state: "reconciling" };
					const latest = await publisher.getIntent(publisherDid, originalIntent.id);
					return latest?.state === "published"
						? { state: "published", uri: created.uri, cid: created.cid }
						: { state: "reconciling" };
				} catch (error) {
					const errorCode =
						error instanceof OAuthCustodyError || error instanceof CreateReleaseError
							? error.code
							: writeStarted
								? "PUBLICATION_AMBIGUOUS"
								: "PUBLICATION_PRECONDITION_FAILED";
					if (!writeStarted) return failBeforeWrite(errorCode);
					console.error(
						JSON.stringify({
							event: "publication_attempt_ambiguous",
							intentId: originalIntent.id,
							attempt,
							name: error instanceof Error ? error.name : "UnknownError",
							code: errorCode,
						}),
					);
					const ambiguous = await publisher.completePublicationOperation({
						...completionBase,
						completionDigest: await digest(["ambiguous", attempt, expectedEvidenceDigest]),
						outcome: "ambiguous",
						resultUri: null,
						resultCid: null,
					});
					if (ambiguous.ok) return { state: "reconciling" };
					const latest = await publisher.getIntent(publisherDid, originalIntent.id);
					return latest?.state === "published"
						? { state: "published", uri: "", cid: "" }
						: { state: "reconciling" };
				}
			},
		);
		if (attemptResult.state === "published") {
			return { intentId: originalIntent.id, state: "published", reasonCode: null };
		}
		if (attemptResult.state === "failed") {
			return { intentId: originalIntent.id, state: "failed", reasonCode: attemptResult.reasonCode };
		}
		if (attemptResult.state === "blocked") {
			return { intentId: originalIntent.id, state: "ready", reasonCode: attemptResult.reasonCode };
		}

		const reconciliation = await step.do<
			| { outcome: "absent" }
			| { outcome: "exact"; uri: string; cid: string }
			| { outcome: "conflict" }
		>(`reconcile-${attempt}`, RECONCILIATION_STEP_CONFIG, async () => {
			const authoritative = await findAuthoritativeRelease(
				publisherDid,
				originalIntent.packageSlug,
				originalIntent.version,
			);
			return reconcileReleaseRecord(
				publisherDid,
				originalIntent.packageSlug,
				originalIntent.version,
				release,
				authoritative,
			);
		});
		const current = await step.do(`reconciliation-state-${attempt}`, () =>
			currentState(publisher, publisherDid, originalIntent.id),
		);
		if (current?.state === "published") {
			return { intentId: originalIntent.id, state: "published", reasonCode: null };
		}
		if (current?.state === "conflict") {
			return { intentId: originalIntent.id, state: "conflict", reasonCode: "RELEASE_CONFLICT" };
		}
		if (!current || current.state !== "reconciling") {
			return {
				intentId: originalIntent.id,
				state: "failed",
				reasonCode: "RECONCILIATION_STATE_INVALID",
			};
		}
		if (reconciliation.outcome === "exact") {
			const published = await step.do<TransitionSummary>(`reconcile-published-${attempt}`, () =>
				transition(publisher, {
					publisherDid,
					intentId: originalIntent.id,
					expectedState: "reconciling",
					expectedGeneration: current.stateGeneration,
					toState: "published",
					transitionDigest: expectedEvidenceDigest,
					actorRealm: "system",
					actorIdentity: "release-service",
					reasonCode: null,
					stateDataJson: JSON.stringify({
						resultUri: reconciliation.uri,
						resultCid: reconciliation.cid,
					}),
				}),
			);
			return published.ok
				? { intentId: originalIntent.id, state: "published", reasonCode: null }
				: { intentId: originalIntent.id, state: "failed", reasonCode: published.code };
		}
		if (reconciliation.outcome === "conflict") {
			const conflict = await step.do<TransitionSummary>(`reconcile-conflict-${attempt}`, () =>
				transition(publisher, {
					publisherDid,
					intentId: originalIntent.id,
					expectedState: "reconciling",
					expectedGeneration: current.stateGeneration,
					toState: "conflict",
					transitionDigest: expectedEvidenceDigest,
					actorRealm: "system",
					actorIdentity: "release-service",
					reasonCode: "RELEASE_CONFLICT",
					stateDataJson: JSON.stringify({ reasonCode: "RELEASE_CONFLICT" }),
				}),
			);
			return conflict.ok
				? { intentId: originalIntent.id, state: "conflict", reasonCode: "RELEASE_CONFLICT" }
				: { intentId: originalIntent.id, state: "failed", reasonCode: conflict.code };
		}
		if (attempt < MAX_PUBLICATION_ATTEMPTS) {
			const retry = await step.do<TransitionSummary>(`reconcile-absence-${attempt}`, async () =>
				transition(publisher, {
					publisherDid,
					intentId: originalIntent.id,
					expectedState: "reconciling",
					expectedGeneration: current.stateGeneration,
					toState: "ready",
					transitionDigest: await digest(["retry", attempt, expectedEvidenceDigest]),
					actorRealm: "system",
					actorIdentity: "release-service",
					reasonCode: "PDS_RETRY_ABSENT",
					stateDataJson: JSON.stringify({ attempt, absenceConfirmed: true }),
				}),
			);
			if (!retry.ok)
				return { intentId: originalIntent.id, state: "failed", reasonCode: retry.code };
			continue;
		}
		const failed = await step.do<TransitionSummary>("reconciliation-exhausted", () =>
			transition(publisher, {
				publisherDid,
				intentId: originalIntent.id,
				expectedState: "reconciling",
				expectedGeneration: current.stateGeneration,
				toState: "failed",
				transitionDigest: expectedEvidenceDigest,
				actorRealm: "system",
				actorIdentity: "release-service",
				reasonCode: "PDS_RETRY_EXHAUSTED",
				stateDataJson: JSON.stringify({ reasonCode: "PDS_RETRY_EXHAUSTED" }),
			}),
		);
		return failed.ok
			? { intentId: originalIntent.id, state: "failed", reasonCode: "PDS_RETRY_EXHAUSTED" }
			: { intentId: originalIntent.id, state: "failed", reasonCode: failed.code };
	}

	return { intentId: originalIntent.id, state: "failed", reasonCode: "PDS_RETRY_EXHAUSTED" };
}
