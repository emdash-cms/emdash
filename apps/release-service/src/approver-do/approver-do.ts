import { DurableObject } from "cloudflare:workers";

import type {
	EncryptionRecordPage,
	EncryptionRecordReplacement,
} from "../operations/encryption-records.js";
import { initializeApproverSchema } from "./schema.js";
import {
	ApproverStore,
	ApproverStoreError,
	type ApproverAuditEvent,
	type ApproverCredential,
	type ApproverEnrollmentStatus,
	type ApprovalReceipt,
	type CleanupResult,
	type CommitVerifiedDecisionInput,
	type CommitCredentialUseResult,
	type ConsumeChallengeResult,
	type CreateApproverSessionInput,
	type CreateApproverSessionResult,
	type CreateChallengeInput,
	type CreateChallengeResult,
	type CredentialVerificationMaterial,
	type DecisionIdentity,
	type EnrolCredentialInput,
	type EnrolCredentialResult,
	type FindDecisionResult,
	type PutIdentityTransactionInput,
	type PutIdentityTransactionResult,
	type RecordDecisionResult,
	type RevokeCredentialResult,
	type StoredIdentityTransaction,
	type ValidateApproverSessionResult,
} from "./store.js";

export type {
	ApproverAuditEvent,
	ApproverCredential,
	ApproverEnrollmentStatus,
	ApprovalDecision,
	ApprovalReceipt,
	CleanupResult,
	CommitVerifiedDecisionInput,
	CommitCredentialUseResult,
	ConsumedChallenge,
	ConsumeChallengeResult,
	CreateApproverSessionInput,
	CreateApproverSessionResult,
	CreateChallengeInput,
	CreateChallengeResult,
	CredentialVerificationMaterial,
	DecisionIdentity,
	EnrolCredentialInput,
	EnrolCredentialResult,
	FindDecisionResult,
	PutIdentityTransactionInput,
	PutIdentityTransactionResult,
	RecordDecisionResult,
	RevokeCredentialResult,
	StoredApproverSession,
	StoredIdentityTransaction,
	ValidateApproverSessionResult,
} from "./store.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;

export class ApproverDurableObject extends DurableObject<Env> {
	readonly #objectName: string | undefined;
	readonly #store: ApproverStore;

	constructor(ctx: DurableObjectState, env: Env) {
		super(ctx, env);
		this.#objectName = ctx.id.name;
		this.#store = new ApproverStore(ctx.storage);
		void ctx.blockConcurrencyWhile(async () => {
			initializeApproverSchema(ctx.storage);
		});
	}

	initializeApprover(approverDid: string): void {
		this.#assertApproverDid(approverDid);
	}

