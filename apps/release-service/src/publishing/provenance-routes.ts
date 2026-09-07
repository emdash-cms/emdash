import { compareDigestBytes, decodeMultihash } from "@emdash-cms/registry-verification/checksum";
import { env } from "cloudflare:workers";

import { ApiError } from "../api/errors.js";
import { apiFailure } from "../api/response.js";

const PROVENANCE_PATH_PATTERN = /^\/v1\/provenance\/(b[a-z2-7]{10,255})$/;
const MAX_PROVENANCE_BYTES = 5 * 1024 * 1024;

export function matchPublishedProvenancePath(
	pathname: string,
): Readonly<Record<string, string>> | null {
	const match = PROVENANCE_PATH_PATTERN.exec(pathname);
	return match?.[1] ? { checksum: match[1] } : null;
}

function unavailable(requestId: string): Response {
	return apiFailure(new ApiError("NOT_FOUND", 404, "Provenance was not found"), requestId);
}

export async function handleGetPublishedProvenance(
	_request: Request,
	requestId: string,
	params: Readonly<Record<string, string>>,
): Promise<Response> {
	const checksum = params["checksum"];
	if (!checksum) return unavailable(requestId);
	const decoded = decodeMultihash(checksum);
	if (!decoded.success) return unavailable(requestId);
	const object = await env.PROVENANCE_STORE.get(`provenance/${checksum}`);
	if (
		!object ||
		object.size < 1 ||
		object.size > MAX_PROVENANCE_BYTES ||
		object.customMetadata?.["checksum"] !== checksum ||
		object.customMetadata["published"] !== "true" ||
		object.httpMetadata?.contentType !== "application/json" ||
		object.checksums.sha256 === undefined ||
		!compareDigestBytes(new Uint8Array(object.checksums.sha256), decoded.value.digest)
	) {
		return unavailable(requestId);
	}
	return new Response(object.body, {
		headers: {
			"access-control-allow-origin": "*",
			"cache-control": "public, max-age=31536000, immutable",
			"content-length": String(object.size),
			"content-type": "application/json",
			etag: object.httpEtag,
			"x-content-type-options": "nosniff",
			"x-request-id": requestId,
		},
	});
}
