import {
	compareDigestBytes,
	decodeMultihash,
	verifyMultihash,
} from "@emdash-cms/registry-verification/checksum";
import { base64url } from "jose";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const DIGEST_PATTERN = /^[A-Za-z0-9_-]{43}$/;
const PACKAGE_SLUG_PATTERN = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const VERSION_PATTERN = /^[0-9A-Za-z][0-9A-Za-z.-]{0,127}$/;
const SCREENSHOT_SLOT_PATTERN = /^screenshots\[([0-7])\]$/;
const CHECKSUM_PATTERN = /^b[a-z2-7]{10,255}$/;
const MAX_PACKAGE_BYTES = 256 * 1024;
const MAX_IMAGE_BYTES = 1024 * 1024;
const MAX_PROVENANCE_BYTES = 5 * 1024 * 1024;

export type WorkloadArtifactSlot =
	| "package"
	| "icon"
	| "banner"
	| `screenshots[${number}]`
	| "provenance";

export interface WorkloadStagedArtifact {
	key: string;
	slot: WorkloadArtifactSlot;
	checksum: string;
	contentType: string;
	size: number;
	bytes: Uint8Array;
}

export class WorkloadStagingError extends Error {
	readonly code:
		| "WORKLOAD_STAGING_CHECKSUM_MISMATCH"
		| "WORKLOAD_STAGING_CONFLICT"
		| "WORKLOAD_STAGING_INVALID"
		| "WORKLOAD_STAGING_MISSING"
		| "WORKLOAD_STAGING_SIZE_MISMATCH"
		| "WORKLOAD_STAGING_WRITE_FAILED";

	constructor(code: WorkloadStagingError["code"]) {
		super(code);
		this.name = "WorkloadStagingError";
		this.code = code;
	}
}

export interface WorkloadArtifactIdentity {
	publisherDid: string;
	workloadDigest: string;
	packageSlug: string;
	version: string;
	slot: WorkloadArtifactSlot;
	checksum: string;
}

interface PersistWorkloadArtifactInput extends WorkloadArtifactIdentity {
	contentType: string;
	contentLength: number;
	body: ReadableStream<Uint8Array>;
}

function isSlot(value: string): value is WorkloadArtifactSlot {
	return (
		value === "package" ||
		value === "icon" ||
		value === "banner" ||
		value === "provenance" ||
		SCREENSHOT_SLOT_PATTERN.test(value)
	);
}

function slotKey(slot: WorkloadArtifactSlot): string {
	return slot.startsWith("screenshots[") ? slot.replaceAll("[", "-").replaceAll("]", "") : slot;
}

function maxBytes(slot: WorkloadArtifactSlot): number {
	if (slot === "package") return MAX_PACKAGE_BYTES;
	if (slot === "provenance") return MAX_PROVENANCE_BYTES;
	return MAX_IMAGE_BYTES;
}

function validContentType(slot: WorkloadArtifactSlot, value: string): boolean {
	if (slot === "package") return value === "application/gzip";
	if (slot === "provenance") return value === "application/json";
	return value === "image/png" || value === "image/jpeg" || value === "image/webp";
}

function validateIdentity(input: WorkloadArtifactIdentity): Uint8Array {
	const checksum = decodeMultihash(input.checksum);
	if (
		!DID_PATTERN.test(input.publisherDid) ||
		!DIGEST_PATTERN.test(input.workloadDigest) ||
		!PACKAGE_SLUG_PATTERN.test(input.packageSlug) ||
		!VERSION_PATTERN.test(input.version) ||
		!isSlot(input.slot) ||
		!CHECKSUM_PATTERN.test(input.checksum) ||
		!checksum.success
	) {
		throw new WorkloadStagingError("WORKLOAD_STAGING_INVALID");
	}
	return checksum.value.digest;
}

async function ownerHash(publisherDid: string): Promise<string> {
	return base64url.encode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(publisherDid))),
	);
}

async function stagingKey(input: WorkloadArtifactIdentity): Promise<string> {
	return `workload/${await ownerHash(input.publisherDid)}/${input.workloadDigest}/${input.packageSlug}/${input.version}/${slotKey(input.slot)}`;
}

function metadataMatches(
	object: R2Object,
	input: WorkloadArtifactIdentity & { contentType?: string; contentLength?: number },
	digest: Uint8Array,
): boolean {
	const metadata = object.customMetadata;
	const storedDigest = object.checksums.sha256;
	return (
		metadata?.["workloadDigest"] === input.workloadDigest &&
		metadata["packageSlug"] === input.packageSlug &&
		metadata["version"] === input.version &&
		metadata["slot"] === input.slot &&
		metadata["checksum"] === input.checksum &&
		(input.contentType === undefined || object.httpMetadata?.contentType === input.contentType) &&
		(input.contentLength === undefined || object.size === input.contentLength) &&
		storedDigest !== undefined &&
		compareDigestBytes(new Uint8Array(storedDigest), digest)
	);
}

async function readBoundedBody(
	body: ReadableStream<Uint8Array>,
	expectedLength: number,
): Promise<Uint8Array> {
	const bytes = new Uint8Array(expectedLength);
	const reader = body.getReader();
	let offset = 0;
	try {
		for (;;) {
			const chunk = await reader.read();
			if (chunk.done) break;
			if (offset + chunk.value.byteLength > expectedLength) {
				throw new WorkloadStagingError("WORKLOAD_STAGING_SIZE_MISMATCH");
			}
			bytes.set(chunk.value, offset);
			offset += chunk.value.byteLength;
		}
	} finally {
		reader.releaseLock();
	}
	if (offset !== expectedLength) {
		throw new WorkloadStagingError("WORKLOAD_STAGING_SIZE_MISMATCH");
	}
	return bytes;
}

