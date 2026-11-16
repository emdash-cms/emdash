import type { DeclaredAccess } from "@emdash-cms/plugin-types";
import { NSID, REGISTRY_CUMULUS_ORIGIN } from "@emdash-cms/registry-lexicons";
import type {
	CodeFindingCategory,
	NormalizedModerationFinding,
} from "@emdash-cms/registry-moderation";
import { recordScopedBlobCacheUrl } from "@emdash-cms/registry-verification/artifact";
import { MAX_BUNDLE_COMPRESSED_BYTES } from "@emdash-cms/registry-verification/bundle";

import type { CodeReviewAdapter } from "../ai/code-review.js";
import type { ModerationModelIdentity } from "../ai/types.js";
import {
	fetchGuardedResource,
	readBoundedBody,
	type GuardedMediaTransport,
	type MediaHostnameResolver,
} from "../assessment/media.js";
import type { VerifiedReleaseRecord } from "../assessment/records.js";
import { parseSubjectUri } from "../assessment/run-key.js";
import {
	unpackPackageBundle,
	verifyPackageBytes,
	type PackageArtifactReference,
	type UnpackedBundle,
} from "./bundle.js";
import {
	CODE_ENGINE_VERSION,
	globToRegExp,
	rulesetNeedsPreviousRelease,
	scanPackageCode,
	toModerationFinding,
	type PreviousReleaseAccess,
} from "./engine.js";
import type { CodeRulesetSource, LoadedCodeRuleset } from "./ruleset-source.js";
import type { CodeReviewConfig } from "./ruleset.js";

const BUNDLE_FETCH_TIMEOUT_MS = 20_000;
const MAX_BUNDLE_READ_BYTES = 4 * MAX_BUNDLE_COMPRESSED_BYTES;
const MAX_BUNDLE_REDIRECTS = 3;

export interface PackageCodeSubject {
	uri: string;
	cid: string;
	version: string;
	artifact: PackageArtifactReference;
	declaredAccess: DeclaredAccess;
}

export interface PackageBundleReader {
	read(subject: PackageCodeSubject, maxBytes: number): Promise<Uint8Array>;
}

export interface PreviousReleaseLookup {
	previousRelease(uri: string): Promise<PreviousReleaseAccess | null>;
}

export interface CodeAssessmentDependencies {
	rulesets: CodeRulesetSource;
	bundleReader: PackageBundleReader;
	previousReleases: PreviousReleaseLookup;
	createReviewAdapter?(config: CodeReviewConfig): Promise<CodeReviewAdapter>;
}

export interface CodeAssessmentIdentity {
	engineVersion: string;
	rulesetId: string;
	rulesetVersion: string;
	rulesetSha256: string;
	review?: ModerationModelIdentity;
}

export interface CodeScanStepResult {
	identity: CodeAssessmentIdentity;
	findings: readonly NormalizedModerationFinding<CodeFindingCategory>[];
	truncated: boolean;
	reviewConfigured: boolean;
}

export interface CodeReviewStepResult {
	identity: ModerationModelIdentity;
	findings: readonly NormalizedModerationFinding<CodeFindingCategory>[];
}

export interface CodeAssessmentResult {
	identity: CodeAssessmentIdentity;
	findings: readonly NormalizedModerationFinding<CodeFindingCategory>[];
	truncated: boolean;
}

export class PackageBundleUnavailableError extends Error {
	override readonly name = "PackageBundleUnavailableError";
}

/**
 * Projects only what code assessment needs from a verified release. The
 * package URL is deliberately not carried: bundles are read from the
 * record-scoped registry blob cache, never from a publisher-chosen host.
 */
export function projectPackageCodeSubject(verified: VerifiedReleaseRecord): PackageCodeSubject {
	const artifact = verified.record.artifacts.package;
	const blob = artifact.blob;
	const extension: unknown = verified.record.extensions?.[NSID.packageReleaseExtension];
	const declaredAccess = isRecord(extension) ? extension["declaredAccess"] : undefined;
	return {
		uri: verified.uri,
		cid: verified.cid,
		version: verified.record.version,
		artifact: {
			checksum: artifact.checksum,
			...(blob && "ref" in blob ? { blobCid: blob.ref.$link } : {}),
		},
		declaredAccess: isRecord(declaredAccess) ? declaredAccess : {},
	};
}

