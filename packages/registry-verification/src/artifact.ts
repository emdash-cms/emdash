import { RECORD_SCOPED_BLOB_CACHE_TYPE } from "@emdash-cms/registry-lexicons";

import { unsupportedAuthDetails, UNSUPPORTED_AUTH_MESSAGE } from "./auth.js";
import { multihashFromBlobCid, verifyMultihash } from "./checksum.js";
import { verificationError } from "./errors.js";
import type { VerificationError, VerificationResult } from "./errors.js";
import { DEFAULT_FETCH_LIMITS, fetchVerifiedResource } from "./fetch.js";
import type { FetchVerifiedResourceOptions } from "./fetch.js";

const DID_DOCUMENT_MAX_BYTES = 256 * 1024;
const PLC_DID_PATTERN = /^did:plc:[a-z2-7]{24}$/;
const CID_PATTERN = /^b[a-z2-7]+$/;
const UNSAFE_PATH_SEGMENT = /[/\\?#]/;

export interface ReleaseArtifactReference {
	blob?:
		| {
				$type?: "blob";
				ref: { $link: string };
				mimeType: string;
				size: number;
		  }
		| { cid: string; mimeType: string };
	url?: string;
	checksum: string;
	requiresAuth?: boolean;
}

export interface FetchReleaseArtifactInput {
	artifact: ReleaseArtifactReference;
	record: {
		did: string;
		collection: string;
		rkey: string;
		cid: string;
	};
	artifactCaches?: readonly unknown[];
	pdsEndpoint?: string;
	auth?: unknown;
}

export interface FetchedReleaseArtifact {
	bytes: Uint8Array;
	source: "artifact-cache" | "blob" | "url";
	url: URL;
}

export type RecordScopedImagePreset = "avatar" | "banner" | "feed_thumbnail" | "feed_fullsize";

export async function fetchReleaseArtifact(
	input: FetchReleaseArtifactInput,
	options: FetchVerifiedResourceOptions,
): Promise<VerificationResult<FetchedReleaseArtifact>> {
	const deadline = Date.now() + (options.totalTimeoutMs ?? DEFAULT_FETCH_LIMITS.totalTimeoutMs);
	const { artifact } = input;
	if (!artifact.blob && !artifact.url) {
		return verificationError(
			"RELEASE_ARTIFACT_SOURCE_MISSING",
			"The release artifact must provide a blob or URL.",
		);
	}
	if (artifact.requiresAuth === true || input.auth !== undefined) {
		return unsupportedAuth(input.auth);
	}
	const blobCid = modernBlobCid(artifact.blob);
	const blobMetadata =
		blobCid && artifact.blob && "ref" in artifact.blob ? artifact.blob : undefined;
	if (artifact.blob && !blobCid) {
		return verificationError("BLOB_REF_INVALID", "Legacy blob references are not supported.");
	}
	if (blobCid) {
		const expected = multihashFromBlobCid(blobCid);
		if (!expected.success) return expected;
		if (expected.value !== artifact.checksum) {
			return verificationError(
				"CHECKSUM_MISMATCH",
				"The artifact checksum does not match its blob reference CID.",
			);
		}
	}

	let lastError: VerificationError | undefined;
	for (const cache of input.artifactCaches ?? []) {
		const serviceEndpoint = recordScopedCacheEndpoint(cache);
		if (!serviceEndpoint || !blobCid) continue;
		const cacheUrl = recordScopedBlobCacheUrl(serviceEndpoint, input.record, blobCid);
		if (!cacheUrl.success) {
			lastError = cacheUrl.error;
			continue;
		}
		const attemptOptions = withinDeadline(options, deadline);
		if (!attemptOptions) return timedOut();
		const result = await fetchAndVerify(
			"artifact-cache",
			cacheUrl.value,
			artifact.checksum,
			withBlobSizeLimit(attemptOptions, blobMetadata),
			blobMetadata,
		);
		if (result.success) return result;
		lastError = result.error;
	}

	if (blobCid) {
		const resolutionOptions = withinDeadline(options, deadline);
		if (!resolutionOptions) return timedOut();
		const pds = input.pdsEndpoint
			? ({ success: true, value: input.pdsEndpoint } as const)
			: await resolvePublisherPdsEndpoint(input.record.did, resolutionOptions);
		if (pds.success) {
			const url = blobUrl(pds.value, input.record.did, blobCid);
			if (url.success) {
				const attemptOptions = withinDeadline(options, deadline);
				if (!attemptOptions) return timedOut();
				const result = await fetchAndVerify(
					"blob",
					url.value,
					artifact.checksum,
					withBlobSizeLimit(attemptOptions, blobMetadata),
					blobMetadata,
				);
				if (result.success) return result;
				lastError = result.error;
			} else {
				lastError = url.error;
			}
		} else {
			lastError = pds.error;
		}
	}

	if (artifact.url) {
		const attemptOptions = withinDeadline(options, deadline);
		if (!attemptOptions) return timedOut();
		const result = await fetchAndVerify(
			"url",
			artifact.url,
			artifact.checksum,
			withBlobSizeLimit(attemptOptions, blobMetadata),
			blobMetadata,
		);
		if (result.success) return result;
		lastError = result.error;
	}

	return lastError
		? { success: false, error: lastError }
		: verificationError("FETCH_FAILED", "The release artifact could not be fetched.");
}

export function recordScopedBlobCacheUrl(
	serviceEndpoint: string,
	record: FetchReleaseArtifactInput["record"],
	blobCid: string,
): VerificationResult<URL> {
	try {
		const endpoint = new URL(serviceEndpoint);
		if (
			endpoint.protocol !== "https:" ||
			endpoint.username ||
			endpoint.password ||
			endpoint.pathname !== "/" ||
			endpoint.search ||
			endpoint.hash
		) {
			throw new Error();
		}
		const segments = ["r", record.did, record.collection, record.rkey, record.cid, blobCid];
		if (
			!CID_PATTERN.test(record.cid) ||
			!CID_PATTERN.test(blobCid) ||
			segments.some((segment) => !isSafePathSegment(segment))
		) {
			throw new Error();
		}
		return { success: true, value: new URL(segments.join("/"), endpoint) };
	} catch {
		return verificationError("INVALID_URL", "The record-scoped blob cache endpoint is invalid.");
	}
}

export function recordScopedImageCacheUrl(
	serviceEndpoint: string,
	preset: RecordScopedImagePreset,
	record: FetchReleaseArtifactInput["record"],
	blobCid: string,
): VerificationResult<URL> {
	const raw = recordScopedBlobCacheUrl(serviceEndpoint, record, blobCid);
	if (!raw.success) return raw;
	const url = new URL(raw.value);
	url.pathname = `/img/${preset}${url.pathname}`;
	return { success: true, value: url };
}

export async function resolvePublisherPdsEndpoint(
	publisherDid: string,
	options: FetchVerifiedResourceOptions,
): Promise<VerificationResult<string>> {
	const documentUrl = didDocumentUrl(publisherDid);
	if (!documentUrl) {
		return verificationError("PDS_RESOLUTION_FAILED", "The publisher DID is not supported.");
	}
	const fetched = await fetchVerifiedResource(documentUrl, {
		...options,
		maxBytes: DID_DOCUMENT_MAX_BYTES,
	});
	if (!fetched.success) {
		return verificationError(
			"PDS_RESOLUTION_FAILED",
			"The publisher DID document could not be fetched.",
		);
	}

	let document: unknown;
	try {
		document = JSON.parse(new TextDecoder().decode(fetched.value.bytes));
	} catch {
		return verificationError("PDS_RESOLUTION_FAILED", "The publisher DID document is malformed.");
	}
	if (!isRecord(document) || document.id !== publisherDid || !Array.isArray(document.service)) {
		return verificationError(
			"PDS_RESOLUTION_FAILED",
			"The publisher DID document has no valid PDS service.",
		);
	}
	const service = document.service.find(
		(value) =>
			isRecord(value) &&
			(value.id === `${publisherDid}#atproto_pds` || value.id === "#atproto_pds") &&
			value.type === "AtprotoPersonalDataServer" &&
			typeof value.serviceEndpoint === "string",
	);
	if (!isRecord(service) || typeof service.serviceEndpoint !== "string") {
		return verificationError(
			"PDS_RESOLUTION_FAILED",
			"The publisher DID document has no valid PDS service.",
		);
	}
	try {
		const endpoint = new URL(service.serviceEndpoint);
		const loopbackHttp =
			options.allowHttpLocalhost === true &&
			endpoint.protocol === "http:" &&
			(endpoint.hostname === "localhost" || endpoint.hostname === "127.0.0.1");
		if (
			(!loopbackHttp && endpoint.protocol !== "https:") ||
			endpoint.username ||
			endpoint.password
		) {
			throw new Error();
		}
		return { success: true, value: endpoint.href };
	} catch {
		return verificationError(
			"PDS_RESOLUTION_FAILED",
			"The publisher DID document has no valid PDS service.",
		);
	}
}

async function fetchAndVerify(
	source: FetchedReleaseArtifact["source"],
	url: string | URL,
	checksum: string,
	options: FetchVerifiedResourceOptions,
	blobMetadata?: { mimeType: string; size: number },
): Promise<VerificationResult<FetchedReleaseArtifact>> {
	const fetched = await fetchVerifiedResource(url, options);
	if (!fetched.success) {
		return blobMetadata && fetched.error.code === "RESOURCE_SIZE_EXCEEDED"
			? verificationError(
					"BLOB_METADATA_MISMATCH",
					"The fetched artifact size does not match its signed blob metadata.",
				)
			: fetched;
	}
	const verified = await verifyMultihash(fetched.value.bytes, checksum);
	if (!verified.success) return verified;
	const contentType = fetched.value.headers.get("content-type")?.split(";", 1)[0]?.trim();
	if (
		blobMetadata &&
		(fetched.value.bytes.byteLength !== blobMetadata.size ||
			(contentType !== undefined && contentType !== blobMetadata.mimeType))
	) {
		return verificationError(
			"BLOB_METADATA_MISMATCH",
			"The fetched artifact does not match its signed blob metadata.",
		);
	}
	return {
		success: true,
		value: { bytes: fetched.value.bytes, source, url: fetched.value.url },
	};
}

function withBlobSizeLimit(
	options: FetchVerifiedResourceOptions,
	blobMetadata: { size: number } | undefined,
): FetchVerifiedResourceOptions {
	if (!blobMetadata) return options;
	return {
		...options,
		maxBytes: Math.min(options.maxBytes ?? DEFAULT_FETCH_LIMITS.maxBytes, blobMetadata.size),
	};
}

function blobUrl(pdsEndpoint: string, publisherDid: string, cid: string): VerificationResult<URL> {
	try {
		const url = new URL("/xrpc/com.atproto.sync.getBlob", pdsEndpoint);
		url.searchParams.set("did", publisherDid);
		url.searchParams.set("cid", cid);
		return { success: true, value: url };
	} catch {
		return verificationError("PDS_RESOLUTION_FAILED", "The publisher PDS endpoint is invalid.");
	}
}

function didDocumentUrl(did: string): string | null {
	if (PLC_DID_PATTERN.test(did)) {
		return `https://plc.directory/${encodeURIComponent(did)}`;
	}
	if (!did.startsWith("did:web:")) return null;
	try {
		const parts = did.slice("did:web:".length).split(":").map(decodeURIComponent);
		const host = parts.shift();
		if (!host || parts.some((part) => part === "" || part === "." || part === "..")) return null;
		const path = parts.length === 0 ? "/.well-known/did.json" : `/${parts.join("/")}/did.json`;
		return new URL(path, `https://${host}`).href;
	} catch {
		return null;
	}
}

function unsupportedAuth(auth: unknown): VerificationResult<never> {
	const details = unsupportedAuthDetails(auth);
	return verificationError("AUTH_METHOD_UNSUPPORTED", UNSUPPORTED_AUTH_MESSAGE, details);
}

function withinDeadline(
	options: FetchVerifiedResourceOptions,
	deadline: number,
): FetchVerifiedResourceOptions | null {
	const remaining = deadline - Date.now();
	if (remaining <= 0) return null;
	return { ...options, totalTimeoutMs: remaining };
}

function timedOut(): VerificationResult<never> {
	return verificationError("RESOURCE_TIMEOUT", "Artifact retrieval exceeded its total timeout.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function modernBlobCid(blob: ReleaseArtifactReference["blob"]): string | null {
	if (!blob || !("ref" in blob) || typeof blob.ref?.$link !== "string") return null;
	return blob.ref.$link;
}

function recordScopedCacheEndpoint(value: unknown): string | null {
	if (!isRecord(value) || value.$type !== RECORD_SCOPED_BLOB_CACHE_TYPE) return null;
	return typeof value.serviceEndpoint === "string" ? value.serviceEndpoint : null;
}

function isSafePathSegment(value: string): boolean {
	if (value.length === 0 || UNSAFE_PATH_SEGMENT.test(value)) return false;
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return false;
	}
	return true;
}
