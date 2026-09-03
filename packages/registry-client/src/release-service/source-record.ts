import { safeParse } from "@atcute/lexicons";
import { fromBase32, toBase32 } from "@atcute/multibase";
import {
	NSID,
	PackageRelease,
	PackageReleaseExtension,
	type PackageRelease as PackageReleaseTypes,
	type PackageReleaseExtension as PackageReleaseExtensionTypes,
} from "@emdash-cms/registry-lexicons";

const SOURCE_ARTIFACT_KEYS = new Set(["$type", "package", "icon", "banner", "screenshots"]);
const IMAGE_CONTENT_TYPES = new Set(["image/jpeg", "image/png", "image/webp"]);

export type DelegatedReleaseSourceArtifact = Omit<
	PackageReleaseTypes.Artifact,
	"blob" | "requiresAuth" | "url"
> & {
	url: NonNullable<PackageReleaseTypes.Artifact["url"]>;
	blob?: never;
	requiresAuth?: never;
};

export type DelegatedReleaseSourceImageArtifact = Omit<
	PackageReleaseTypes.ImageArtifact,
	"blob" | "requiresAuth" | "url"
> & {
	url: NonNullable<PackageReleaseTypes.ImageArtifact["url"]>;
	blob?: never;
	requiresAuth?: never;
};

export interface DelegatedReleaseSourceArtifacts extends Omit<
	PackageReleaseTypes.Artifacts,
	"banner" | "icon" | "package" | "screenshots"
> {
	package: DelegatedReleaseSourceArtifact;
	icon?: DelegatedReleaseSourceImageArtifact;
	banner?: DelegatedReleaseSourceImageArtifact;
	screenshots?: DelegatedReleaseSourceImageArtifact[];
}

export type DelegatedReleaseSourceExtension = Omit<
	PackageReleaseExtensionTypes.Main,
	"provenance"
> & {
	provenance: PackageReleaseExtensionTypes.Provenance;
};

export interface DelegatedReleaseSourceRecord extends Omit<
	PackageReleaseTypes.Main,
	"artifacts" | "auth" | "extensions"
> {
	artifacts: DelegatedReleaseSourceArtifacts;
	auth?: never;
	extensions: Record<string, unknown> & {
		[NSID.packageReleaseExtension]: DelegatedReleaseSourceExtension;
	};
}

export interface DelegatedReleaseSourceEnvelope {
	packageSlug: string;
	version: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isHttpsUrl(value: unknown): value is string {
	if (typeof value !== "string") return false;
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" && url.username === "" && url.password === "" && url.hash === ""
		);
	} catch {
		return false;
	}
}

function isCanonicalSha256Multihash(value: unknown): value is string {
	if (typeof value !== "string" || !value.startsWith("b")) return false;
	try {
		const bytes = fromBase32(value.slice(1));
		return (
			bytes.length === 34 &&
			bytes[0] === 0x12 &&
			bytes[1] === 0x20 &&
			`b${toBase32(bytes)}` === value
		);
	} catch {
		return false;
	}
}

function validSourceArtifact(value: unknown, image: boolean): boolean {
	if (
		!isRecord(value) ||
		Object.hasOwn(value, "blob") ||
		Object.hasOwn(value, "requiresAuth") ||
		!isHttpsUrl(value["url"]) ||
		!isCanonicalSha256Multihash(value["checksum"])
	) {
		return false;
	}
	const contentType = value["contentType"];
	return contentType === undefined
		? true
		: image
			? typeof contentType === "string" && IMAGE_CONTENT_TYPES.has(contentType)
			: contentType === "application/gzip";
}

function validSourceArtifacts(value: unknown): boolean {
	if (
		!isRecord(value) ||
		Object.keys(value).some((key) => !SOURCE_ARTIFACT_KEYS.has(key)) ||
		!validSourceArtifact(value["package"], false) ||
		(value["icon"] !== undefined && !validSourceArtifact(value["icon"], true)) ||
		(value["banner"] !== undefined && !validSourceArtifact(value["banner"], true))
	) {
		return false;
	}
	const screenshots = value["screenshots"];
	return (
		screenshots === undefined ||
		(Array.isArray(screenshots) &&
			screenshots.every((artifact) => validSourceArtifact(artifact, true)))
	);
}

function isDelegatedReleaseSourceRecord(
	release: PackageReleaseTypes.Main,
	envelope?: DelegatedReleaseSourceEnvelope,
): release is DelegatedReleaseSourceRecord {
	if (
		Object.hasOwn(release, "auth") ||
		!validSourceArtifacts(release.artifacts) ||
		(envelope !== undefined &&
			(release.package !== envelope.packageSlug || release.version !== envelope.version)) ||
		!isRecord(release.extensions)
	) {
		return false;
	}
	const extension = safeParse(
		PackageReleaseExtension.mainSchema,
		release.extensions[NSID.packageReleaseExtension],
	);
	return (
		extension.ok &&
		extension.value.provenance !== undefined &&
		isHttpsUrl(extension.value.provenance.url) &&
		isCanonicalSha256Multihash(extension.value.provenance.checksum)
	);
}

export function parseDelegatedReleaseSourceRecord(
	value: unknown,
	envelope?: DelegatedReleaseSourceEnvelope,
): DelegatedReleaseSourceRecord | null {
	const release = safeParse(PackageRelease.mainSchema, value);
	return release.ok && isDelegatedReleaseSourceRecord(release.value, envelope)
		? release.value
		: null;
}