export async function persistWorkloadStagedArtifact(
	bucket: R2Bucket,
	input: PersistWorkloadArtifactInput,
): Promise<{ key: string; replayed: boolean }> {
	const checksumDigest = validateIdentity(input);
	if (
		!validContentType(input.slot, input.contentType) ||
		!Number.isSafeInteger(input.contentLength) ||
		input.contentLength < 1 ||
		input.contentLength > maxBytes(input.slot) ||
		!(input.body instanceof ReadableStream)
	) {
		throw new WorkloadStagingError("WORKLOAD_STAGING_INVALID");
	}
	const key = await stagingKey(input);
	const bytes = await readBoundedBody(input.body, input.contentLength);
	let created = false;
	try {
		const object = await bucket.put(key, bytes, {
			onlyIf: { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: input.contentType },
			customMetadata: {
				workloadDigest: input.workloadDigest,
				packageSlug: input.packageSlug,
				version: input.version,
				slot: input.slot,
				checksum: input.checksum,
			},
			sha256: checksumDigest,
		});
		if (!object) {
			const existing = await bucket.head(key);
			if (!existing || !metadataMatches(existing, input, checksumDigest)) {
				throw new WorkloadStagingError("WORKLOAD_STAGING_CONFLICT");
			}
			return { key, replayed: true };
		}
		created = true;
		if (!metadataMatches(object, input, checksumDigest)) {
			throw new WorkloadStagingError("WORKLOAD_STAGING_SIZE_MISMATCH");
		}
		return { key, replayed: false };
	} catch (error) {
		if (created) await bucket.delete(key);
		if (error instanceof WorkloadStagingError) throw error;
		throw new WorkloadStagingError("WORKLOAD_STAGING_WRITE_FAILED");
	}
}

export async function loadWorkloadStagedArtifact(
	bucket: R2Bucket,
	input: WorkloadArtifactIdentity,
): Promise<WorkloadStagedArtifact> {
	const checksumDigest = validateIdentity(input);
	const key = await stagingKey(input);
	const object = await bucket.get(key, { range: { offset: 0, length: maxBytes(input.slot) + 1 } });
	if (!object) throw new WorkloadStagingError("WORKLOAD_STAGING_MISSING");
	if (!metadataMatches(object, input, checksumDigest) || object.size > maxBytes(input.slot)) {
		throw new WorkloadStagingError("WORKLOAD_STAGING_CONFLICT");
	}
	const bytes = await object.bytes();
	if (bytes.byteLength !== object.size) {
		throw new WorkloadStagingError("WORKLOAD_STAGING_SIZE_MISMATCH");
	}
	const verified = await verifyMultihash(bytes, input.checksum);
	if (!verified.success) {
		throw new WorkloadStagingError("WORKLOAD_STAGING_CHECKSUM_MISMATCH");
	}
	const contentType = object.httpMetadata?.contentType;
	if (!contentType || !validContentType(input.slot, contentType)) {
		throw new WorkloadStagingError("WORKLOAD_STAGING_CONFLICT");
	}
	return { key, slot: input.slot, checksum: input.checksum, contentType, size: object.size, bytes };
}

export async function deleteWorkloadStagedArtifacts(
	bucket: R2Bucket,
	artifacts: readonly WorkloadArtifactIdentity[],
): Promise<void> {
	const keys = await Promise.all(
		artifacts.map((artifact) => {
			validateIdentity(artifact);
			return stagingKey(artifact);
		}),
	);
	if (keys.length > 0) await bucket.delete(keys);
}

function isUri(value: string): value is `${string}:${string}` {
	return value.indexOf(":") > 0;
}

export function workloadArtifactSourceUrl(
	publicOrigin: string,
	slot: WorkloadArtifactSlot,
	checksum: string,
): `${string}:${string}` {
	const path = slot === "provenance" ? "provenance" : `staged-artifacts/${slotKey(slot)}`;
	const result = `${publicOrigin}/v1/${path}/${checksum}`;
	if (!isUri(result)) throw new WorkloadStagingError("WORKLOAD_STAGING_INVALID");
	return result;
}

export async function promoteWorkloadProvenance(
	stagingBucket: R2Bucket,
	provenanceBucket: R2Bucket,
	input: Omit<WorkloadArtifactIdentity, "slot">,
): Promise<{ key: string; replayed: boolean }> {
	const staged = await loadWorkloadStagedArtifact(stagingBucket, { ...input, slot: "provenance" });
	const checksum = decodeMultihash(input.checksum);
	if (!checksum.success) throw new WorkloadStagingError("WORKLOAD_STAGING_INVALID");
	const key = `provenance/${input.checksum}`;
	const created = await provenanceBucket.put(key, staged.bytes, {
		onlyIf: { etagDoesNotMatch: "*" },
		httpMetadata: {
			contentType: staged.contentType,
			cacheControl: "public, max-age=31536000, immutable",
		},
		customMetadata: { checksum: input.checksum, published: "true" },
		sha256: checksum.value.digest,
	});
	if (created) return { key, replayed: false };
	const existing = await provenanceBucket.head(key);
	if (
		!existing ||
		existing.customMetadata?.["checksum"] !== input.checksum ||
		existing.customMetadata["published"] !== "true" ||
		existing.size !== staged.size ||
		existing.httpMetadata?.contentType !== staged.contentType ||
		existing.checksums.sha256 === undefined ||
		!compareDigestBytes(new Uint8Array(existing.checksums.sha256), checksum.value.digest)
	) {
		throw new WorkloadStagingError("WORKLOAD_STAGING_CONFLICT");
	}
	return { key, replayed: true };
}
