import { safeParse } from "@atcute/lexicons";
import { isBlob, type Blob } from "@atcute/lexicons/interfaces";
import { PackageRelease } from "@emdash-cms/registry-lexicons";
import {
	DEFAULT_FETCH_LIMITS,
	fetchVerifiedResource,
	multihashFromBlobCid,
	verifyMultihash,
	type FetchImplementation,
	type HostnameResolver,
	type VerificationErrorCode,
} from "@emdash-cms/registry-verification";

const PACKAGE_MAX_BYTES = 256 * 1024;
const IMAGE_MAX_BYTES = 1024 * 1024;
const GENERIC_BINARY_MIME = "application/octet-stream";
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;

export type ArtifactMaterializationPath = "package" | "icon" | "banner" | `screenshots[${number}]`;

export type ArtifactMaterializationErrorCode =
	| VerificationErrorCode
	| "ARTIFACT_BLOB_INVALID"
	| "ARTIFACT_MIME_INVALID"
	| "ARTIFACT_OPTIONS_INVALID"
	| "ARTIFACT_SOURCE_UNVERIFIABLE"
	| "ARTIFACT_UPLOAD_FAILED"
	| "RELEASE_INVALID";

export class ArtifactMaterializationError extends Error {
	readonly code: ArtifactMaterializationErrorCode;
	readonly artifact: ArtifactMaterializationPath | null;

	constructor(
		code: ArtifactMaterializationErrorCode,
		artifact: ArtifactMaterializationPath | null,
	) {
		super(code);
		this.name = "ArtifactMaterializationError";
		this.code = code;
		this.artifact = artifact;
	}
}

export type ArtifactBlobUploader = (bytes: Uint8Array, mimeType: string) => Promise<Blob>;

export interface MaterializeReleaseArtifactsOptions {
	fetch: FetchImplementation;
	resolveHostname: HostnameResolver;
	uploadBlob: ArtifactBlobUploader;
	allowHttpLocalhost?: boolean;
	headerTimeoutMs?: number;
	totalTimeoutMs?: number;
	maxRedirects?: number;
}

type ArtifactDescriptor = PackageRelease.Artifact | PackageRelease.ImageArtifact;

interface PreparedArtifact<T extends ArtifactDescriptor = ArtifactDescriptor> {
	path: ArtifactMaterializationPath;
	descriptor: T;
	bytes: Uint8Array;
	mimeType: string;
	maxBytes: number;
}

function hasPrefix(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
	return expected.every((value, index) => bytes[offset + index] === value);
}

