/**
 * The package manifest and its file index.
 *
 * `manifest.json` is small: identity, features, locales, per-kind counts,
 * totals, export transformations, and the list of index chunks with their
 * sizes and digests. The complete file list (every record chunk and media
 * blob with size and SHA-256) lives in the index chunks `index/<seq>.ndjson`,
 * one {@link PackageFileEntry} per line, sorted by path across chunks. Because
 * the manifest pins each index chunk's digest and each index entry pins its
 * file's digest, `packageDigest` covers every byte of the package.
 */

import { z } from "zod";

import { TransferError } from "../errors.js";
import { canonicalJson, CanonicalJsonError, parseCanonicalJson } from "./canonical.js";
import {
	isSitePackageFeature,
	KIND_FEATURE,
	OPTIONAL_FEATURES,
	unsupportedRequiredFeatures,
} from "./features.js";
import { summarizeSchemaIssue } from "./issues.js";
import { compareIds, portableIdSchema, RECORD_KINDS } from "./kinds.js";
import { TRANSFER_LIMITS } from "./limits.js";
import { indexChunkPath, parsePackagePath } from "./paths.js";
import { exportTransformationSchema } from "./transformations.js";
import {
	SITE_PACKAGE_FORMAT,
	SITE_PACKAGE_FORMAT_VERSION,
	SITE_PACKAGE_PROFILE,
	SUPPORTED_FORMAT_VERSIONS,
} from "./version.js";

const sha256Hex = z.string().regex(/^[0-9a-f]{64}$/);
const count = z.number().int().nonnegative();
const featureName = z
	.string()
	.min(1)
	.max(64)
	.regex(/^[a-z][a-z0-9_]*$/);
const localeSchema = z.string().min(1).max(64);

function isSortedUnique(values: readonly string[]): boolean {
	return values.every(
		(value, index) => index === 0 || compareIds(values[index - 1] ?? "", value) < 0,
	);
}

export const indexChunkRefSchema = z.strictObject({
	path: z.string(),
	bytes: count.max(TRANSFER_LIMITS.chunkBytes),
	sha256: sha256Hex,
	entries: count.max(TRANSFER_LIMITS.chunkRecords),
});

export type IndexChunkRef = z.infer<typeof indexChunkRefSchema>;

export const recordKindSummarySchema = z.strictObject({
	count: count.min(1),
	chunks: count.min(1),
});

