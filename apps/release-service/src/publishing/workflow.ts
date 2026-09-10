import { isDid } from "@atcute/lexicons/syntax";
import {
	parseDelegatedReleaseSourceRecord,
	type DelegatedReleaseSourceRecord,
} from "@emdash-cms/registry-client/release-service";
import { NSID, type PackageRelease } from "@emdash-cms/registry-lexicons";
import type { WorkflowStep } from "cloudflare:workers";
import { NonRetryableError } from "cloudflare:workflows";
import { base64url } from "jose";

import type ReleaseVerifier from "../../../release-verifier/src/index.js";
import { computeApprovalEvidenceDigest, type ApprovalEvidence } from "../approvals/digest.js";
import { loadConfiguration } from "../config.js";
import {
	SERVICE_CONTROL_OBJECT_NAME,
	type ServiceControlDurableObject,
} from "../control-do/service-control-do.js";
import { createPublisherOAuthClient, OAuthCustodyError } from "../oauth/custody.js";
import { writeOperationsMetric } from "../observability/metrics.js";
import type {
	IntentState,
	PublicationArtifactSlot,
	PublicationCoordinationLease,
	PublicationOperationLease,
	PublisherDurableObject,
	StoredIntent,
	StoredPublicationMaterialization,
} from "../publisher-do/publisher-do.js";
import {
	evaluateWorkloadAttestation,
	evaluateVerifiedRelease,
	normalizeVerifierReport,
	parseNormalizedVerifierReport,
	prepareVerifierInput,
} from "../verification/evaluate.js";
import {
	findProofVerifiedRelease,
	publisherSnapshotErrorCode,
	readPublisherVerificationSnapshot,
	resolvePublicHostname,
	resolvePublisherPds,
	samePdsOrigin,
} from "../verification/pds.js";
import { verifyReleaseEvidence } from "../verification/staged-input.js";
import { createReleaseRecord, uploadReleaseBlob } from "./create-only.js";
import {
	buildMaterializedRelease,
	stageReleaseArtifacts,
	validateArtifactUploadReceipt,
	type ArtifactMaterializationPath,
	type ArtifactUploadReceipt,
	type StagedArtifactMetadata,
} from "./materialize.js";
import {
	canonicalReleaseJson,
	parseCanonicalReleaseJson,
	reconcileReleaseRecord,
} from "./reconcile.js";
import { deleteStagedArtifacts, loadStagedArtifact, persistStagedArtifact } from "./staging.js";
import {
	deleteWorkloadStagedArtifacts,
	loadWorkloadStagedArtifact,
	promoteWorkloadProvenance,
	workloadArtifactSourceUrl,
	type WorkloadArtifactIdentity,
} from "./workload-staging.js";

const PUBLICATION_PERMIT_TTL_MS = 30_000;
const PUBLICATION_COORDINATION_LEASE_MS = 5 * 60_000;
const PUBLICATION_OPERATION_LEASE_MS = 5 * 60_000;
const MAX_PUBLICATION_ATTEMPTS = 3;
const MAX_COORDINATION_WAITS = 3;
const FINAL_VERIFICATION_STEP_CONFIG = {
	retries: { limit: 3, delay: "1 second", backoff: "exponential" },
	timeout: "2 minutes",
} as const;
const RECONCILIATION_STEP_CONFIG = {
	retries: { limit: 3, delay: "1 second", backoff: "exponential" },
	timeout: "2 minutes",
} as const;
const MATERIALIZATION_STEP_CONFIG = {
	retries: { limit: 3, delay: "1 second", backoff: "exponential" },
	timeout: "5 minutes",
} as const;
const UPLOAD_STEP_CONFIG = {
	retries: { limit: 5, delay: "1 second", backoff: "exponential" },
	timeout: "2 minutes",
} as const;
const ERROR_CODE_PATTERN = /^[A-Z][A-Z0-9_]{0,63}$/;
const NON_RETRYABLE_ERROR_PREFIX = /^NonRetryableError:\s*/;
const SCREENSHOT_PATH_PATTERN = /^screenshots\[([0-7])\]$/;
const STEP_SLOT_PATTERN = /[[\]]/g;

