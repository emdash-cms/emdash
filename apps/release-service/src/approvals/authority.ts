import { safeParse } from "@atcute/lexicons";
import { isDid } from "@atcute/lexicons/syntax";
import {
	DirectPdsClient,
	DirectPdsReadError,
	type DirectPdsDidDocumentResolver,
} from "@emdash-cms/registry-client/direct-pds";
import { NSID, PackageProfileExtension } from "@emdash-cms/registry-lexicons";
import { fetchVerifiedResource } from "@emdash-cms/registry-verification/fetch";

import type {
	IntentTransition,
	PublisherDurableObject,
	StoredIntent,
} from "../publisher-do/publisher-do.js";
import { decodeAwaitingApprovalState, type ApprovalEvidence } from "./digest.js";

const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;
const MAX_PROFILE_RESPONSE_BYTES = 256 * 1024;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;

export type ApprovalAuthorityErrorCode =
	| "APPROVAL_EVIDENCE_INVALID"
	| "APPROVER_NOT_AUTHORIZED"
	| "INTENT_NOT_APPROVABLE"
	| "PROFILE_CHANGED"
	| "PROFILE_FETCH_FAILED";

export class ApprovalAuthorityError extends Error {
	constructor(readonly code: ApprovalAuthorityErrorCode) {
		super(code);
		this.name = "ApprovalAuthorityError";
	}
}

export interface LoadedApprovalIntent {
	intent: StoredIntent;
	evidence: ApprovalEvidence;
	evidenceDigest: string;
	approvalGeneration: number;
	appliedDecision: "approve" | "reject" | null;
	appliedApproverDid: string | null;
	appliedApprovalDigest: string | null;
	approverDids: readonly string[];
}

export interface VerifyCurrentApproverOptions {
	didDocumentResolver?: DirectPdsDidDocumentResolver;
	fetch?: typeof globalThis.fetch;
}

export interface CurrentApprovalPolicy {
	profileCid: string;
	approverDids: readonly string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function findApprovalTransition(transitions: readonly IntentTransition[]): IntentTransition | null {
	for (let index = transitions.length - 1; index >= 0; index -= 1) {
		const transition = transitions[index];
		if (transition?.toState === "awaiting_approval") return transition;
	}
	return null;
}

export async function loadApprovalIntent(
	namespace: DurableObjectNamespace<PublisherDurableObject>,
	publisherDid: string,
	intentId: string,
): Promise<LoadedApprovalIntent> {
	const stub = namespace.getByName(publisherDid);
	const [intent, transitions] = await Promise.all([
		stub.getIntent(publisherDid, intentId),
		stub.listIntentTransitions(publisherDid, intentId),
	]);
	if (!intent) throw new ApprovalAuthorityError("INTENT_NOT_APPROVABLE");
	const approvalTransition = findApprovalTransition(transitions);
	if (!approvalTransition) throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
	let state;
	try {
		state = await decodeAwaitingApprovalState(approvalTransition.stateDataJson);
	} catch {
		throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
	}
	const evidence = state.approvalEvidence;
	if (
		evidence.publisherDid !== publisherDid ||
		evidence.intentId !== intentId ||
		evidence.packageSlug !== intent.packageSlug ||
		evidence.version !== intent.version ||
		evidence.releaseInputDigest !== intent.requestDigest ||
		evidence.verificationGeneration !== approvalTransition.stateGeneration ||
		intent.stateGeneration < approvalTransition.stateGeneration
	) {
		throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
	}
	const decisionTransition = transitions.find(
		(transition) =>
			transition.fromState === "awaiting_approval" &&
			transition.stateGeneration === approvalTransition.stateGeneration + 1,
	);
	const appliedDecision =
		decisionTransition?.actorRealm === "approver" && decisionTransition.toState === "ready"
			? "approve"
			: decisionTransition?.actorRealm === "approver" && decisionTransition.toState === "rejected"
				? "reject"
				: null;
	if (appliedDecision === null && intent.expiresAt <= Date.now()) {
		throw new ApprovalAuthorityError("INTENT_NOT_APPROVABLE");
	}
	return {
		intent,
		evidence,
		evidenceDigest: state.approvalEvidenceDigest,
		approvalGeneration: approvalTransition.stateGeneration,
		appliedDecision,
		appliedApproverDid: appliedDecision ? (decisionTransition?.actorIdentity ?? null) : null,
		appliedApprovalDigest: appliedDecision ? (decisionTransition?.transitionDigest ?? null) : null,
		approverDids: state.approverDids,
	};
}

async function readBoundedJson(response: Response): Promise<unknown> {
	if (!response.ok || !response.body) throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let length = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			length += value.byteLength;
			if (length > MAX_DNS_RESPONSE_BYTES) {
				await reader.cancel();
				throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
			}
			chunks.push(value);
		}
	} finally {
		reader.releaseLock();
	}
	const bytes = new Uint8Array(length);
	let offset = 0;
	for (const chunk of chunks) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}
	try {
		return JSON.parse(new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes));
	} catch {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
}