export const sitePackageManifestSchema = z
	.strictObject({
		format: z.literal(SITE_PACKAGE_FORMAT),
		formatVersion: z.literal(SITE_PACKAGE_FORMAT_VERSION),
		packageId: portableIdSchema,
		originSiteId: portableIdSchema,
		createdAt: z.string().min(1).max(64),
		createdByEmDashVersion: z.string().min(1).max(128),
		profile: z.literal(SITE_PACKAGE_PROFILE),
		features: z.array(featureName).max(256),
		requiredFeatures: z.array(featureName).max(256),
		locales: z.strictObject({
			default: localeSchema,
			used: z.array(localeSchema).max(1000),
		}),
		records: z.partialRecord(z.enum(RECORD_KINDS), recordKindSummarySchema),
		media: z.strictObject({ count, totalBytes: count }),
		files: z.strictObject({ count: count.max(TRANSFER_LIMITS.totalFiles), totalBytes: count }),
		index: z.array(indexChunkRefSchema).max(TRANSFER_LIMITS.indexChunks),
		transformations: z.array(exportTransformationSchema).max(RECORD_KINDS.length * 8),
		fence: z.strictObject({
			attempts: z.number().int().min(1).max(TRANSFER_LIMITS.exportFenceAttempts),
		}),
	})
	.superRefine((manifest, ctx) => {
		const issue = (path: (string | number)[], message: string) =>
			ctx.addIssue({ code: "custom", path, message });

		if (!isSortedUnique(manifest.features))
			issue(["features"], "Features must be sorted and unique");
		if (!isSortedUnique(manifest.requiredFeatures)) {
			issue(["requiredFeatures"], "Required features must be sorted and unique");
		}
		const features = new Set(manifest.features);
		for (const feature of manifest.requiredFeatures) {
			if (!features.has(feature)) issue(["requiredFeatures"], `${feature} is not in features`);
		}
		for (const feature of manifest.features) {
			if (
				isSitePackageFeature(feature) &&
				!OPTIONAL_FEATURES.has(feature) &&
				!manifest.requiredFeatures.includes(feature)
			) {
				issue(["requiredFeatures"], `${feature} must be required`);
			}
		}
		if (!isSortedUnique(manifest.locales.used)) {
			issue(["locales", "used"], "Locales must be sorted and unique");
		}
		if (
			manifest.locales.used.length > 0 &&
			!manifest.locales.used.includes(manifest.locales.default)
		) {
			issue(["locales", "default"], "Default locale must be in use");
		}

		let totalRecords = 0;
		for (const kind of RECORD_KINDS) {
			const summary = manifest.records[kind];
			if (!summary) continue;
			totalRecords += summary.count;
			if (!features.has(KIND_FEATURE[kind])) {
				issue(["records", kind], `Kind ${kind} requires feature ${KIND_FEATURE[kind]}`);
			}
			if (
				summary.chunks > summary.count ||
				summary.count > summary.chunks * TRANSFER_LIMITS.chunkRecords
			) {
				issue(["records", kind], "Chunk count does not fit the record count");
			}
		}
		if (totalRecords > TRANSFER_LIMITS.totalRecords) issue(["records"], "Too many records");
		if (manifest.media.count > 0 && !features.has("media")) {
			issue(["media"], "Media blobs require feature media");
		}
		if (manifest.media.count > manifest.files.count) issue(["media"], "More blobs than files");
		if (manifest.media.totalBytes > manifest.files.totalBytes) {
			issue(["media"], "Blob bytes exceed file bytes");
		}

		manifest.index.forEach((chunk, seq) => {
			if (chunk.path !== indexChunkPath(seq))
				issue(["index", seq, "path"], "Unexpected index path");
		});
		const indexedEntries = manifest.index.reduce((sum, chunk) => sum + chunk.entries, 0);
		if (indexedEntries !== manifest.files.count) {
			issue(["index"], "Index entries do not match the file count");
		}

		const transformationKeys = manifest.transformations.map((t) => `${t.code}\u0000${t.kind}`);
		if (!isSortedUnique(transformationKeys)) {
			issue(["transformations"], "Transformations must be sorted by code and kind and unique");
		}
	});

export type SitePackageManifest = z.infer<typeof sitePackageManifestSchema>;

/** One line of an index chunk. `records` is present exactly for record chunks. */
export const packageFileEntrySchema = z
	.strictObject({
		path: z.string().min(1).max(256),
		bytes: count,
		sha256: sha256Hex,
		records: count.min(1).max(TRANSFER_LIMITS.chunkRecords).optional(),
	})
	.superRefine((entry, ctx) => {
		const parsed = parsePackagePath(entry.path);
		if (!parsed || (parsed.type !== "records" && parsed.type !== "media")) {
			ctx.addIssue({ code: "custom", path: ["path"], message: "Invalid package file path" });
			return;
		}
		if (parsed.type === "records") {
			if (entry.records === undefined) {
				ctx.addIssue({ code: "custom", path: ["records"], message: "Record count required" });
			}
			if (entry.bytes > TRANSFER_LIMITS.chunkBytes) {
				ctx.addIssue({ code: "custom", path: ["bytes"], message: "Chunk too large" });
			}
		} else {
			if (entry.records !== undefined) {
				ctx.addIssue({ code: "custom", path: ["records"], message: "Blobs have no records" });
			}
			if (entry.sha256 !== parsed.sha256) {
				ctx.addIssue({ code: "custom", path: ["sha256"], message: "Blob path must be its digest" });
			}
		}
	});

export type PackageFileEntry = z.infer<typeof packageFileEntrySchema>;

