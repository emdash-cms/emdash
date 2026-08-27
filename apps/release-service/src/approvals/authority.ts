import type { ActorResolver } from "@atcute/identity-resolver";
import { safeParse } from "@atcute/lexicons";
import { isDid } from "@atcute/lexicons/syntax";
import { NSID, PackageProfile, PackageProfileExtension } from "@emdash-cms/registry-lexicons";
import { fetchVerifiedResource } from "@emdash-cms/registry-verification/fetch";

import { createWorkerActorResolver } from "../oauth/custody.js";
import type {
	IntentTransition,
	PublisherDurableObject,
	StoredIntent,
} from "../publisher-do/publisher-do.js";
import { decodeAwaitingApprovalState, type ApprovalEvidence } from "./digest.js";

const DNS_ENDPOINT = "https://cloudflare-dns.com/dns-query";
const MAX_DNS_RESPONSE_BYTES = 64 * 1024;
const MAX_PROFILE_RESPONSE_BYTES = 256 * 1024;

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
}

export interface VerifyCurrentApproverOptions {
	actorResolver?: ActorResolver;
	fetch?: typeof globalThis.fetch;
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

function profileRecordUrl(pds: string, publisherDid: string, packageSlug: string): URL {
	let url: URL;
	try {
		url = new URL(pds);
	} catch {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	if (
		url.protocol !== "https:" ||
		url.username !== "" ||
		url.password !== "" ||
		url.pathname !== "/" ||
		url.search !== "" ||
		url.hash !== ""
	) {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	url.pathname = "/xrpc/com.atproto.repo.getRecord";
	url.searchParams.set("repo", publisherDid);
	url.searchParams.set("collection", NSID.packageProfile);
	url.searchParams.set("rkey", packageSlug);
	return url;
}

function createGuardedIdentityFetch(fetchImplementation: typeof fetch): typeof fetch {
	return async (input, init) => {
		const requestedUrl = new URL(input instanceof Request ? input.url : input.toString());
		const method = init?.method ?? (input instanceof Request ? input.method : "GET");
		if (method !== "GET") {
			throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
		}
		const resource = await fetchVerifiedResource(requestedUrl, {
			fetch: (url, requestInit) => fetchImplementation(url, requestInit),
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
	approverDid: string,
	options: VerifyCurrentApproverOptions = {},
): Promise<void> {
	if (!isDid(evidence.publisherDid) || !isDid(approverDid)) {
		throw new ApprovalAuthorityError("APPROVAL_EVIDENCE_INVALID");
	}
	const fetchImplementation = options.fetch ?? globalThis.fetch;
	let actor;
	try {
		actor = await (
			options.actorResolver ??
			createWorkerActorResolver(createGuardedIdentityFetch(fetchImplementation))
		).resolve(evidence.publisherDid, { signal: AbortSignal.timeout(30_000), noCache: true });
	} catch {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	if (actor.did !== evidence.publisherDid) {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	const requestedUrl = profileRecordUrl(actor.pds, evidence.publisherDid, evidence.packageSlug);
	const resource = await fetchVerifiedResource(requestedUrl, {
		fetch: (url, init) => fetchImplementation(url, init),
		resolveHostname: (hostname) => resolvePublicHostname(hostname, fetchImplementation),
		headerTimeoutMs: 10_000,
		totalTimeoutMs: 30_000,
		maxBytes: MAX_PROFILE_RESPONSE_BYTES,
		maxRedirects: 1,
	});
	if (!resource.success || resource.value.url.toString() !== requestedUrl.toString()) {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	let envelope: unknown;
	try {
		envelope = JSON.parse(
			new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(resource.value.bytes),
		);
	} catch {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	const expectedUri = `at://${evidence.publisherDid}/${NSID.packageProfile}/${evidence.packageSlug}`;
	if (
		!isRecord(envelope) ||
		envelope["uri"] !== expectedUri ||
		typeof envelope["cid"] !== "string" ||
		!("value" in envelope)
	) {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	const profile = safeParse(PackageProfile.mainSchema, envelope["value"]);
	if (!profile.ok || profile.value.id !== expectedUri) {
		throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	}
	const rawExtension = profile.value.extensions?.[NSID.packageProfileExtension];
	const extension = safeParse(PackageProfileExtension.mainSchema, rawExtension);
	if (!extension.ok) throw new ApprovalAuthorityError("PROFILE_FETCH_FAILED");
	if (!extension.value.releasePolicy?.approvers?.includes(approverDid)) {
		throw new ApprovalAuthorityError("APPROVER_NOT_AUTHORIZED");
	}
	if (envelope["cid"] !== evidence.profileCid) {
		throw new ApprovalAuthorityError("PROFILE_CHANGED");
	}
}
