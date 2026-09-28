export class UiApiError extends Error {
	constructor(
		readonly code: string,
		readonly status: number,
		message: string,
	) {
		super(message);
		this.name = "UiApiError";
	}
}

export interface ApproverCredential {
	id: string;
	name: string;
	transports: string[];
	createdAt: number;
	lastUsedAt: number | null;
	revokedAt: number | null;
}

export interface ApprovalReview {
	source: {
		repository: string | null;
		workflowRef: string | null;
		commitSha: string | null;
		runId: string | null;
		actor: string | null;
	};
	artifact: { url: string; checksum: string };
	provenance: {
		url: string;
		checksum: string;
		predicateType: string;
		sourceRepository: string;
		builderId: string;
	} | null;
	accessDiff: {
		escalation: boolean;
		changes: Array<{
			kind: string;
			category: string;
			operation: string | null;
			path: string[];
			escalation: boolean;
		}>;
	};
}

export interface ApprovalResource {
	intent: {
		id: string;
		packageSlug: string;
		version: string;
		state: string;
		expiresAt: number;
	};
	evidence: Record<string, string | number | null>;
	evidenceDigest: string;
	review: ApprovalReview;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function credential(value: unknown): ApproverCredential {
	if (!isRecord(value) || typeof value["id"] !== "string" || typeof value["name"] !== "string") {
		throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
	}
	const transports = value["transports"];
	const createdAt = value["createdAt"];
	const lastUsedAt = value["lastUsedAt"];
	const revokedAt = value["revokedAt"];
	if (
		!Array.isArray(transports) ||
		transports.some((item) => typeof item !== "string") ||
		!Number.isSafeInteger(createdAt) ||
		(lastUsedAt !== null && !Number.isSafeInteger(lastUsedAt)) ||
		(revokedAt !== null && !Number.isSafeInteger(revokedAt))
	) {
		throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
	}
	return {
		id: value["id"],
		name: value["name"],
		transports,
		createdAt: Number(createdAt),
		lastUsedAt: lastUsedAt === null ? null : Number(lastUsedAt),
		revokedAt: revokedAt === null ? null : Number(revokedAt),
	};
}

function nullableString(value: unknown): string | null | undefined {
	return value === null || typeof value === "string" ? value : undefined;
}

export function parseApprovalResource(value: unknown): ApprovalResource {
	if (
		!isRecord(value) ||
		!isRecord(value["intent"]) ||
		!isRecord(value["evidence"]) ||
		typeof value["evidenceDigest"] !== "string" ||
		!isRecord(value["review"])
	) {
		throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
	}
	const intent = value["intent"];
	const review = value["review"];
	if (
		typeof intent["id"] !== "string" ||
		typeof intent["packageSlug"] !== "string" ||
		typeof intent["version"] !== "string" ||
		typeof intent["state"] !== "string" ||
		!Number.isSafeInteger(intent["expiresAt"]) ||
		!isRecord(review["source"]) ||
		!isRecord(review["artifact"])
	) {
		throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
	}
	const source = review["source"];
	const artifact = review["artifact"];
	const repository = nullableString(source["repository"]);
	const workflowRef = nullableString(source["workflowRef"]);
	const commitSha = nullableString(source["commitSha"]);
	const runId = nullableString(source["runId"]);
	const actor = nullableString(source["actor"]);
	if (
		repository === undefined ||
		workflowRef === undefined ||
		commitSha === undefined ||
		runId === undefined ||
		actor === undefined ||
		typeof artifact["url"] !== "string" ||
		typeof artifact["checksum"] !== "string"
	) {
		throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
	}
	let provenance: ApprovalReview["provenance"] = null;
	if (review["provenance"] !== null) {
		if (!isRecord(review["provenance"])) {
			throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
		}
		const raw = review["provenance"];
		if (
			typeof raw["url"] !== "string" ||
			typeof raw["checksum"] !== "string" ||
			typeof raw["predicateType"] !== "string" ||
			typeof raw["sourceRepository"] !== "string" ||
			typeof raw["builderId"] !== "string"
		) {
			throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
		}
		provenance = {
			url: raw["url"],
			checksum: raw["checksum"],
			predicateType: raw["predicateType"],
			sourceRepository: raw["sourceRepository"],
			builderId: raw["builderId"],
		};
	}
	if (
		!isRecord(review["accessDiff"]) ||
		typeof review["accessDiff"]["escalation"] !== "boolean" ||
		!Array.isArray(review["accessDiff"]["changes"])
	) {
		throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
	}
	const accessDiff = {
		escalation: review["accessDiff"]["escalation"],
		changes: review["accessDiff"]["changes"].map((change) => {
			if (
				!isRecord(change) ||
				typeof change["kind"] !== "string" ||
				typeof change["category"] !== "string" ||
				(change["operation"] !== null && typeof change["operation"] !== "string") ||
				!Array.isArray(change["path"]) ||
				change["path"].some((part) => typeof part !== "string") ||
				typeof change["escalation"] !== "boolean"
			) {
				throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
			}
			return {
				kind: change["kind"],
				category: change["category"],
				operation: change["operation"],
				path: change["path"],
				escalation: change["escalation"],
			};
		}),
	};
	const evidence: Record<string, string | number | null> = {};
	for (const [key, item] of Object.entries(value["evidence"])) {
		if (item !== null && typeof item !== "string" && typeof item !== "number") {
			throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
		}
		evidence[key] = item;
	}
	return {
		intent: {
			id: intent["id"],
			packageSlug: intent["packageSlug"],
			version: intent["version"],
			state: intent["state"],
			expiresAt: Number(intent["expiresAt"]),
		},
		evidence,
		evidenceDigest: value["evidenceDigest"],
		review: {
			source: {
				repository,
				workflowRef,
				commitSha,
				runId,
				actor,
			},
			artifact: { url: artifact["url"], checksum: artifact["checksum"] },
			provenance,
			accessDiff,
		},
	};
}

function cookie(name: string): string | null {
	for (const part of document.cookie.split(";")) {
		const separator = part.indexOf("=");
		if (separator < 1 || part.slice(0, separator).trim() !== name) continue;
		return part.slice(separator + 1).trim();
	}
	return null;
}

export function publisherCsrfToken(): string {
	return cookie("__Host-emdash_publisher_csrf") ?? "";
}

export function approverCsrfToken(): string {
	return cookie("__Host-emdash_approver_csrf") ?? "";
}

export function mutationHeaders(csrfToken?: string): Headers {
	const headers = new Headers({
		accept: "application/json",
		"content-type": "application/json",
		"idempotency-key": `web-${crypto.randomUUID()}`,
		"x-emdash-request": "1",
	});
	if (csrfToken) headers.set("x-emdash-csrf", csrfToken);
	return headers;
}

export async function apiRequest<T>(
	path: string,
	init: RequestInit = {},
	parse: (value: unknown) => T,
): Promise<T> {
	const response = await fetch(path, init);
	let payload: unknown;
	try {
		payload = await response.json();
	} catch {
		throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
	}
	if (!isRecord(payload)) {
		throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
	}
	if (!response.ok) {
		const error = isRecord(payload["error"]) ? payload["error"] : null;
		throw new UiApiError(
			error && typeof error["code"] === "string" ? error["code"] : "INTERNAL_ERROR",
			response.status,
			error && typeof error["message"] === "string" ? error["message"] : "Request failed",
		);
	}
	return parse(payload["data"]);
}

export async function beginIdentityAuthorization(
	realm: "approver" | "publisher",
	identifier: string,
	redirectTarget: string,
): Promise<string> {
	return await apiRequest(
		`/v1/${realm}/session/authorize`,
		{
			method: "POST",
			headers: mutationHeaders(),
			body: JSON.stringify({ identifier, redirectTarget }),
		},
		(value) => {
			if (!isRecord(value) || typeof value["authorizationUrl"] !== "string") {
				throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
			}
			return value["authorizationUrl"];
		},
	);
}

export async function beginPublisherDelegation(redirectTarget: string): Promise<string> {
	return await apiRequest(
		"/v1/publisher/delegation/authorize",
		{
			method: "POST",
			headers: mutationHeaders(publisherCsrfToken()),
			body: JSON.stringify({ redirectTarget }),
		},
		(value) => {
			if (!isRecord(value) || typeof value["authorizationUrl"] !== "string") {
				throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
			}
			return value["authorizationUrl"];
		},
	);
}

export async function listApproverCredentials(): Promise<ApproverCredential[]> {
	return await apiRequest("/v1/approver/credentials", {}, (value) => {
		if (!isRecord(value) || !Array.isArray(value["items"])) {
			throw new UiApiError("CLIENT_RESPONSE_INVALID", 502, "Invalid service response");
		}
		return value["items"].map(credential);
	});
}

export async function getApproval(
	publisherDid: string,
	intentId: string,
): Promise<ApprovalResource> {
	return await apiRequest(
		`/v1/approvals/${encodeURIComponent(intentId)}?publisher=${encodeURIComponent(publisherDid)}`,
		{},
		parseApprovalResource,
	);
}

export async function beginPasskeyRegistration(name: string): Promise<unknown> {
	return await apiRequest(
		"/v1/approver/credentials/options",
		{
			method: "POST",
			headers: mutationHeaders(approverCsrfToken()),
			body: JSON.stringify({ name }),
		},
		(value) => value,
	);
}

export async function completePasskeyRegistration(response: unknown): Promise<void> {
	await apiRequest(
		"/v1/approver/credentials",
		{
			method: "POST",
			headers: mutationHeaders(approverCsrfToken()),
			body: JSON.stringify(response),
		},
		() => undefined,
	);
}

export async function beginApprovalDecision(
	publisherDid: string,
	intentId: string,
	decision: "approve" | "reject",
): Promise<unknown> {
	return await apiRequest(
		`/v1/approvals/${encodeURIComponent(intentId)}/options?publisher=${encodeURIComponent(publisherDid)}`,
		{
			method: "POST",
			headers: mutationHeaders(approverCsrfToken()),
			body: JSON.stringify({ decision }),
		},
		(value) => value,
	);
}

export async function completeApprovalDecision(
	publisherDid: string,
	intentId: string,
	decision: "approve" | "reject",
	response: unknown,
): Promise<void> {
	await apiRequest(
		`/v1/approvals/${encodeURIComponent(intentId)}?publisher=${encodeURIComponent(publisherDid)}`,
		{
			method: "POST",
			headers: mutationHeaders(approverCsrfToken()),
			body: JSON.stringify({
				decision,
				idempotencyKey: `approval-${crypto.randomUUID()}`,
				response,
			}),
		},
		() => undefined,
	);
}
