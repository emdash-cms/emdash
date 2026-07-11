import moderationPolicy from "../fixtures/moderation-policy.json";
import type { LabelerIdentityConfig } from "./config.js";

const CACHE_CONTROL = "public, max-age=300";
const ENTITY_TAG = /(?:W\/)?"[^"]*"/g;
const WEAK_PREFIX = /^W\//;
const POLICY_JSON = JSON.stringify(moderationPolicy);
const POLICY_ETAG = createEtag(POLICY_JSON);

export function serviceDidDocument(config: LabelerIdentityConfig) {
	return {
		"@context": ["https://www.w3.org/ns/did/v1", "https://w3id.org/security/multikey/v1"],
		id: config.labelerDid,
		verificationMethod: [
			{
				id: `${config.labelerDid}#atproto_label`,
				type: "Multikey",
				controller: config.labelerDid,
				publicKeyMultibase: config.signingPublicKeyMultibase,
			},
		],
		service: [
			{
				id: `${config.labelerDid}#atproto_labeler`,
				type: "AtprotoLabeler",
				serviceEndpoint: config.serviceUrl,
			},
		],
	};
}

export function didDocumentResponse(request: Request, config: LabelerIdentityConfig): Response {
	if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
	return new Response(
		request.method === "HEAD" ? null : JSON.stringify(serviceDidDocument(config)),
		{
			headers: {
				"cache-control": CACHE_CONTROL,
				"content-type": "application/did+ld+json; charset=utf-8",
			},
		},
	);
}

export async function policyDocumentResponse(
	request: Request,
	config: LabelerIdentityConfig,
): Promise<Response> {
	if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed();
	if (moderationPolicy.labelerDid !== config.labelerDid)
		return new Response("labeler policy identity does not match the deployment", { status: 500 });
	const etag = await POLICY_ETAG;
	const headers = {
		"cache-control": CACHE_CONTROL,
		"content-type": "application/json; charset=utf-8",
		etag,
	};
	if (matchesIfNoneMatch(request.headers.get("if-none-match"), etag))
		return new Response(null, { status: 304, headers });
	return new Response(request.method === "HEAD" ? null : POLICY_JSON, { headers });
}

function matchesIfNoneMatch(header: string | null, etag: string): boolean {
	if (header === null) return false;
	if (header.trim() === "*") return true;
	return (header.match(ENTITY_TAG) ?? []).some(
		(candidate) => candidate.replace(WEAK_PREFIX, "") === etag,
	);
}

function methodNotAllowed(): Response {
	return new Response("method not allowed", { status: 405, headers: { allow: "GET, HEAD" } });
}

async function createEtag(value: string): Promise<string> {
	const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
	return `"${Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("")}"`;
}