async function resolveDnsType(
	hostname: string,
	type: "A" | "AAAA",
	fetchImplementation: typeof fetch,
): Promise<readonly string[]> {
	const url = new URL(DNS_ENDPOINT);
	url.searchParams.set("name", hostname);
	url.searchParams.set("type", type);
	const response = await fetchImplementation(url, {
		headers: { accept: "application/dns-json" },
		redirect: "error",
		signal: AbortSignal.timeout(5_000),
	});
	const parsed = await readBoundedJson(response);
	if (!isRecord(parsed) || parsed["Status"] !== 0 || !Array.isArray(parsed["Answer"])) {
		return [];
	}
	const expectedType = type === "A" ? 1 : 28;
	return parsed["Answer"].flatMap((answer): string[] => {
		if (
			!isRecord(answer) ||
			answer["type"] !== expectedType ||
			typeof answer["data"] !== "string"
		) {
			return [];
		}
		return [answer["data"]];
	});
}

async function resolvePublicHostname(
	hostname: string,
	fetchImplementation: typeof fetch,
): Promise<readonly string[]> {
	if (hostname.length === 0 || hostname.length > 253) return [];
	const [ipv4, ipv6] = await Promise.all([
		resolveDnsType(hostname, "A", fetchImplementation),
		resolveDnsType(hostname, "AAAA", fetchImplementation),
	]);
	return [...ipv4, ...ipv6];
}

function createGuardedIdentityFetch(fetchImplementation: typeof fetch): typeof fetch {
	return async (input, init) => {
		const requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (method !== "GET") {
			throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
		}
		const headers = init?.headers ?? (input instanceof Request ? input.headers : undefined);
		const resource = await fetchVerifiedResource(requestedUrl, {
			fetch: (url, requestInit) =>
				fetchImplementation(url, {
					...requestInit,
					...(headers === undefined ? {} : { headers }),
				}),
			resolveHostname: (hostname) => resolvePublicHostname(hostname, fetchImplementation),
			headerTimeoutMs: 10_000,
			totalTimeoutMs: 30_000,
			maxBytes: MAX_PROFILE_RESPONSE_BYTES,
			maxRedirects: 1,
		});
		if (!resource.success || resource.value.url.toString() !== requestedUrl.toString()) {
			throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
		}
		return new Response(resource.value.bytes, {
			status: resource.value.status,
			headers: resource.value.headers,
		});
	};
}

export async function verifyCurrentApprover(
	evidence: ApprovalEvidence,
	immutableApproverDids: readonly string[],
	approverDid: string,
	options: VerifyCurrentApproverOptions = {},
): Promise<void> {
	if (!isDid(evidence.publisherDid) || !isDid(approverDid)) {
		throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
	}
	if (!immutableApproverDids.includes(approverDid)) {
		throw new ApprovalAuthorityError("APPROVER_NOT_AUTHORIZED");
	}
	const policy = await loadCurrentApprovalPolicy(
		evidence.publisherDid,
		evidence.packageSlug,
		options,
	);
	if (!policy.approverDids.includes(approverDid)) {
		throw new ApprovalAuthorityError("APPROVER_NOT_AUTHORIZED");
	}
	if (policy.profileCid !== evidence.profileCid) {
		throw new ApprovalAuthorityError("PROFILE_CHANGED");
	}
}

export async function loadCurrentApprovalPolicy(
	publisherDid: string,
	packageSlug: string,
	options: VerifyCurrentApproverOptions = {},
): Promise<CurrentApprovalPolicy> {
	if (!isDid(publisherDid) || !PACKAGE_SLUG_PATTERN.test(packageSlug)) {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	let record;
	try {
		record = await new DirectPdsClient({
			did: publisherDid,
			fetch: createGuardedIdentityFetch(fetchImplementation),
			...(options.didDocumentResolver === undefined
				? {}
				: { didDocumentResolver: options.didDocumentResolver }),
			requestTimeoutMs: 30_000,
			maxResponseBytes: MAX_PROFILE_RESPONSE_BYTES,
		}).getPackageProfile(packageSlug);
	} catch (error) {
		if (error instanceof DirectPdsReadError || error instanceof TypeError) {
			throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
		}
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	const expectedUri = `at://${publisherDid}/${NSID.packageProfile}/${packageSlug}`;
	if (record.uri !== expectedUri || record.value.id !== expectedUri) {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	const rawExtension = record.value.extensions?.[NSID.packageProfileExtension];
	const extension = safeParse(PackageProfileExtension.mainSchema, rawExtension);
	if (!extension.ok) throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	const approverDids = extension.value.releasePolicy?.approvers ?? [];
	if (
		new Set(approverDids).size !== approverDids.length ||
		approverDids.some((approverDid) => !isDid(approverDid))
	) {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	return {
		profileCid: record.cid,
		approverDids: [...approverDids].toSorted(),
	};
}