export interface PublicationWorkflowOutput {
	intentId: string;
	state: "conflict" | "expired" | "failed" | "invalid" | "published" | "ready";
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
	| { state: "expired" }
	| { state: "blocked"; reasonCode: string }
	| { state: "failed"; reasonCode: string };

interface AttemptCredential {
	attemptKey: string;
	token: string;
}

interface MaterializationStageResult {
	planJson: string | null;
}

type OperationBeginSummary =
	| { ok: true; lease: PublicationOperationLease; replayed: boolean }
	| { ok: false; code: string };

type CoordinationAcquireSummary =
	| { ok: true; lease: PublicationCoordinationLease }
	| { ok: false; code: "PUBLICATION_COORDINATION_BUSY"; retryAt: number };

type OperationPhaseSummary =
	| { ok: true; phase: "creating" | "materialized"; materializationDigest: string }
	| { ok: false; code: string };

interface MaterializedRelease {
	record: PackageRelease.Main;
	recordDigest: string;
	recordJson: string;
}

interface MaterializedSummary {
	recordDigest: string;
}

type FinalVerificationResult =
	| {
			ok: true;
			verificationDigest: string;
			verifierJson: string;
	  }
	| { ok: false; reasonCode: string; terminalState: "conflict" | "invalid" };

function isRetryablePublicationBlock(code: string): boolean {
	return (
		code === "ENCRYPTION_KEY_INACTIVE" ||
		code === "PERMIT_EXPIRED" ||
		code === "PERMIT_STALE" ||
		code === "PUBLICATION_PAUSED" ||
		code === "PUBLISHER_SUSPENDED"
	);
}

function publicationErrorCode(error: unknown, fallback: string): string {
	if (error instanceof OAuthCustodyError) return error.code;
	if (error instanceof Error) {
		const message = error.message.replace(NON_RETRYABLE_ERROR_PREFIX, "");
		if (ERROR_CODE_PATTERN.test(message)) return message;
	}
	if (
		error !== null &&
		typeof error === "object" &&
		"code" in error &&
		typeof error.code === "string" &&
		ERROR_CODE_PATTERN.test(error.code)
	) {
		return error.code;
	}
	return fallback;
}

async function digest(value: unknown): Promise<string> {
	return base64url.encode(
		new Uint8Array(
			await crypto.subtle.digest("SHA-256", new TextEncoder().encode(JSON.stringify(value))),
		),
	);
}

async function digestText(value: string): Promise<string> {
	return base64url.encode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
	);
}

function randomCredential(): AttemptCredential {
	return {
		attemptKey: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
		token: base64url.encode(crypto.getRandomValues(new Uint8Array(32))),
	};
}

export async function acquirePublicationCoordination(
	step: WorkflowStep,
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	intent: StoredIntent,
	attempt: number | "recovery",
): Promise<PublicationCoordinationLease | null> {
	const credential = await step.do<AttemptCredential>(
		`publication-coordination-credential-${attempt}`,
		async () => randomCredential(),
	);
	for (let wait = 1; wait <= MAX_COORDINATION_WAITS; wait += 1) {
		const result = await step.do<CoordinationAcquireSummary>(
			`publication-coordinate-${attempt}-${wait}`,
			async () => {
				const acquired = await publisher.acquirePublicationCoordination(
					publisherDid,
					intent.packageSlug,
					intent.id,
					PUBLICATION_COORDINATION_LEASE_MS,
					credential.token,
				);
				return acquired.ok
					? { ok: true, lease: acquired.lease }
					: { ok: false, code: acquired.code, retryAt: acquired.retryAt };
			},
		);
		if (result.ok) return result.lease;
		await step.sleepUntil(
			`publication-coordinate-wait-${attempt}-${wait}`,
			Math.max(Date.now() + 1, result.retryAt),
		);
	}
	return null;
}

export async function releasePublicationCoordination(
	step: WorkflowStep,
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	lease: PublicationCoordinationLease,
	stepName: string,
): Promise<void> {
	await step.do(stepName, async () => {
		await publisher.releasePublicationCoordination({
			publisherDid,
			packageSlug: lease.packageSlug,
			intentId: lease.intentId,
			generation: lease.generation,
			token: lease.token,
		});
		return true;
	});
}

export function releaseFromIntent(intent: StoredIntent): DelegatedReleaseSourceRecord | null {
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
	return parseDelegatedReleaseSourceRecord(parsed.release, {
		packageSlug: intent.packageSlug,
		version: intent.version,
	});
}

function sourceDescriptor(
	release: DelegatedReleaseSourceRecord,
	path: ArtifactMaterializationPath,
) {
	if (path === "package") return release.artifacts.package;
	if (path === "icon") return release.artifacts.icon ?? null;
	if (path === "banner") return release.artifacts.banner ?? null;
	const match = SCREENSHOT_PATH_PATTERN.exec(path);
	if (!match) return null;
	return release.artifacts.screenshots?.[Number(match[1])] ?? null;
}

function releaseArtifactPaths(
	release: DelegatedReleaseSourceRecord,
): ArtifactMaterializationPath[] {
	const paths: ArtifactMaterializationPath[] = ["package"];
	if (release.artifacts.icon) paths.push("icon");
	if (release.artifacts.banner) paths.push("banner");
	for (const [index] of (release.artifacts.screenshots ?? []).entries()) {
		paths.push(`screenshots[${index}]`);
	}
	return paths;
}