export async function scanReleasePackage(
	subject: PackageCodeSubject,
	dependencies: CodeAssessmentDependencies,
): Promise<CodeScanStepResult> {
	const loaded = await dependencies.rulesets.load();
	const bundle = await readVerifiedBundle(subject, dependencies.bundleReader);
	const previousRelease = rulesetNeedsPreviousRelease(loaded.ruleset)
		? await dependencies.previousReleases.previousRelease(subject.uri)
		: undefined;
	const scan = scanPackageCode({
		ruleset: loaded.ruleset,
		bundle,
		declaredAccess: subject.declaredAccess,
		...(previousRelease === undefined ? {} : { previousRelease }),
	});
	return {
		identity: rulesetIdentity(loaded),
		findings: scan.findings.map(toModerationFinding),
		truncated: scan.truncated,
		reviewConfigured: loaded.ruleset.review !== undefined,
	};
}

export async function reviewReleasePackage(
	subject: PackageCodeSubject,
	dependencies: CodeAssessmentDependencies,
	expectedRulesetSha256: string,
): Promise<CodeReviewStepResult> {
	const loaded = await dependencies.rulesets.load();
	if (loaded.sha256 !== expectedRulesetSha256) {
		throw new Error("code ruleset changed between the scan and review steps");
	}
	const review = loaded.ruleset.review;
	if (!review || !dependencies.createReviewAdapter) {
		throw new Error("code review is not configured");
	}
	const adapter = await dependencies.createReviewAdapter(review);
	const bundle = await readVerifiedBundle(subject, dependencies.bundleReader);
	const patterns = review.files.map(globToRegExp);
	const files = bundle.files.flatMap((file) =>
		file.text !== undefined && patterns.some((pattern) => pattern.test(file.path))
			? [{ path: file.path, text: file.text }]
			: [],
	);
	const result = await adapter.review({
		subject: { uri: subject.uri, cid: subject.cid, kind: "release" },
		files,
	});
	return { identity: result.identity, findings: result.findings.map(toModerationFinding) };
}

export function combineCodeAssessment(
	scan: CodeScanStepResult,
	review: CodeReviewStepResult | undefined,
): CodeAssessmentResult {
	return {
		identity: review ? { ...scan.identity, review: review.identity } : scan.identity,
		findings: [...scan.findings, ...(review?.findings ?? [])],
		truncated: scan.truncated,
	};
}

async function readVerifiedBundle(
	subject: PackageCodeSubject,
	reader: PackageBundleReader,
): Promise<UnpackedBundle> {
	const bytes = await reader.read(subject, MAX_BUNDLE_READ_BYTES);
	await verifyPackageBytes(bytes, subject.artifact);
	return unpackPackageBundle(bytes);
}

function rulesetIdentity(loaded: LoadedCodeRuleset): CodeAssessmentIdentity {
	return {
		engineVersion: CODE_ENGINE_VERSION,
		rulesetId: loaded.ruleset.rulesetId,
		rulesetVersion: loaded.ruleset.version,
		rulesetSha256: loaded.sha256,
	};
}

export function createBlobCachePackageBundleReader(options: {
	resolver: MediaHostnameResolver;
	transport: GuardedMediaTransport;
	cacheOrigin?: string;
}): PackageBundleReader {
	const origin = options.cacheOrigin ?? REGISTRY_CUMULUS_ORIGIN;
	return {
		async read(subject, maxBytes) {
			if (!subject.artifact.blobCid) {
				throw new PackageBundleUnavailableError("release package has no blob reference");
			}
			const parsed = parseSubjectUri(subject.uri);
			const url = recordScopedBlobCacheUrl(
				origin,
				{
					did: parsed.publisherDid,
					collection: NSID.packageRelease,
					rkey: parsed.rkey,
					cid: subject.cid,
				},
				subject.artifact.blobCid,
			);
			if (!url.success) throw new PackageBundleUnavailableError(url.error.message);
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), BUNDLE_FETCH_TIMEOUT_MS);
			try {
				const response = await fetchGuardedResource({
					url: url.value.href,
					accept: "application/octet-stream",
					resolver: options.resolver,
					transport: options.transport,
					maxRedirects: MAX_BUNDLE_REDIRECTS,
					signal: controller.signal,
					deadline: Date.now() + BUNDLE_FETCH_TIMEOUT_MS,
					neverFetchUrls: new Set(),
				});
				return await readBoundedBody(response, maxBytes, controller.signal);
			} finally {
				clearTimeout(timeout);
			}
		},
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