/**
 * Parse and validate `manifest.json` bytes. Throws a {@link TransferError}:
 * `TRANSFER_LIMIT_EXCEEDED` when too large, `TRANSFER_UNSUPPORTED_FORMAT` for
 * another format or version, `TRANSFER_UNSUPPORTED_FEATURE` for an unknown
 * required feature, and `TRANSFER_MANIFEST_INVALID` otherwise.
 */
export function parseManifest(input: string | Uint8Array): SitePackageManifest {
	const byteLength =
		typeof input === "string" ? new TextEncoder().encode(input).byteLength : input.byteLength;
	if (byteLength > TRANSFER_LIMITS.manifestBytes) {
		throw new TransferError("TRANSFER_LIMIT_EXCEEDED", "Manifest is too large", {
			detail: { limit: TRANSFER_LIMITS.manifestBytes },
		});
	}
	const text = typeof input === "string" ? input : decodeUtf8(input, "TRANSFER_MANIFEST_INVALID");

	let raw: unknown;
	try {
		raw = parseCanonicalJson(text);
	} catch (error) {
		throw new TransferError("TRANSFER_MANIFEST_INVALID", "Manifest is not canonical JSON", {
			detail: { reason: error instanceof CanonicalJsonError ? error.message : "invalid" },
		});
	}

	const envelope = z
		.looseObject({ format: z.unknown(), formatVersion: z.unknown(), requiredFeatures: z.unknown() })
		.safeParse(raw);
	if (
		!envelope.success ||
		envelope.data.format !== SITE_PACKAGE_FORMAT ||
		typeof envelope.data.formatVersion !== "string" ||
		!SUPPORTED_FORMAT_VERSIONS.includes(envelope.data.formatVersion)
	) {
		throw new TransferError("TRANSFER_UNSUPPORTED_FORMAT", "Unsupported package format or version");
	}
	if (Array.isArray(envelope.data.requiredFeatures)) {
		const unsupported = unsupportedRequiredFeatures(
			envelope.data.requiredFeatures.filter((value): value is string => typeof value === "string"),
		);
		if (unsupported.length > 0) {
			throw new TransferError(
				"TRANSFER_UNSUPPORTED_FEATURE",
				"Package requires unsupported features",
				{
					detail: { features: unsupported.slice(0, 20).join(",") },
				},
			);
		}
	}

	const result = sitePackageManifestSchema.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		const summary = first ? summarizeSchemaIssue(first, sitePackageManifestSchema.shape) : null;
		throw new TransferError("TRANSFER_MANIFEST_INVALID", "Manifest failed validation", {
			detail: {
				path: summary?.path ?? "",
				reason: summary?.message ?? "invalid",
				issues: result.error.issues.length,
			},
		});
	}
	return result.data;
}

export function serializeManifest(manifest: SitePackageManifest): string {
	return canonicalJson(manifest);
}

/** Parse one index line (canonical JSON, without its newline). */
export function parseIndexLine(line: string): PackageFileEntry {
	let raw: unknown;
	try {
		raw = parseCanonicalJson(line);
	} catch (error) {
		throw new TransferError("TRANSFER_MANIFEST_INVALID", "Index line is not canonical JSON", {
			detail: { reason: error instanceof CanonicalJsonError ? error.message : "invalid" },
		});
	}
	const result = packageFileEntrySchema.safeParse(raw);
	if (!result.success) {
		const first = result.error.issues[0];
		throw new TransferError("TRANSFER_MANIFEST_INVALID", "Index line failed validation", {
			detail: {
				reason: first
					? summarizeSchemaIssue(first, packageFileEntrySchema.shape).message
					: "invalid",
			},
		});
	}
	return result.data;
}

export function decodeUtf8(
	bytes: Uint8Array,
	code: "TRANSFER_MANIFEST_INVALID" | "TRANSFER_RECORD_INVALID",
): string {
	try {
		return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
	} catch {
		throw new TransferError(code, "File is not valid UTF-8");
	}
}