function workloadStagedSources(
	publicOrigin: string,
	publisherDid: string,
	intent: StoredIntent,
	release: DelegatedReleaseSourceRecord,
): WorkloadArtifactIdentity[] {
	const sources: WorkloadArtifactIdentity[] = releaseArtifactPaths(release).flatMap((slot) => {
		const descriptor = sourceDescriptor(release, slot);
		if (
			!descriptor ||
			descriptor.url !== workloadArtifactSourceUrl(publicOrigin, slot, descriptor.checksum)
		) {
			return [];
		}
		return [
			{
				publisherDid,
				workloadDigest: intent.workloadIdempotencyDigest,
				packageSlug: intent.packageSlug,
				version: intent.version,
				slot,
				checksum: descriptor.checksum,
			},
		];
	});
	const provenance = release.extensions[NSID.packageReleaseExtension].provenance;
	if (
		provenance.url === workloadArtifactSourceUrl(publicOrigin, "provenance", provenance.checksum)
	) {
		sources.push({
			publisherDid,
			workloadDigest: intent.workloadIdempotencyDigest,
			packageSlug: intent.packageSlug,
			version: intent.version,
			slot: "provenance",
			checksum: provenance.checksum,
		});
	}
	return sources;
}

function isPublicationSlot(path: string): path is PublicationArtifactSlot {
	return (
		path === "package" ||
		path === "icon" ||
		path === "banner" ||
		path === "screenshots[0]" ||
		path === "screenshots[1]" ||
		path === "screenshots[2]" ||
		path === "screenshots[3]" ||
		path === "screenshots[4]" ||
		path === "screenshots[5]" ||
		path === "screenshots[6]" ||
		path === "screenshots[7]"
	);
}

function publicationSlot(path: ArtifactMaterializationPath): PublicationArtifactSlot | null {
	return isPublicationSlot(path) ? path : null;
}

function stagedMetadata(
	artifact: StoredPublicationMaterialization["slots"][number],
): StagedArtifactMetadata {
	return {
		path: artifact.slot,
		checksum: artifact.checksum,
		mimeType: artifact.mimeType,
		size: artifact.size,
		...(artifact.width === null ? {} : { width: artifact.width }),
		...(artifact.height === null ? {} : { height: artifact.height }),
	};
}

function receiptFromStored(
	artifact: StoredPublicationMaterialization["slots"][number],
): ArtifactUploadReceipt | null {
	if (!artifact.blob) return null;
	return validateArtifactUploadReceipt(stagedMetadata(artifact), artifact.blob);
}

export async function readPersistedMaterializedRelease(
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	intentId: string,
	expectedSourceDigest: string,
): Promise<MaterializedRelease | null> {
	const stored = await publisher.getPublicationMaterialization(publisherDid, intentId);
	if (
		stored?.status !== "complete" ||
		stored.sourceDigest !== expectedSourceDigest ||
		stored.recordJson === null ||
		stored.recordDigest === null ||
		(await digestText(stored.recordJson)) !== stored.recordDigest
	) {
		return null;
	}
	const record = parseCanonicalReleaseJson(stored.recordJson);
	return record
		? { record, recordDigest: stored.recordDigest, recordJson: stored.recordJson }
		: null;
}

async function restorePublicationSession(env: PublicationWorkflowEnv, publisherDid: string) {
	if (!isDid(publisherDid)) throw new OAuthCustodyError("OAUTH_IDENTITY_MISMATCH");
	const configuration = await loadConfiguration(env);
	return createPublisherOAuthClient({
		namespace: env.PUBLISHER_DO,
		encryption: configuration.encryption,
		oauth: configuration.oauth,
		flow: {
			purpose: "release_delegation",
			expectedDid: publisherDid,
			redirectTarget: "/",
		},
	}).restoreForPublication();
}

