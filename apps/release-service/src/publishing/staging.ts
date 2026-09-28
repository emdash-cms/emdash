import { verifyMultihash } from "@emdash-cms/registry-verification/checksum";
import { base64url } from "jose";

import type { StagedArtifactMetadata, StagedReleaseArtifact } from "./materialize.js";

const DID_PATTERN = /^did:[a-z0-9]+:[A-Za-z0-9._:%-]+$/;
const ULID_PATTERN = /^[0-9A-HJKMNP-TV-Z]{26}$/;
const CHECKSUM_PATTERN = /^b[a-z2-7]{10,255}$/;
const DIGEST_PATTERN = /^[-A-Za-z0-9_]{43}$/;
const SLOT_PATTERN = /^(?:package|icon|banner|screenshots\[[0-7]\])$/;
const MAX_STAGED_BYTES = 1024 * 1024;

export interface PersistedStagedArtifact {
	key: string;
	metadata: StagedArtifactMetadata;
	sourceUrlDigest: string;
}

export class PublicationStagingError extends Error {
	readonly code:
		| "PUBLICATION_STAGING_CONFLICT"
		| "PUBLICATION_STAGING_CORRUPT"
		| "PUBLICATION_STAGING_INVALID"
		| "PUBLICATION_STAGING_MISSING"
		| "PUBLICATION_STAGING_WRITE_FAILED";

	constructor(code: PublicationStagingError["code"]) {
		super(code);
		this.name = "PublicationStagingError";
		this.code = code;
	}
}

async function digest(value: string): Promise<string> {
	return base64url.encode(
		new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value))),
	);
}

function validMetadata(metadata: StagedArtifactMetadata): boolean {
	return (
		SLOT_PATTERN.test(metadata.path) &&
		CHECKSUM_PATTERN.test(metadata.checksum) &&
		typeof metadata.mimeType === "string" &&
		metadata.mimeType.length >= 3 &&
		metadata.mimeType.length <= 128 &&
		Number.isSafeInteger(metadata.size) &&
		metadata.size >= 1 &&
		metadata.size <= MAX_STAGED_BYTES &&
		((metadata.width === undefined && metadata.height === undefined) ||
			(Number.isSafeInteger(metadata.width) &&
				Number.isSafeInteger(metadata.height) &&
				(metadata.width ?? 0) >= 1 &&
				(metadata.width ?? 0) <= 8192 &&
				(metadata.height ?? 0) >= 1 &&
				(metadata.height ?? 0) <= 8192))
	);
}

function keySlot(path: StagedArtifactMetadata["path"]): string {
	return path.startsWith("screenshots[") ? path.replaceAll("[", "-").replaceAll("]", "") : path;
}

async function readAndVerify(
	object: R2ObjectBody,
	metadata: StagedArtifactMetadata,
): Promise<Uint8Array> {
	if (object.size !== metadata.size || object.size > MAX_STAGED_BYTES) {
		throw new PublicationStagingError("PUBLICATION_STAGING_CORRUPT");
	}
	const bytes = new Uint8Array(await object.arrayBuffer());
	if (
		bytes.byteLength !== metadata.size ||
		!(await verifyMultihash(bytes, metadata.checksum)).success
	) {
		throw new PublicationStagingError("PUBLICATION_STAGING_CORRUPT");
	}
	return bytes;
}

async function existingMatches(
	bucket: R2Bucket,
	key: string,
	metadata: StagedArtifactMetadata,
): Promise<boolean> {
	const existing = await bucket.get(key);
	if (!existing) return false;
	try {
		await readAndVerify(existing, metadata);
		return true;
	} catch (error) {
		if (error instanceof PublicationStagingError) return false;
		throw error;
	}
}

export async function persistStagedArtifact(
	bucket: R2Bucket,
	input: {
		publisherDid: string;
		intentId: string;
		sourceUrl: string;
		artifact: StagedReleaseArtifact;
	},
): Promise<PersistedStagedArtifact> {
	if (
		!DID_PATTERN.test(input.publisherDid) ||
		!ULID_PATTERN.test(input.intentId) ||
		typeof input.sourceUrl !== "string" ||
		input.sourceUrl.length < 1 ||
		input.sourceUrl.length > 2048 ||
		!validMetadata(input.artifact.metadata) ||
		input.artifact.bytes.byteLength !== input.artifact.metadata.size
	) {
		throw new PublicationStagingError("PUBLICATION_STAGING_INVALID");
	}
	const sourceUrlDigest = await digest(input.sourceUrl);
	const ownerHash = await digest(input.publisherDid);
	const key = `publication/${ownerHash}/${input.intentId}/${keySlot(input.artifact.metadata.path)}/${input.artifact.metadata.checksum}`;
	try {
		const created = await bucket.put(key, input.artifact.bytes, {
			onlyIf: { etagDoesNotMatch: "*" },
			httpMetadata: { contentType: input.artifact.metadata.mimeType },
			customMetadata: {
				checksum: input.artifact.metadata.checksum,
				sourceUrlDigest,
			},
		});
		if (!created && !(await existingMatches(bucket, key, input.artifact.metadata))) {
			throw new PublicationStagingError("PUBLICATION_STAGING_CONFLICT");
		}
	} catch (error) {
		if (error instanceof PublicationStagingError) throw error;
		if (!(await existingMatches(bucket, key, input.artifact.metadata))) {
			throw new PublicationStagingError("PUBLICATION_STAGING_WRITE_FAILED");
		}
	}
	return {
		key,
		metadata: structuredClone(input.artifact.metadata),
		sourceUrlDigest,
	};
}

export async function loadStagedArtifact(
	bucket: R2Bucket,
	staged: PersistedStagedArtifact,
): Promise<StagedReleaseArtifact> {
	if (
		typeof staged.key !== "string" ||
		!staged.key.startsWith("publication/") ||
		!validMetadata(staged.metadata) ||
		!DIGEST_PATTERN.test(staged.sourceUrlDigest)
	) {
		throw new PublicationStagingError("PUBLICATION_STAGING_INVALID");
	}
	const object = await bucket.get(staged.key);
	if (!object) throw new PublicationStagingError("PUBLICATION_STAGING_MISSING");
	return {
		metadata: structuredClone(staged.metadata),
		bytes: await readAndVerify(object, staged.metadata),
	};
}

export async function deleteStagedArtifacts(
	bucket: R2Bucket,
	artifacts: readonly PersistedStagedArtifact[],
): Promise<void> {
	const keys = artifacts.map((artifact) => artifact.key);
	if (keys.length > 0) await bucket.delete(keys);
}
