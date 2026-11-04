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

import { readImageDimensions, type ImageMimeType } from "./image-metadata.js";

const MATERIALIZATION_PLAN_VERSION = 1;
const PACKAGE_MAX_BYTES = 256 * 1024;
const IMAGE_MAX_BYTES = 1024 * 1024;
const IMAGE_MAX_DIMENSION = 8192;
const GENERIC_BINARY_MIME = "application/octet-stream";
const MIME_TYPE_PATTERN = /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/;
const SCREENSHOT_PATH_PATTERN = /^screenshots\[([0-7])\]$/;
const IMAGE_MIME_TYPES = new Set<string>(["image/png", "image/jpeg", "image/webp"]);

export type ArtifactMaterializationPath = "package" | "icon" | "banner" | `screenshots[${number}]`;

export type ArtifactMaterializationErrorCode =
	| VerificationErrorCode
	| "ARTIFACT_BLOB_INVALID"
	| "ARTIFACT_DIMENSIONS_INVALID"
	| "ARTIFACT_MIME_INVALID"
	| "ARTIFACT_OPTIONS_INVALID"
	| "ARTIFACT_RECEIPTS_INVALID"
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

export interface StageReleaseArtifactsOptions {
	fetch: FetchImplementation;
	resolveHostname: HostnameResolver;
	loadSource?: (input: {
		path: ArtifactMaterializationPath;
		url: string;
		checksum: string;
	}) => Promise<{ bytes: Uint8Array; contentType: string } | null>;
	allowHttpLocalhost?: boolean;
	headerTimeoutMs?: number;
	totalTimeoutMs?: number;
	maxRedirects?: number;
}

export interface MaterializeReleaseArtifactsOptions extends StageReleaseArtifactsOptions {
	uploadBlob: ArtifactBlobUploader;
}

export interface StagedArtifactMetadata {
	path: ArtifactMaterializationPath;
	checksum: string;
	mimeType: string;
	size: number;
	width?: number;
	height?: number;
}

export interface StagedReleaseArtifact {
	metadata: StagedArtifactMetadata;
	bytes: Uint8Array;
}

export interface ReleaseArtifactMaterializationPlan {
	version: 1;
	release: PackageRelease.Main;
	artifacts: readonly StagedArtifactMetadata[];
}

export interface StagedReleaseArtifacts {
	plan: ReleaseArtifactMaterializationPlan;
	artifacts: readonly StagedReleaseArtifact[];
}

export interface ArtifactUploadReceipt {
	path: ArtifactMaterializationPath;
	checksum: string;
	blob: Blob;
}

type ArtifactDescriptor = PackageRelease.Artifact | PackageRelease.ImageArtifact;

function hasPrefix(bytes: Uint8Array, expected: readonly number[], offset = 0): boolean {
	return expected.every((value, index) => bytes[offset + index] === value);
}