async function requireCurrentPublicationAudience(
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	restored: Awaited<ReturnType<typeof restorePublicationSession>>,
): Promise<void> {
	const token = await restored.session.getTokenInfo(false);
	const currentPds = await resolvePublisherPds(publisherDid);
	if (samePdsOrigin(token.aud, currentPds)) return;
	await publisher.requireDelegationReauthorization(
		publisherDid,
		restored.delegationVersion,
		"OAUTH_SESSION_INVALID",
	);
	throw new NonRetryableError("OAUTH_DELEGATION_UNAVAILABLE");
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

async function stageSourceArtifacts(
	env: PublicationWorkflowEnv,
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	intent: StoredIntent,
	release: DelegatedReleaseSourceRecord,
): Promise<MaterializationStageResult> {
	const existing = await readPersistedMaterializedRelease(
		publisher,
		publisherDid,
		intent.id,
		intent.requestDigest,
	);
	if (existing) return { planJson: null };
	const begun = await publisher.beginPublicationMaterialization(
		publisherDid,
		intent.id,
		intent.requestDigest,
	);
	if (!begun.ok) throw new Error(begun.code);
	const staged = await stageReleaseArtifacts(release, {
		fetch: globalThis.fetch,
		resolveHostname: (hostname) => resolvePublicHostname(hostname, globalThis.fetch),
		loadSource: async ({ path, url, checksum }) => {
			if (url !== workloadArtifactSourceUrl(env.PUBLIC_ORIGIN, path, checksum)) return null;
			const loaded = await loadWorkloadStagedArtifact(env.PUBLICATION_STAGING, {
				publisherDid,
				workloadDigest: intent.workloadIdempotencyDigest,
				packageSlug: intent.packageSlug,
				version: intent.version,
				slot: path,
				checksum,
			});
			return { bytes: loaded.bytes, contentType: loaded.contentType };
		},
	});
	for (const artifact of staged.artifacts) {
		const descriptor = sourceDescriptor(release, artifact.metadata.path);
		const slot = publicationSlot(artifact.metadata.path);
		if (!descriptor || !slot) throw new Error("MATERIALIZATION_SOURCE_INVALID");
		const persisted = await persistStagedArtifact(env.PUBLICATION_STAGING, {
			publisherDid,
			intentId: intent.id,
			sourceUrl: descriptor.url,
			artifact,
		});
		const stored = await publisher.putPublicationArtifactStage({
			publisherDid,
			intentId: intent.id,
			sourceDigest: intent.requestDigest,
			slot,
			sourceUrlDigest: persisted.sourceUrlDigest,
			checksum: artifact.metadata.checksum,
			stagingKey: persisted.key,
			mimeType: artifact.metadata.mimeType,
			size: artifact.metadata.size,
			width: artifact.metadata.width ?? null,
			height: artifact.metadata.height ?? null,
		});
		if (!stored.ok) throw new Error(stored.code);
	}
	return { planJson: JSON.stringify(staged.plan) };
}

async function uploadMaterializedArtifacts(
	env: PublicationWorkflowEnv,
	step: WorkflowStep,
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	intent: StoredIntent,
): Promise<readonly ArtifactUploadReceipt[]> {
	const materialization = await publisher.getPublicationMaterialization(publisherDid, intent.id);
	if (!materialization || materialization.sourceDigest !== intent.requestDigest) {
		throw new Error("MATERIALIZATION_UNAVAILABLE");
	}
	const receipts: ArtifactUploadReceipt[] = [];
	for (const artifact of materialization.slots) {
		const existing = receiptFromStored(artifact);
		if (existing) {
			receipts.push(existing);
			continue;
		}
		const receipt = await step.do<ArtifactUploadReceipt>(
			`publication-upload-${artifact.slot.replaceAll(STEP_SLOT_PATTERN, "-")}`,
			UPLOAD_STEP_CONFIG,
			async () => {
				const latest = await publisher.getPublicationMaterialization(publisherDid, intent.id);
				const latestArtifact = latest?.slots.find((item) => item.slot === artifact.slot);
				if (!latestArtifact || latest?.sourceDigest !== intent.requestDigest) {
					throw new Error("MATERIALIZATION_UNAVAILABLE");
				}
				const replayed = receiptFromStored(latestArtifact);
				if (replayed) return replayed;
				const staged = await loadStagedArtifact(env.PUBLICATION_STAGING, {
					key: latestArtifact.stagingKey,
					metadata: stagedMetadata(latestArtifact),
					sourceUrlDigest: latestArtifact.sourceUrlDigest,
				});
				let restored;
				try {
					restored = await restorePublicationSession(env, publisherDid);
				} catch (error) {
					throw new NonRetryableError(publicationErrorCode(error, "OAUTH_DELEGATION_UNAVAILABLE"));
				}
				const delegation = await publisher.getDelegation(publisherDid);
				if (
					delegation?.status !== "active" ||
					delegation.stateVersion !== restored.delegationVersion
				) {
					throw new OAuthCustodyError("OAUTH_DELEGATION_UNAVAILABLE");
				}
				await requireCurrentPublicationAudience(publisher, publisherDid, restored);
				const uploaded = await uploadReleaseBlob(
					restored.session,
					staged.bytes,
					staged.metadata.mimeType,
				);
				const validated = validateArtifactUploadReceipt(staged.metadata, uploaded);
				const stored = await publisher.putPublicationBlobReceipt({
					publisherDid,
					intentId: intent.id,
					sourceDigest: intent.requestDigest,
					slot: artifact.slot,
					blob: validated.blob,
				});
				if (!stored.ok) throw new Error(stored.code);
				return validated;
			},
		);
		receipts.push(receipt);
	}
	return receipts;
}

async function completeMaterialization(
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	intent: StoredIntent,
	planJson: string | null,
): Promise<MaterializedRelease> {
	const existing = await readPersistedMaterializedRelease(
		publisher,
		publisherDid,
		intent.id,
		intent.requestDigest,
	);
	if (existing) return existing;
	if (!planJson) throw new Error("MATERIALIZATION_UNAVAILABLE");
	const stored = await publisher.getPublicationMaterialization(publisherDid, intent.id);
	if (!stored || stored.sourceDigest !== intent.requestDigest) {
		throw new Error("MATERIALIZATION_UNAVAILABLE");
	}
	const receipts = stored.slots.map(receiptFromStored);
	if (receipts.some((receipt) => receipt === null)) {
		throw new Error("MATERIALIZATION_INCOMPLETE");
	}
	const completeReceipts = receipts.filter(
		(receipt): receipt is ArtifactUploadReceipt => receipt !== null,
	);
	let plan: unknown;
	try {
		plan = JSON.parse(planJson);
	} catch {
		throw new Error("MATERIALIZATION_UNAVAILABLE");
	}
	const record = buildMaterializedRelease(plan, completeReceipts);
	const recordJson = canonicalReleaseJson(record);
	const recordDigest = await digestText(recordJson);
	const completed = await publisher.completePublicationMaterialization({
		publisherDid,
		intentId: intent.id,
		sourceDigest: intent.requestDigest,
		recordJson,
		recordDigest,
	});
	if (!completed.ok) throw new Error(completed.code);
	const persisted = await readPersistedMaterializedRelease(
		publisher,
		publisherDid,
		intent.id,
		intent.requestDigest,
	);
	if (!persisted) throw new Error("MATERIALIZATION_UNAVAILABLE");
	return persisted;
}

async function closeBeforeCreate(
	publisher: DurableObjectStub<PublisherDurableObject>,
	publisherDid: string,
	intentId: string,
	lease: PublicationOperationLease,
	attempt: number,
	reasonCode: string,
	retryable: boolean,
): Promise<AttemptResult> {
	const completed = await publisher.completePublicationOperation({
		publisherDid,
		intentId,
		generation: lease.generation,
		token: lease.token,
		expectedIntentGeneration: lease.expectedIntentGeneration,
		completionDigest: await digest(["pre-create", attempt, reasonCode]),
		outcome: retryable ? "blocked" : "failed",
		reasonCode,
		resultUri: null,
		resultCid: null,
	});
	if (completed.ok) {
		return retryable ? { state: "blocked", reasonCode } : { state: "failed", reasonCode };
	}
	const latest = await publisher.getIntent(publisherDid, intentId);
	if (latest?.state === "published") return { state: "published", uri: "", cid: "" };
	if (latest?.state === "reconciling") return { state: "reconciling" };
	if (latest?.state === "ready") {
		return { state: "blocked", reasonCode: "PUBLICATION_RETRY_REQUIRED" };
	}
	return { state: "failed", reasonCode: completed.code };
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
		const coordination = await acquirePublicationCoordination(
			step,
			publisher,
			publisherDid,
			originalIntent,
			attempt,
		);
		if (!coordination) {
			return {
				intentId: originalIntent.id,
				state: "ready",
				reasonCode: "PUBLICATION_COORDINATION_BUSY",
			};
		}
		let finalVerification: FinalVerificationResult;
		try {
			finalVerification = await step.do<FinalVerificationResult>(
				`final-verification-${attempt}`,
				FINAL_VERIFICATION_STEP_CONFIG,
				async () => {
					const snapshot = await readPublisherVerificationSnapshot(
						publisherDid,
						originalIntent.packageSlug,
						originalIntent.version,
					);
					const verifierInput = prepareVerifierInput(originalIntent, snapshot);
					if (!verifierInput) {
						return { ok: false, reasonCode: "FINAL_INPUT_INVALID", terminalState: "invalid" };
					}
					const verifier = normalizeVerifierReport(
						await verifyReleaseEvidence({ ...originalIntent, publisherDid }, verifierInput, {
							bucket: env.PUBLICATION_STAGING,
							publicOrigin: env.PUBLIC_ORIGIN,
							verifier: env.RELEASE_VERIFIER,
						}),
					);
					if (!verifier.success) {
						return { ok: false, reasonCode: verifier.error.code, terminalState: "invalid" };
					}
					const evaluation = await evaluateVerifiedRelease(
						publisherDid,
						originalIntent,
						snapshot,
						await publisher.getWorkloadPolicy(publisherDid, originalIntent.packageSlug),
						verifier,
					);
					if (!evaluation.success) {
						return { ok: false, reasonCode: evaluation.reasonCode, terminalState: "invalid" };
					}
					if (
						(await computeApprovalEvidenceDigest(evaluation.value.approvalEvidence)) !==
						expectedEvidenceDigest
					) {
						return {
							ok: false,
							reasonCode: "FINAL_VERIFICATION_CHANGED",
							terminalState: "invalid",
						};
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
								verifierJson: JSON.stringify(verifier),
							}
						: { ok: false, reasonCode: stored.code, terminalState: "invalid" };
				},
			);
		} catch (error) {
			const code = publisherSnapshotErrorCode(error);
			if (!code) throw error;
			finalVerification = {
				ok: false,
				reasonCode: code,
				terminalState: code === "RELEASE_EXISTS" ? "conflict" : "invalid",
			};
		}
		if (!finalVerification.ok) {
			await releasePublicationCoordination(
				step,
				publisher,
				publisherDid,
				coordination,
				`publication-coordinate-final-release-${attempt}`,
			);
			const current = await step.do(`final-invalid-state-${attempt}`, () =>
				currentState(publisher, publisherDid, originalIntent.id),
			);
			if (current?.state === finalVerification.terminalState) {
				return {
					intentId: originalIntent.id,
					state: finalVerification.terminalState,
					reasonCode: finalVerification.reasonCode,
				};
			}
			if (current?.state === "expired") {
				return {
					intentId: originalIntent.id,
					state: "expired",
					reasonCode: "INTENT_EXPIRED",
				};
			}
			if (current?.state !== "ready") {
				return {
					intentId: originalIntent.id,
					state: "failed",
					reasonCode: "INTENT_STATE_INVALID",
				};
			}
			const terminal = await step.do<TransitionSummary>(
				`mark-final-${finalVerification.terminalState}-${attempt}`,
				() =>
					transition(publisher, {
						publisherDid,
						intentId: originalIntent.id,
						expectedState: "ready",
						expectedGeneration: current.stateGeneration,
						toState: finalVerification.terminalState,
						transitionDigest: expectedEvidenceDigest,
						actorRealm: "system",
						actorIdentity: "release-service",
						reasonCode: finalVerification.reasonCode,
						stateDataJson: JSON.stringify({ reasonCode: finalVerification.reasonCode }),
					}),
			);
			if (!terminal.ok) {
				return { intentId: originalIntent.id, state: "failed", reasonCode: terminal.code };
			}
			return {
				intentId: originalIntent.id,
				state: finalVerification.terminalState,
				reasonCode: finalVerification.reasonCode,
			};
		}

		const attemptResult = await (async (): Promise<AttemptResult> => {
			const current = await publisher.getIntent(publisherDid, originalIntent.id);
			if (current?.state === "published") {
				return { state: "published", uri: "", cid: "" };
			}
			if (current?.state === "expired") return { state: "expired" };
			if (current?.state === "reconciling") return { state: "reconciling" };
			if (!current || (current.state !== "ready" && current.state !== "publishing")) {
				return { state: "failed", reasonCode: "INTENT_NOT_READY" };
			}
			if (current.state === "ready" && current.expiresAt <= Date.now()) {
				const expired = await transition(publisher, {
					publisherDid,
					intentId: originalIntent.id,
					expectedState: "ready",
					expectedGeneration: current.stateGeneration,
					toState: "expired",
					transitionDigest: await digest(["expired", originalIntent.id, current.expiresAt]),
					actorRealm: "system",
					actorIdentity: "release-service",
					reasonCode: "INTENT_EXPIRED",
					stateDataJson: JSON.stringify({ reasonCode: "INTENT_EXPIRED" }),
				});
				if (expired.ok) return { state: "expired" };
				const latest = await publisher.getIntent(publisherDid, originalIntent.id);
				return latest?.state === "expired"
					? { state: "expired" }
					: { state: "failed", reasonCode: expired.code };
			}
			const staged = await step.do<MaterializationStageResult>(
				"publication-stage",
				MATERIALIZATION_STEP_CONFIG,
				() => stageSourceArtifacts(env, publisher, publisherDid, originalIntent, release),
			);
			const credential = await step.do<AttemptCredential>(
				`publication-attempt-credential-${attempt}`,
				async () => randomCredential(),
			);
			let publishingGeneration = current.stateGeneration;
			if (current.state === "ready") {
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
				publishingGeneration = publishing.stateGeneration;
			}
			const operation = await step.do<OperationBeginSummary>(
				`publication-begin-${attempt}`,
				async () => {
					const result = await publisher.beginPublicationOperation(
						publisherDid,
						originalIntent.id,
						publishingGeneration,
						PUBLICATION_OPERATION_LEASE_MS,
						credential.attemptKey,
						credential.token,
					);
					if (
						!result.ok &&
						(result.code === "PUBLICATION_BUSY" || result.code === "PUBLICATION_RECOVERY_REQUIRED")
					) {
						throw new Error(result.code);
					}
					return result.ok
						? {
								ok: true,
								lease: {
									intentId: result.lease.intentId,
									generation: result.lease.generation,
									token: result.lease.token,
									expectedIntentGeneration: result.lease.expectedIntentGeneration,
									expiresAt: result.lease.expiresAt,
								},
								replayed: result.replayed,
							}
						: { ok: false, code: result.code };
				},
			);
			if (!operation.ok) {
				const failed = await transition(publisher, {
					publisherDid,
					intentId: originalIntent.id,
					expectedState: "publishing",
					expectedGeneration: publishingGeneration,
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
			): Promise<AttemptResult> =>
				closeBeforeCreate(
					publisher,
					publisherDid,
					originalIntent.id,
					operation.lease,
					attempt,
					reasonCode,
					retryable,
				);
			let materializedDigest: string | null = null;
			try {
				await uploadMaterializedArtifacts(env, step, publisher, publisherDid, originalIntent);
				await step.do("publication-provenance-promote", async () => {
					const provenance = release.extensions[NSID.packageReleaseExtension].provenance;
					if (
						provenance.url !==
						workloadArtifactSourceUrl(env.PUBLIC_ORIGIN, "provenance", provenance.checksum)
					) {
						return false;
					}
					await promoteWorkloadProvenance(env.PUBLICATION_STAGING, env.PROVENANCE_STORE, {
						publisherDid,
						workloadDigest: originalIntent.workloadIdempotencyDigest,
						packageSlug: originalIntent.packageSlug,
						version: originalIntent.version,
						checksum: provenance.checksum,
					});
					return true;
				});
				const materialized = await step.do<MaterializedSummary>(
					"publication-complete-materialization",
					async () => {
						const completed = await completeMaterialization(
							publisher,
							publisherDid,
							originalIntent,
							staged.planJson,
						);
						return {
							recordDigest: completed.recordDigest,
						};
					},
				);
				materializedDigest = materialized.recordDigest;
				const materializedPhase = await step.do<OperationPhaseSummary>(
					`publication-materialized-${attempt}`,
					async () => {
						const result = await publisher.advancePublicationOperationPhase({
							...completionBase,
							phase: "materialized",
							materializationDigest: materialized.recordDigest,
						});
						return result.ok
							? {
									ok: true,
									phase: result.phase,
									materializationDigest: result.materializationDigest,
								}
							: { ok: false, code: result.code };
					},
				);
				if (!materializedPhase.ok) return failBeforeWrite(materializedPhase.code);
				await step.do("publication-staging-cleanup", async () => {
					const stored = await publisher.getPublicationMaterialization(
						publisherDid,
						originalIntent.id,
					);
					if (stored?.status !== "complete") return false;
					try {
						await Promise.all([
							deleteStagedArtifacts(
								env.PUBLICATION_STAGING,
								stored.slots.map((artifact) => ({
									key: artifact.stagingKey,
									metadata: stagedMetadata(artifact),
									sourceUrlDigest: artifact.sourceUrlDigest,
								})),
							),
							deleteWorkloadStagedArtifacts(
								env.PUBLICATION_STAGING,
								workloadStagedSources(env.PUBLIC_ORIGIN, publisherDid, originalIntent, release),
							),
						]);
						return true;
					} catch (error) {
						console.error(
							JSON.stringify({
								event: "publication_staging_cleanup_failed",
								intentId: originalIntent.id,
								name: error instanceof Error ? error.name : "UnknownError",
							}),
						);
						return false;
					}
				});
			} catch (error) {
				return failBeforeWrite(publicationErrorCode(error, "PUBLICATION_PRECONDITION_FAILED"));
			}
			if (materializedDigest === null) {
				return failBeforeWrite("MATERIALIZATION_UNAVAILABLE");
			}
			return await step.do<AttemptResult>(`publication-create-${attempt}`, async () => {
				let writeStarted = false;
				try {
					const serviceConfiguration = await loadConfiguration(env);
					const restored = await restorePublicationSession(env, publisherDid);
					const delegation = await publisher.getDelegation(publisherDid);
					if (
						delegation?.status !== "active" ||
						delegation.stateVersion !== restored.delegationVersion
					) {
						return failBeforeWrite("OAUTH_DELEGATION_UNAVAILABLE");
					}
					const snapshot = await readPublisherVerificationSnapshot(
						publisherDid,
						originalIntent.packageSlug,
						originalIntent.version,
					);
					const verifier = parseNormalizedVerifierReport(finalVerification.verifierJson);
					if (!verifier?.success) return failBeforeWrite("FINAL_INPUT_INVALID");
					const evaluation = await evaluateVerifiedRelease(
						publisherDid,
						originalIntent,
						snapshot,
						await publisher.getWorkloadPolicy(publisherDid, originalIntent.packageSlug),
						verifier,
					);
					if (
						!evaluation.success ||
						(await computeApprovalEvidenceDigest(evaluation.value.approvalEvidence)) !==
							expectedEvidenceDigest
					) {
						return failBeforeWrite(
							evaluation.success ? "FINAL_VERIFICATION_CHANGED" : evaluation.reasonCode,
						);
					}
					const renewed = await publisher.renewPublicationCoordination({
						publisherDid,
						packageSlug: coordination.packageSlug,
						intentId: coordination.intentId,
						generation: coordination.generation,
						token: coordination.token,
						leaseMs: PUBLICATION_COORDINATION_LEASE_MS,
					});
					if (!renewed.ok) return failBeforeWrite(renewed.code, true);
					const permit = await control.issuePublicationPermit({
						publisherDid,
						intentId: originalIntent.id,
						packageSlug: originalIntent.packageSlug,
						profileCid: snapshot.profile.cid,
						baselineCid: snapshot.baseline?.cid ?? null,
						ttlMs: PUBLICATION_PERMIT_TTL_MS,
						encryptionKeyVersion: serviceConfiguration.encryption.currentKeyVersion,
					});
					if (!permit.ok) {
						return failBeforeWrite(permit.code, isRetryablePublicationBlock(permit.code));
					}
					const consumed = await control.consumePublicationPermit({
						id: permit.permit.id,
						token: permit.permit.token,
						publisherDid,
						intentId: originalIntent.id,
						packageSlug: originalIntent.packageSlug,
						profileCid: snapshot.profile.cid,
						baselineCid: snapshot.baseline?.cid ?? null,
					});
					if (!consumed.ok) {
						return failBeforeWrite(consumed.code, isRetryablePublicationBlock(consumed.code));
					}
					const recheckedDelegation = await publisher.getDelegation(publisherDid);
					if (
						recheckedDelegation?.status !== "active" ||
						recheckedDelegation.stateVersion !== restored.delegationVersion
					) {
						return failBeforeWrite("OAUTH_DELEGATION_UNAVAILABLE");
					}
					const persistedRecord = await readPersistedMaterializedRelease(
						publisher,
						publisherDid,
						originalIntent.id,
						originalIntent.requestDigest,
					);
					if (!persistedRecord) return failBeforeWrite("MATERIALIZATION_UNAVAILABLE");
					const workload = await evaluateWorkloadAttestation(
						originalIntent,
						await publisher.getWorkloadPolicy(publisherDid, originalIntent.packageSlug),
						verifier.value.provenance,
					);
					if (!workload.ok) return failBeforeWrite(workload.reasonCode);
					await requireCurrentPublicationAudience(publisher, publisherDid, restored);
					const creatingPhase = await publisher.advancePublicationOperationPhase({
						...completionBase,
						phase: "creating",
						materializationDigest: materializedDigest,
					});
					if (!creatingPhase.ok) return failBeforeWrite(creatingPhase.code);
					writeStarted = true;
					await requireCurrentPublicationAudience(publisher, publisherDid, restored);
					const created = await createReleaseRecord(restored.session, {
						publisherDid,
						rkey: `${originalIntent.packageSlug}:${originalIntent.version}`,
						record: persistedRecord.record,
					});
					const authoritative = await findProofVerifiedRelease(
						publisherDid,
						originalIntent.packageSlug,
						originalIntent.version,
					);
					const proof = reconcileReleaseRecord(
						publisherDid,
						originalIntent.packageSlug,
						originalIntent.version,
						persistedRecord.record,
						authoritative,
					);
					if (proof.outcome !== "exact" || proof.uri !== created.uri || proof.cid !== created.cid) {
						throw new Error("PUBLICATION_PROOF_MISMATCH");
					}
					const completionDigest = await digest(["published", proof.uri, proof.cid]);
					const completed = await publisher.completePublicationOperation({
						...completionBase,
						completionDigest,
						outcome: "published",
						resultUri: proof.uri,
						resultCid: proof.cid,
					});
					if (completed.ok) return { state: "published", uri: proof.uri, cid: proof.cid };
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
						? { state: "published", uri: proof.uri, cid: proof.cid }
						: { state: "reconciling" };
				} catch (error) {
					const errorCode = writeStarted
						? "PUBLICATION_AMBIGUOUS"
						: publicationErrorCode(error, "PUBLICATION_PRECONDITION_FAILED");
					if (error instanceof OAuthCustodyError) {
						writeOperationsMetric(
							{
								event: "refresh_failure",
								outcome: error.code,
								scope: "publisher",
							},
							env.OPERATIONS_METRICS,
						);
					}
					if (!writeStarted) return failBeforeWrite(errorCode);
					writeOperationsMetric(
						{
							event: "reconciliation_required",
							outcome: errorCode,
							scope: "publication",
							value: attempt,
						},
						env.OPERATIONS_METRICS,
					);
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
			});
		})();
		if (attemptResult.state !== "reconciling") {
			await releasePublicationCoordination(
				step,
				publisher,
				publisherDid,
				coordination,
				`publication-coordinate-release-${attempt}`,
			);
		}
		if (attemptResult.state === "published") {
			return { intentId: originalIntent.id, state: "published", reasonCode: null };
		}
		if (attemptResult.state === "expired") {
			return { intentId: originalIntent.id, state: "expired", reasonCode: "INTENT_EXPIRED" };
		}
		if (attemptResult.state === "failed") {
			await step.do(`publication-terminal-staging-cleanup-${attempt}`, async () => {
				const stored = await publisher.getPublicationMaterialization(
					publisherDid,
					originalIntent.id,
				);
				if (!stored) return true;
				try {
					await deleteStagedArtifacts(
						env.PUBLICATION_STAGING,
						stored.slots.map((artifact) => ({
							key: artifact.stagingKey,
							metadata: stagedMetadata(artifact),
							sourceUrlDigest: artifact.sourceUrlDigest,
						})),
					);
					return true;
				} catch (error) {
					console.error(
						JSON.stringify({
							event: "publication_terminal_staging_cleanup_failed",
							intentId: originalIntent.id,
							name: error instanceof Error ? error.name : "UnknownError",
						}),
					);
					return false;
				}
			});
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
			const materialized = await readPersistedMaterializedRelease(
				publisher,
				publisherDid,
				originalIntent.id,
				originalIntent.requestDigest,
			);
			if (!materialized) {
				throw new NonRetryableError("MATERIALIZATION_UNAVAILABLE");
			}
			const authoritative = await findProofVerifiedRelease(
				publisherDid,
				originalIntent.packageSlug,
				originalIntent.version,
			);
			return reconcileReleaseRecord(
				publisherDid,
				originalIntent.packageSlug,
				originalIntent.version,
				materialized.record,
				authoritative,
			);
		});
		const current = await step.do(`reconciliation-state-${attempt}`, () =>
			currentState(publisher, publisherDid, originalIntent.id),
		);
		await releasePublicationCoordination(
			step,
			publisher,
			publisherDid,
			coordination,
			`publication-coordinate-reconciliation-release-${attempt}`,
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