	async putIdentityTransaction(
		input: PutIdentityTransactionInput,
	): Promise<PutIdentityTransactionResult> {
		this.#assertApproverDid(input.approverDid);
		const result = this.#store.putIdentityTransaction(input);
		if (result.ok) await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	async consumeIdentityTransaction(
		approverDid: string,
		stateHash: string,
		now = Date.now(),
	): Promise<StoredIdentityTransaction | null> {
		this.#assertApproverDid(approverDid);
		const result = this.#store.consumeIdentityTransaction(approverDid, stateHash, now);
		await this.#scheduleNextAlarm(now);
		return result;
	}

	async createApproverSession(
		input: CreateApproverSessionInput,
	): Promise<CreateApproverSessionResult> {
		this.#assertApproverDid(input.approverDid);
		const result = this.#store.createSession(input);
		if (result.ok) await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	async validateApproverSession(
		approverDid: string,
		tokenHash: string,
		csrfHash: string | null,
		now = Date.now(),
	): Promise<ValidateApproverSessionResult> {
		this.#assertObjectName(approverDid);
		const result = this.#store.validateSession(approverDid, tokenHash, csrfHash, now);
		if (!result.ok && result.code === "APPROVER_SESSION_EXPIRED") {
			await this.#scheduleNextAlarm(now);
		}
		return result;
	}

	async revokeApproverSession(
		approverDid: string,
		tokenHash: string,
		now = Date.now(),
	): Promise<boolean> {
		this.#assertApproverDid(approverDid);
		const result = this.#store.revokeSession(approverDid, tokenHash, now);
		if (result) await this.#scheduleNextAlarm(now);
		return result;
	}

	async revokeAllApproverSessions(approverDid: string, now = Date.now()): Promise<number> {
		this.#assertApproverDid(approverDid);
		const result = this.#store.revokeAllSessions(approverDid, now);
		await this.#scheduleNextAlarm(now);
		return result;
	}

	enrolCredential(approverDid: string, input: EnrolCredentialInput): EnrolCredentialResult {
		this.#assertApproverDid(approverDid);
		return this.#store.enrolCredential(approverDid, input);
	}

	listCredentials(
		approverDid: string,
		afterCredentialId: string | null,
		limit: number,
	): readonly ApproverCredential[] {
		this.#assertApproverDid(approverDid);
		return this.#store.listCredentials(approverDid, afterCredentialId, limit);
	}

	getEnrollmentStatus(approverDid: string): ApproverEnrollmentStatus {
		this.#assertObjectName(approverDid);
		return this.#store.getEnrollmentStatus(approverDid);
	}

	getCredentialForVerification(
		approverDid: string,
		credentialId: string,
	): CredentialVerificationMaterial | null {
		this.#assertApproverDid(approverDid);
		return this.#store.getCredentialForVerification(approverDid, credentialId);
	}

	async revokeCredential(
		approverDid: string,
		credentialId: string,
		now = Date.now(),
	): Promise<RevokeCredentialResult> {
		this.#assertApproverDid(approverDid);
		const result = this.#store.revokeCredential(approverDid, credentialId, now);
		if (result.ok) await this.#scheduleNextAlarm(now);
		return result;
	}

	commitCredentialUse(
		approverDid: string,
		credentialId: string,
		expectedCounter: number,
		newCounter: number,
		now = Date.now(),
	): CommitCredentialUseResult {
		this.#assertApproverDid(approverDid);
		return this.#store.commitCredentialUse(
			approverDid,
			credentialId,
			expectedCounter,
			newCounter,
			now,
		);
	}

	async createChallenge(
		approverDid: string,
		input: CreateChallengeInput,
	): Promise<CreateChallengeResult> {
		this.#assertApproverDid(approverDid);
		const result = this.#store.createChallenge(approverDid, input);
		if (result.ok) await this.#scheduleNextAlarm(input.now ?? Date.now());
		return result;
	}

	async consumeChallenge(
		approverDid: string,
		challengeHash: string,
		expectedKind: CreateChallengeInput["kind"],
		now = Date.now(),
	): Promise<ConsumeChallengeResult> {
		this.#assertApproverDid(approverDid);
		const result = this.#store.consumeChallenge(approverDid, challengeHash, expectedKind, now);
		await this.#scheduleNextAlarm(now);
		return result;
	}

	async invalidateIntentChallenges(
		approverDid: string,
		intentId: string,
		reasonCode: string,
		now = Date.now(),
	): Promise<number> {
		this.#assertApproverDid(approverDid);
		const result = this.#store.invalidateIntentChallenges(approverDid, intentId, reasonCode, now);
		await this.#scheduleNextAlarm(now);
		return result;
	}

	findDecision(approverDid: string, input: DecisionIdentity): FindDecisionResult {
		this.#assertApproverDid(approverDid);
		return this.#store.findDecision(approverDid, input);
	}

	async commitVerifiedDecision(
		approverDid: string,
		input: CommitVerifiedDecisionInput,
	): Promise<RecordDecisionResult> {
		this.#assertApproverDid(approverDid);
		const result = this.#store.commitVerifiedDecision(approverDid, input);
		if (result.ok && !result.replayed) await this.#scheduleNextAlarm(input.verifiedAt);
		return result;
	}

	getDecision(
		approverDid: string,
		intentId: string,
		approvalDigest: string,
	): ApprovalReceipt | null {
		this.#assertApproverDid(approverDid);
		return this.#store.getDecision(approverDid, intentId, approvalDigest);
	}

	listAuditEvents(
		approverDid: string,
		afterSequence: number,
		limit: number,
	): readonly ApproverAuditEvent[] {
		this.#assertApproverDid(approverDid);
		return this.#store.listAuditEvents(approverDid, afterSequence, limit);
	}

	listEncryptionRecords(
		approverDid: string,
		afterCursor: string | null,
		limit: number,
		now = Date.now(),
	): EncryptionRecordPage {
		this.#assertApproverDid(approverDid);
		return this.#store.listEncryptionRecords(approverDid, afterCursor, limit, now);
	}

	replaceEncryptionRecord(input: EncryptionRecordReplacement & { approverDid: string }): boolean {
		this.#assertApproverDid(input.approverDid);
		return this.#store.replaceEncryptionRecord(input);
	}

	async cleanupExpired(approverDid: string, now = Date.now(), limit = 100): Promise<CleanupResult> {
		this.#assertApproverDid(approverDid);
		const result = this.#store.cleanupExpired(now, limit);
		await this.#scheduleNextAlarm(now);
		return result;
	}

	override async alarm(): Promise<void> {
		const now = Date.now();
		this.#store.cleanupExpired(now);
		await this.#scheduleNextAlarm(now);
	}

	#assertObjectName(approverDid: string): void {
		if (!DID_PATTERN.test(approverDid)) {
			throw new ApproverStoreError("APPROVER_DID_INVALID");
		}
		if (this.#objectName === undefined || this.#objectName !== approverDid) {
			throw new ApproverStoreError("APPROVER_DID_MISMATCH");
		}
	}

	#assertApproverDid(approverDid: string): void {
		this.#assertObjectName(approverDid);
		this.#store.initialize(approverDid);
	}

	async #scheduleNextAlarm(now: number): Promise<void> {
		const deadline = this.#store.nextDeadline();
		if (deadline === null) {
			await this.ctx.storage.deleteAlarm();
			return;
		}
		await this.ctx.storage.setAlarm(Math.max(now + 1, deadline));
	}
}
