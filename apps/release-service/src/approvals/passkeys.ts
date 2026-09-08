import {
	bindChallengeContext,
	generateAuthenticationOptions,
	generateRegistrationOptions,
	verifyAuthenticationResponse,
	verifyRegistrationResponse,
	type AtomicChallengeStore,
	type AuthenticationOptions,
	type AuthenticationResponse,
	type ChallengeData,
	type PasskeyConfig,
	type RegistrationOptions,
	type RegistrationResponse,
} from "@emdash-cms/auth/passkey";
import { base64url } from "jose";

import type {
	ApproverDurableObject,
	EnrolCredentialResult,
	RecordDecisionResult,
} from "../approver-do/approver-do.js";
import {
	approvalChallengeContext,
	approverEnrolmentContext,
	type ApprovalChallengeContext,
} from "./context.js";
import { computeApprovalDecisionDigest, type ApprovalDecision } from "./digest.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;
const RP_ID_PATTERN =
	/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)*[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const RP_NAME = "EmDash release approvals";
const MAX_CHALLENGE_CHARS = 4096;

export interface ApprovalPasskeyRelyingParty {
	rpId: string;
	origin: string;
}

export interface ApprovalDecisionRequest {
	approverDid: string;
	publisherDid: string;
	intentId: string;
	evidenceDigest: string;
	decision: ApprovalDecision;
}

export interface BeginApprovalDecisionResult {
	options: AuthenticationOptions;
	context: ApprovalChallengeContext;
}

export class ApprovalPasskeyError extends Error {
	readonly code:
		| "APPROVER_PASSKEY_CONFIG_INVALID"
		| "APPROVER_PASSKEY_CONTEXT_INVALID"
		| "APPROVER_CREDENTIAL_NOT_FOUND"
		| "APPROVER_CHALLENGE_INVALID";

	constructor(code: ApprovalPasskeyError["code"]) {
		super(code);
		this.name = "ApprovalPasskeyError";
		this.code = code;
	}
}

interface ChallengeMetadata {
	kind: "registration" | "approval";
	intentId?: string;
	publisherDid?: string;
	approvalDigest?: string;
}

class DurableApproverChallengeStore implements AtomicChallengeStore {
	readonly atomic = true;

	constructor(
		private readonly stub: DurableObjectStub<ApproverDurableObject>,
		private readonly approverDid: string,
		private readonly metadata: ChallengeMetadata,
	) {}

	async set(challenge: string, data: ChallengeData): Promise<void> {
		const expectedType = this.metadata.kind === "registration" ? "registration" : "authentication";
		if (
			data.type !== expectedType ||
			(this.metadata.kind === "registration" && data.userId !== this.approverDid) ||
			(this.metadata.kind === "approval" && data.userId !== undefined) ||
			typeof data.context !== "string"
		) {
			throw new ApprovalPasskeyError("APPROVER_CHALLENGE_INVALID");
		}
		const result = await this.stub.createChallenge(this.approverDid, {
			challengeHash: await hashChallenge(challenge),
			kind: this.metadata.kind,
			...(this.metadata.intentId ? { intentId: this.metadata.intentId } : {}),
			...(this.metadata.publisherDid ? { publisherDid: this.metadata.publisherDid } : {}),
			...(this.metadata.approvalDigest ? { approvalDigest: this.metadata.approvalDigest } : {}),
			context: data.context,
			expiresAt: data.expiresAt,
		});
		if (!result.ok) throw new ApprovalPasskeyError("APPROVER_CHALLENGE_INVALID");
	}

	async consume(challenge: string): Promise<ChallengeData | null> {
		const result = await this.stub.consumeChallenge(
			this.approverDid,
			await hashChallenge(challenge),
			this.metadata.kind,
		);
		if (!result.ok) return null;
		if (
			result.challenge.intentId !== (this.metadata.intentId ?? null) ||
			result.challenge.publisherDid !== (this.metadata.publisherDid ?? null) ||
			result.challenge.approvalDigest !== (this.metadata.approvalDigest ?? null)
		) {
			return null;
		}
		return {
			type: this.metadata.kind === "registration" ? "registration" : "authentication",
			...(this.metadata.kind === "registration" ? { userId: this.approverDid } : {}),
			expiresAt: result.challenge.expiresAt,
			context: result.challenge.context,
		};
	}
}

function createPasskeyConfig(value: ApprovalPasskeyRelyingParty): PasskeyConfig {
	if (
		typeof value.rpId !== "string" ||
		value.rpId.length < 1 ||
		value.rpId.length > 253 ||
		!RP_ID_PATTERN.test(value.rpId) ||
		typeof value.origin !== "string" ||
		value.origin.length > 2048
	) {
		throw new ApprovalPasskeyError("APPROVER_PASSKEY_CONFIG_INVALID");
	}
	let origin: URL;
	try {
		origin = new URL(value.origin);
	} catch {
		throw new ApprovalPasskeyError("APPROVER_PASSKEY_CONFIG_INVALID");
	}
	if (
		origin.protocol !== "https:" ||
		origin.username !== "" ||
		origin.password !== "" ||
		origin.pathname !== "/" ||
		origin.search !== "" ||
		origin.hash !== "" ||
		origin.hostname !== value.rpId ||
		origin.origin !== value.origin
	) {
		throw new ApprovalPasskeyError("APPROVER_PASSKEY_CONFIG_INVALID");
	}
	return {
		rpName: RP_NAME,
		rpId: value.rpId,
		origins: [value.origin],
		userVerification: "required",
	};
}

async function hashChallenge(value: string): Promise<string> {
	if (
		typeof value !== "string" ||
		value.length < 1 ||
		value.length > MAX_CHALLENGE_CHARS ||
		!BASE64URL_PATTERN.test(value)
	) {
		throw new ApprovalPasskeyError("APPROVER_CHALLENGE_INVALID");
	}
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return base64url.encode(new Uint8Array(digest));
}

function validDecisionRequest(value: ApprovalDecisionRequest): boolean {
	return (
		DID_PATTERN.test(value.approverDid) &&
		DID_PATTERN.test(value.publisherDid) &&
		ULID_PATTERN.test(value.intentId) &&
		DIGEST_PATTERN.test(value.evidenceDigest) &&
		(value.decision === "approve" || value.decision === "reject")
	);
}

function challengeMetadata(context: ApprovalChallengeContext): ChallengeMetadata {
	return {
		kind: "approval",
		intentId: context.intentId,
		publisherDid: context.publisherDid,
		approvalDigest: context.approvalDigest,
	};
}

function sameApprovalContext(
	left: ApprovalChallengeContext,
	right: ApprovalChallengeContext,
): boolean {
	return (
		left.approverDid === right.approverDid &&
		left.publisherDid === right.publisherDid &&
		left.intentId === right.intentId &&
		left.evidenceDigest === right.evidenceDigest &&
		left.approvalDigest === right.approvalDigest &&
		left.decision === right.decision
	);
}

export async function beginApproverCredentialRegistration(
	stub: DurableObjectStub<ApproverDurableObject>,
	approverDid: string,
	credentialName: string,
	relyingParty: ApprovalPasskeyRelyingParty,
): Promise<RegistrationOptions> {
	if (
		!DID_PATTERN.test(approverDid) ||
		typeof credentialName !== "string" ||
		credentialName.length < 1 ||
		credentialName.length > 100 ||
		credentialName.trim() !== credentialName
	) {
		throw new ApprovalPasskeyError("APPROVER_PASSKEY_CONTEXT_INVALID");
	}
	const credentials = (await stub.listCredentials(approverDid, null, 100))
		.filter((credential) => credential.revokedAt === null)
		.map((credential) => ({ id: credential.id, transports: credential.transports }));
	return await generateRegistrationOptions(
		createPasskeyConfig(relyingParty),
		{ id: approverDid, email: approverDid, name: approverDid },
		credentials,
		new DurableApproverChallengeStore(stub, approverDid, { kind: "registration" }),
		bindChallengeContext(approverEnrolmentContext, { approverDid, credentialName }),
	);
}

export async function completeApproverCredentialRegistration(
	stub: DurableObjectStub<ApproverDurableObject>,
	approverDid: string,
	response: RegistrationResponse,
	relyingParty: ApprovalPasskeyRelyingParty,
	now = Date.now(),
): Promise<EnrolCredentialResult> {
	if (!DID_PATTERN.test(approverDid) || !Number.isSafeInteger(now) || now < 0) {
		throw new ApprovalPasskeyError("APPROVER_PASSKEY_CONTEXT_INVALID");
	}
	let verified;
	try {
		verified = await verifyRegistrationResponse(
			createPasskeyConfig(relyingParty),
			response,
			new DurableApproverChallengeStore(stub, approverDid, { kind: "registration" }),
			approverEnrolmentContext,
		);
	} catch (error) {
		if (error instanceof ApprovalPasskeyError) throw error;
		throw new ApprovalPasskeyError("APPROVER_CHALLENGE_INVALID");
	}
	if (verified.challengeContext.approverDid !== approverDid) {
		throw new ApprovalPasskeyError("APPROVER_PASSKEY_CONTEXT_INVALID");
	}
	return await stub.enrolCredential(approverDid, {
		credentialId: verified.credentialId,
		publicKey: verified.publicKey,
		algorithm: verified.algorithm,
		counter: verified.counter,
		transports: verified.transports,
		name: verified.challengeContext.credentialName,
		now,
	});
}

export async function beginApprovalDecision(
	stub: DurableObjectStub<ApproverDurableObject>,
	request: ApprovalDecisionRequest,
	relyingParty: ApprovalPasskeyRelyingParty,
): Promise<BeginApprovalDecisionResult> {
	if (!validDecisionRequest(request)) {
		throw new ApprovalPasskeyError("APPROVER_PASSKEY_CONTEXT_INVALID");
	}
	const approvalDigest = await computeApprovalDecisionDigest({
		evidenceDigest: request.evidenceDigest,
		approverDid: request.approverDid,
		decision: request.decision,
	});
	const context: ApprovalChallengeContext = { ...request, approvalDigest };
	const credentials = (await stub.listCredentials(request.approverDid, null, 100))
		.filter((credential) => credential.revokedAt === null)
		.map((credential) => ({ id: credential.id, transports: credential.transports }));
	if (credentials.length === 0) {
		throw new ApprovalPasskeyError("APPROVER_CREDENTIAL_NOT_FOUND");
	}
	const options = await generateAuthenticationOptions(
		createPasskeyConfig(relyingParty),
		credentials,
		new DurableApproverChallengeStore(stub, request.approverDid, challengeMetadata(context)),
		bindChallengeContext(approvalChallengeContext, context),
	);
	return { options, context };
}

export async function completeApprovalDecision(
	stub: DurableObjectStub<ApproverDurableObject>,
	request: ApprovalDecisionRequest,
	idempotencyKey: string,
	response: AuthenticationResponse,
	relyingParty: ApprovalPasskeyRelyingParty,
	now = Date.now(),
): Promise<RecordDecisionResult> {
	if (!validDecisionRequest(request) || !Number.isSafeInteger(now) || now < 0) {
		throw new ApprovalPasskeyError("APPROVER_PASSKEY_CONTEXT_INVALID");
	}
	const approvalDigest = await computeApprovalDecisionDigest({
		evidenceDigest: request.evidenceDigest,
		approverDid: request.approverDid,
		decision: request.decision,
	});
	const identity = {
		idempotencyKey,
		intentId: request.intentId,
		publisherDid: request.publisherDid,
		approvalDigest,
		decision: request.decision,
		credentialId: response.id,
	};
	const replay = await stub.findDecision(request.approverDid, identity);
	if (replay) {
		return replay.ok ? { ok: true, receipt: replay.receipt, replayed: true } : replay;
	}
	const credential = await stub.getCredentialForVerification(request.approverDid, response.id);
	if (!credential) return { ok: false, code: "CREDENTIAL_NOT_FOUND" };
	const context: ApprovalChallengeContext = { ...request, approvalDigest };
	let verified;
	try {
		verified = await verifyAuthenticationResponse(
			createPasskeyConfig(relyingParty),
			response,
			credential,
			new DurableApproverChallengeStore(stub, request.approverDid, challengeMetadata(context)),
			approvalChallengeContext,
		);
	} catch (error) {
		if (error instanceof ApprovalPasskeyError) throw error;
		throw new ApprovalPasskeyError("APPROVER_CHALLENGE_INVALID");
	}
	if (!sameApprovalContext(verified.challengeContext, context)) {
		throw new ApprovalPasskeyError("APPROVER_PASSKEY_CONTEXT_INVALID");
	}
	return await stub.commitVerifiedDecision(request.approverDid, {
		...identity,
		verifiedAt: now,
		expectedCounter: credential.counter,
		newCounter: verified.newCounter,
	});
}