function detectedMimeType(path: ArtifactMaterializationPath, bytes: Uint8Array): string | null {
	if (path === "package") {
		return hasPrefix(bytes, [0x1f, 0x8b]) ? "application/gzip" : null;
	}
	if (hasPrefix(bytes, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) {
		return "image/png";
	}
	if (hasPrefix(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
	if (hasPrefix(bytes, [0x52, 0x49, 0x46, 0x46]) && hasPrefix(bytes, [0x57, 0x45, 0x42, 0x50], 8)) {
		return "image/webp";
	}
	return null;
}

function responseMimeType(headers: Headers): string | null {
	const raw = headers.get("content-type");
	if (raw === null) return null;
	const value = raw.split(";", 1)[0]?.trim().toLowerCase();
	return value && MIME_TYPE_PATTERN.test(value) ? value : null;
}

function fetchImplementation(
	descriptor: ArtifactDescriptor,
	options: MaterializeReleaseArtifactsOptions,
): FetchImplementation {
	return (url, init) => {
		if (descriptor.releaseAsset !== true) return options.fetch(url, init);
		const headers = new Headers(init.headers);
		headers.set("accept", GENERIC_BINARY_MIME);
		return options.fetch(url, { ...init, headers });
	};
}

async function prepareArtifact<T extends ArtifactDescriptor>(
	path: ArtifactMaterializationPath,
	descriptor: T,
	maxBytes: number,
	deadline: number,
	options: MaterializeReleaseArtifactsOptions,
): Promise<PreparedArtifact<T>> {
	if (descriptor.requiresAuth === true) {
		throw new ArtifactMaterializationError("AUTH_METHOD_UNSUPPORTED", path);
	}
	if (!descriptor.url) {
		throw new ArtifactMaterializationError("ARTIFACT_SOURCE_UNVERIFIABLE", path);
	}
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new ArtifactMaterializationError("RESOURCE_TIMEOUT", path);
	const fetched = await fetchVerifiedResource(descriptor.url, {
		fetch: fetchImplementation(descriptor, options),
		resolveHostname: options.resolveHostname,
		...(options.allowHttpLocalhost === undefined
			? {}
			: { allowHttpLocalhost: options.allowHttpLocalhost }),
		...(options.headerTimeoutMs === undefined ? {} : { headerTimeoutMs: options.headerTimeoutMs }),
		totalTimeoutMs: remaining,
		maxBytes,
		...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
	});
	if (!fetched.success) {
		throw new ArtifactMaterializationError(fetched.error.code, path);
	}
	const bytes = new Uint8Array(fetched.value.bytes);
	const verified = await verifyMultihash(bytes, descriptor.checksum);
	if (!verified.success) {
		throw new ArtifactMaterializationError(verified.error.code, path);
	}
	const mimeType = detectedMimeType(path, bytes);
	if (!mimeType) throw new ArtifactMaterializationError("ARTIFACT_MIME_INVALID", path);
	if (descriptor.contentType && descriptor.contentType.trim().toLowerCase() !== mimeType) {
		throw new ArtifactMaterializationError("ARTIFACT_MIME_INVALID", path);
	}
	const responseMime = responseMimeType(fetched.value.headers);
	if (responseMime && responseMime !== GENERIC_BINARY_MIME && responseMime !== mimeType) {
		throw new ArtifactMaterializationError("ARTIFACT_MIME_INVALID", path);
	}
	return { path, descriptor, bytes, mimeType, maxBytes };
}

async function uploadArtifact(
	prepared: PreparedArtifact,
	uploadBlob: ArtifactBlobUploader,
): Promise<Blob> {
	let uploaded: Blob;
	try {
		uploaded = await uploadBlob(new Uint8Array(prepared.bytes), prepared.mimeType);
	} catch {
		throw new ArtifactMaterializationError("ARTIFACT_UPLOAD_FAILED", prepared.path);
	}
	if (
		!isBlob(uploaded) ||
		uploaded.size !== prepared.bytes.byteLength ||
		uploaded.size < 0 ||
		uploaded.size > prepared.maxBytes ||
		uploaded.mimeType !== prepared.mimeType ||
		typeof uploaded.ref.$link !== "string"
	) {
		throw new ArtifactMaterializationError("ARTIFACT_BLOB_INVALID", prepared.path);
	}
	const uploadedChecksum = multihashFromBlobCid(uploaded.ref.$link);
	if (!uploadedChecksum.success || uploadedChecksum.value !== prepared.descriptor.checksum) {
		throw new ArtifactMaterializationError("ARTIFACT_BLOB_INVALID", prepared.path);
	}
	return {
		$type: "blob",
		ref: { $link: uploaded.ref.$link },
		mimeType: uploaded.mimeType,
		size: uploaded.size,
	};
}

function withBlob<T extends ArtifactDescriptor>(descriptor: T, blob: Blob): T {
	const result = structuredClone(descriptor);
	delete result.url;
	delete result.requiresAuth;
	delete result.releaseAsset;
	result.blob = blob;
	return result;
}

function requireUploaded(
	uploaded: ReadonlyMap<ArtifactMaterializationPath, Blob>,
	path: ArtifactMaterializationPath,
): Blob {
	const blob = uploaded.get(path);
	if (!blob) throw new ArtifactMaterializationError("ARTIFACT_BLOB_INVALID", path);
	return blob;
}

export async function materializeReleaseArtifacts(
	release: PackageRelease.Main,
	options: MaterializeReleaseArtifactsOptions,
): Promise<PackageRelease.Main> {
	let snapshot: unknown;
	try {
		snapshot = structuredClone(release);
	} catch {
		throw new ArtifactMaterializationError("RELEASE_INVALID", null);
	}
	const parsed = safeParse(PackageRelease.mainSchema, snapshot, { strict: true });
	if (!parsed.ok) throw new ArtifactMaterializationError("RELEASE_INVALID", null);
	const timeout = options.totalTimeoutMs ?? DEFAULT_FETCH_LIMITS.totalTimeoutMs;
	if (
		!Number.isSafeInteger(timeout) ||
		timeout <= 0 ||
		Date.now() > Number.MAX_SAFE_INTEGER - timeout
	) {
		throw new ArtifactMaterializationError("ARTIFACT_OPTIONS_INVALID", null);
	}
	const deadline = Date.now() + timeout;
	const prepared: PreparedArtifact[] = [
		await prepareArtifact(
			"package",
			parsed.value.artifacts.package,
			PACKAGE_MAX_BYTES,
			deadline,
			options,
		),
	];
	if (parsed.value.artifacts.icon) {
		prepared.push(
			await prepareArtifact(
				"icon",
				parsed.value.artifacts.icon,
				IMAGE_MAX_BYTES,
				deadline,
				options,
			),
		);
	}
	if (parsed.value.artifacts.banner) {
		prepared.push(
			await prepareArtifact(
				"banner",
				parsed.value.artifacts.banner,
				IMAGE_MAX_BYTES,
				deadline,
				options,
			),
		);
	}
	for (const [index, screenshot] of (parsed.value.artifacts.screenshots ?? []).entries()) {
		prepared.push(
			await prepareArtifact(
				`screenshots[${index}]`,
				screenshot,
				IMAGE_MAX_BYTES,
				deadline,
				options,
			),
		);
	}

	const uploaded = new Map<ArtifactMaterializationPath, Blob>();
	for (const artifact of prepared) {
		uploaded.set(artifact.path, await uploadArtifact(artifact, options.uploadBlob));
	}
	const result = structuredClone(parsed.value);
	result.artifacts.package = withBlob(
		result.artifacts.package,
		requireUploaded(uploaded, "package"),
	);
	if (result.artifacts.icon) {
		result.artifacts.icon = withBlob(result.artifacts.icon, requireUploaded(uploaded, "icon"));
	}
	if (result.artifacts.banner) {
		result.artifacts.banner = withBlob(
			result.artifacts.banner,
			requireUploaded(uploaded, "banner"),
		);
	}
	if (result.artifacts.screenshots) {
		result.artifacts.screenshots = result.artifacts.screenshots.map((screenshot, index) =>
			withBlob(screenshot, requireUploaded(uploaded, `screenshots[${index}]`)),
		);
	}
	const output = safeParse(PackageRelease.mainSchema, result, { strict: true });
	if (!output.ok) throw new ArtifactMaterializationError("RELEASE_INVALID", null);
	return output.value;
}