function detectedMimeType(
	path: ArtifactMaterializationPath,
	bytes: Uint8Array,
): "application/gzip" | ImageMimeType | null {
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

function maxBytesForPath(path: ArtifactMaterializationPath): number {
	return path === "package" ? PACKAGE_MAX_BYTES : IMAGE_MAX_BYTES;
}

function isImageMimeType(value: string): value is ImageMimeType {
	return IMAGE_MIME_TYPES.has(value);
}

function isMaterializationPath(value: unknown): value is ArtifactMaterializationPath {
	return (
		value === "package" ||
		value === "icon" ||
		value === "banner" ||
		(typeof value === "string" && SCREENSHOT_PATH_PATTERN.test(value))
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function validMetadata(value: unknown): value is StagedArtifactMetadata {
	if (!isRecord(value) || !isMaterializationPath(value["path"])) return false;
	const path = value["path"];
	const width = value["width"];
	const height = value["height"];
	const dimensionsValid =
		path === "package"
			? width === undefined && height === undefined
			: Number.isSafeInteger(width) &&
				Number.isSafeInteger(height) &&
				Number(width) > 0 &&
				Number(width) <= IMAGE_MAX_DIMENSION &&
				Number(height) > 0 &&
				Number(height) <= IMAGE_MAX_DIMENSION;
	return (
		typeof value["checksum"] === "string" &&
		value["checksum"].length > 0 &&
		value["checksum"].length <= 256 &&
		typeof value["mimeType"] === "string" &&
		(path === "package"
			? value["mimeType"] === "application/gzip"
			: IMAGE_MIME_TYPES.has(value["mimeType"])) &&
		Number.isSafeInteger(value["size"]) &&
		Number(value["size"]) > 0 &&
		Number(value["size"]) <= maxBytesForPath(path) &&
		dimensionsValid
	);
}

function fetchImplementation(
	descriptor: ArtifactDescriptor,
	options: StageReleaseArtifactsOptions,
): FetchImplementation {
	return (url, init) => {
		if (descriptor.releaseAsset !== true) return options.fetch(url, init);
		const headers = new Headers(init.headers);
		headers.set("accept", GENERIC_BINARY_MIME);
		return options.fetch(url, { ...init, headers });
	};
}

async function stageArtifact<T extends ArtifactDescriptor>(
	path: ArtifactMaterializationPath,
	descriptor: T,
	deadline: number,
	options: StageReleaseArtifactsOptions,
): Promise<StagedReleaseArtifact> {
	if (descriptor.requiresAuth === true) {
		throw new ArtifactMaterializationError("AUTH_METHOD_UNSUPPORTED", path);
	}
	if (!descriptor.url) {
		throw new ArtifactMaterializationError("ARTIFACT_SOURCE_UNVERIFIABLE", path);
	}
	const remaining = deadline - Date.now();
	if (remaining <= 0) throw new ArtifactMaterializationError("RESOURCE_TIMEOUT", path);
	const maxBytes = maxBytesForPath(path);
	const loadedSource = await options.loadSource?.({
		path,
		url: descriptor.url,
		checksum: descriptor.checksum,
	});
	let bytes: Uint8Array;
	let responseMime: string | null;
	if (loadedSource) {
		bytes = new Uint8Array(loadedSource.bytes);
		if (bytes.byteLength < 1 || bytes.byteLength > maxBytes) {
			throw new ArtifactMaterializationError("RESOURCE_SIZE_EXCEEDED", path);
		}
		responseMime = loadedSource.contentType;
	} else {
		const fetched = await fetchVerifiedResource(descriptor.url, {
			fetch: fetchImplementation(descriptor, options),
			resolveHostname: options.resolveHostname,
			...(options.allowHttpLocalhost === undefined
				? {}
				: { allowHttpLocalhost: options.allowHttpLocalhost }),
			...(options.headerTimeoutMs === undefined
				? {}
				: { headerTimeoutMs: options.headerTimeoutMs }),
			totalTimeoutMs: remaining,
			maxBytes,
			...(options.maxRedirects === undefined ? {} : { maxRedirects: options.maxRedirects }),
		});
		if (!fetched.success) {
			throw new ArtifactMaterializationError(fetched.error.code, path);
		}
		bytes = new Uint8Array(fetched.value.bytes);
		responseMime = responseMimeType(fetched.value.headers);
	}
	const verified = await verifyMultihash(bytes, descriptor.checksum);
	if (!verified.success) {
		throw new ArtifactMaterializationError(verified.error.code, path);
	}
	const mimeType = detectedMimeType(path, bytes);
	if (!mimeType) throw new ArtifactMaterializationError("ARTIFACT_MIME_INVALID", path);
	if (descriptor.contentType && descriptor.contentType.trim().toLowerCase() !== mimeType) {
		throw new ArtifactMaterializationError("ARTIFACT_MIME_INVALID", path);
	}
	if (responseMime && responseMime !== GENERIC_BINARY_MIME && responseMime !== mimeType) {
		throw new ArtifactMaterializationError("ARTIFACT_MIME_INVALID", path);
	}
	if (path !== "package") {
		if (!isImageMimeType(mimeType)) {
			throw new ArtifactMaterializationError("ARTIFACT_MIME_INVALID", path);
		}
		const measured = readImageDimensions(bytes, mimeType);
		if (
			!measured ||
			measured.width > IMAGE_MAX_DIMENSION ||
			measured.height > IMAGE_MAX_DIMENSION ||
			("width" in descriptor &&
				descriptor.width !== undefined &&
				descriptor.width !== measured.width) ||
			("height" in descriptor &&
				descriptor.height !== undefined &&
				descriptor.height !== measured.height)
		) {
			throw new ArtifactMaterializationError("ARTIFACT_DIMENSIONS_INVALID", path);
		}
		return {
			metadata: {
				path,
				checksum: descriptor.checksum,
				mimeType,
				size: bytes.byteLength,
				width: measured.width,
				height: measured.height,
			},
			bytes,
		};
	}
	return {
		metadata: { path, checksum: descriptor.checksum, mimeType, size: bytes.byteLength },
		bytes,
	};
}

function withoutSources<T extends ArtifactDescriptor>(descriptor: T): T {
	const result = structuredClone(descriptor);
	delete result.url;
	delete result.blob;
	delete result.requiresAuth;
	delete result.releaseAsset;
	return result;
}

function materializationPaths(release: PackageRelease.Main): ArtifactMaterializationPath[] {
	return [
		"package",
		...(release.artifacts.icon ? (["icon"] as const) : []),
		...(release.artifacts.banner ? (["banner"] as const) : []),
		...(release.artifacts.screenshots ?? []).map((_, index) => `screenshots[${index}]` as const),
	];
}

function applyMeasuredDimensions(
	descriptor: PackageRelease.ImageArtifact,
	metadata: StagedArtifactMetadata | undefined,
): void {
	if (!metadata || metadata.width === undefined || metadata.height === undefined) {
		throw new ArtifactMaterializationError("ARTIFACT_DIMENSIONS_INVALID", metadata?.path ?? null);
	}
	descriptor.contentType = metadata.mimeType;
	descriptor.width = metadata.width;
	descriptor.height = metadata.height;
}

function releaseTemplate(
	release: PackageRelease.Main,
	artifacts: readonly StagedReleaseArtifact[],
): PackageRelease.Main {
	const result = structuredClone(release);
	const metadata = new Map(
		artifacts.map((artifact) => [artifact.metadata.path, artifact.metadata]),
	);
	result.artifacts.package = withoutSources(result.artifacts.package);
	const packageMetadata = metadata.get("package");
	if (!packageMetadata) {
		throw new ArtifactMaterializationError("ARTIFACT_MIME_INVALID", "package");
	}
	result.artifacts.package.contentType = packageMetadata.mimeType;
	if (result.artifacts.icon) {
		result.artifacts.icon = withoutSources(result.artifacts.icon);
		applyMeasuredDimensions(result.artifacts.icon, metadata.get("icon"));
	}
	if (result.artifacts.banner) {
		result.artifacts.banner = withoutSources(result.artifacts.banner);
		applyMeasuredDimensions(result.artifacts.banner, metadata.get("banner"));
	}
	if (result.artifacts.screenshots) {
		result.artifacts.screenshots = result.artifacts.screenshots.map((screenshot, index) => {
			const descriptor = withoutSources(screenshot);
			applyMeasuredDimensions(descriptor, metadata.get(`screenshots[${index}]`));
			return descriptor;
		});
	}
	return result;
}

export async function stageReleaseArtifacts(
	release: PackageRelease.Main,
	options: StageReleaseArtifactsOptions,
): Promise<StagedReleaseArtifacts> {
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
	const artifacts: StagedReleaseArtifact[] = [
		await stageArtifact("package", parsed.value.artifacts.package, deadline, options),
	];
	if (parsed.value.artifacts.icon) {
		artifacts.push(await stageArtifact("icon", parsed.value.artifacts.icon, deadline, options));
	}
	if (parsed.value.artifacts.banner) {
		artifacts.push(await stageArtifact("banner", parsed.value.artifacts.banner, deadline, options));
	}
	for (const [index, screenshot] of (parsed.value.artifacts.screenshots ?? []).entries()) {
		artifacts.push(await stageArtifact(`screenshots[${index}]`, screenshot, deadline, options));
	}
	const template = releaseTemplate(parsed.value, artifacts);
	const validTemplate = safeParse(PackageRelease.mainSchema, template, { strict: true });
	if (!validTemplate.ok) throw new ArtifactMaterializationError("RELEASE_INVALID", null);
	return {
		plan: {
			version: MATERIALIZATION_PLAN_VERSION,
			release: validTemplate.value,
			artifacts: artifacts.map(({ metadata }) => ({ ...metadata })),
		},
		artifacts,
	};
}

export function validateArtifactUploadReceipt(
	metadata: StagedArtifactMetadata,
	uploaded: unknown,
): ArtifactUploadReceipt {
	if (
		!validMetadata(metadata) ||
		!isBlob(uploaded) ||
		uploaded.size !== metadata.size ||
		uploaded.mimeType !== metadata.mimeType ||
		typeof uploaded.ref.$link !== "string"
	) {
		throw new ArtifactMaterializationError("ARTIFACT_BLOB_INVALID", metadata.path);
	}
	const uploadedChecksum = multihashFromBlobCid(uploaded.ref.$link);
	if (!uploadedChecksum.success || uploadedChecksum.value !== metadata.checksum) {
		throw new ArtifactMaterializationError("ARTIFACT_BLOB_INVALID", metadata.path);
	}
	return {
		path: metadata.path,
		checksum: metadata.checksum,
		blob: {
			$type: "blob",
			ref: { $link: uploaded.ref.$link },
			mimeType: uploaded.mimeType,
			size: uploaded.size,
		},
	};
}

export async function uploadStagedArtifact(
	artifact: StagedReleaseArtifact,
	uploadBlob: ArtifactBlobUploader,
): Promise<ArtifactUploadReceipt> {
	let uploaded: unknown;
	try {
		uploaded = await uploadBlob(new Uint8Array(artifact.bytes), artifact.metadata.mimeType);
	} catch {
		throw new ArtifactMaterializationError("ARTIFACT_UPLOAD_FAILED", artifact.metadata.path);
	}
	return validateArtifactUploadReceipt(artifact.metadata, uploaded);
}

function withBlob<T extends ArtifactDescriptor>(descriptor: T, blob: Blob): T {
	const result = withoutSources(descriptor);
	result.blob = blob;
	return result;
}

function sourcesAbsent(descriptor: ArtifactDescriptor): boolean {
	return (
		!Object.hasOwn(descriptor, "url") &&
		!Object.hasOwn(descriptor, "blob") &&
		!Object.hasOwn(descriptor, "requiresAuth") &&
		!Object.hasOwn(descriptor, "releaseAsset")
	);
}

function templateDescriptors(release: PackageRelease.Main): ArtifactDescriptor[] {
	return [
		release.artifacts.package,
		...(release.artifacts.icon ? [release.artifacts.icon] : []),
		...(release.artifacts.banner ? [release.artifacts.banner] : []),
		...(release.artifacts.screenshots ?? []),
	];
}

function dimensionsMatch(
	path: ArtifactMaterializationPath,
	descriptor: ArtifactDescriptor,
	metadata: StagedArtifactMetadata,
): boolean {
	if (path === "package") {
		return metadata.width === undefined && metadata.height === undefined;
	}
	return (
		"width" in descriptor &&
		"height" in descriptor &&
		descriptor.width === metadata.width &&
		descriptor.height === metadata.height
	);
}

export function buildMaterializedRelease(
	plan: unknown,
	receipts: readonly ArtifactUploadReceipt[],
): PackageRelease.Main {
	let snapshot: unknown;
	try {
		snapshot = structuredClone(plan);
	} catch {
		throw new ArtifactMaterializationError("RELEASE_INVALID", null);
	}
	if (
		!isRecord(snapshot) ||
		snapshot["version"] !== MATERIALIZATION_PLAN_VERSION ||
		!Array.isArray(snapshot["artifacts"])
	) {
		throw new ArtifactMaterializationError("RELEASE_INVALID", null);
	}
	const parsed = safeParse(PackageRelease.mainSchema, snapshot["release"], { strict: true });
	if (!parsed.ok) throw new ArtifactMaterializationError("RELEASE_INVALID", null);
	const artifactMetadata = snapshot["artifacts"];
	const paths = materializationPaths(parsed.value);
	const descriptors = templateDescriptors(parsed.value);
	if (
		paths.length !== descriptors.length ||
		paths.length !== artifactMetadata.length ||
		paths.length !== receipts.length ||
		descriptors.some((descriptor) => !sourcesAbsent(descriptor))
	) {
		throw new ArtifactMaterializationError("ARTIFACT_RECEIPTS_INVALID", null);
	}
	const blobs = new Map<ArtifactMaterializationPath, Blob>();
	for (const [index, path] of paths.entries()) {
		const descriptor = descriptors[index];
		const metadata = artifactMetadata[index];
		const receipt = receipts[index];
		if (
			!descriptor ||
			!validMetadata(metadata) ||
			!receipt ||
			metadata.path !== path ||
			metadata.checksum !== descriptor.checksum ||
			!dimensionsMatch(path, descriptor, metadata) ||
			(descriptor.contentType !== undefined &&
				descriptor.contentType.trim().toLowerCase() !== metadata.mimeType) ||
			receipt.path !== path ||
			receipt.checksum !== metadata.checksum
		) {
			throw new ArtifactMaterializationError("ARTIFACT_RECEIPTS_INVALID", path);
		}
		const validated = validateArtifactUploadReceipt(metadata, receipt.blob);
		blobs.set(path, validated.blob);
	}
	const result = structuredClone(parsed.value);
	const blobForPath = (path: ArtifactMaterializationPath): Blob => {
		const blob = blobs.get(path);
		if (!blob) throw new ArtifactMaterializationError("ARTIFACT_RECEIPTS_INVALID", path);
		return blob;
	};
	result.artifacts.package = withBlob(result.artifacts.package, blobForPath("package"));
	if (result.artifacts.icon) {
		result.artifacts.icon = withBlob(result.artifacts.icon, blobForPath("icon"));
	}
	if (result.artifacts.banner) {
		result.artifacts.banner = withBlob(result.artifacts.banner, blobForPath("banner"));
	}
	if (result.artifacts.screenshots) {
		result.artifacts.screenshots = result.artifacts.screenshots.map((screenshot, index) =>
			withBlob(screenshot, blobForPath(`screenshots[${index}]`)),
		);
	}
	const output = safeParse(PackageRelease.mainSchema, result, { strict: true });
	if (!output.ok) throw new ArtifactMaterializationError("RELEASE_INVALID", null);
	return output.value;
}

export async function materializeReleaseArtifacts(
	release: PackageRelease.Main,
	options: MaterializeReleaseArtifactsOptions,
): Promise<PackageRelease.Main> {
	const staged = await stageReleaseArtifacts(release, options);
	const receipts: ArtifactUploadReceipt[] = [];
	for (const artifact of staged.artifacts) {
		receipts.push(await uploadStagedArtifact(artifact, options.uploadBlob));
	}
	return buildMaterializedRelease(staged.plan, receipts);
}
