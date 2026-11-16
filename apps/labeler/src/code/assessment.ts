import { NSID, REGISTRY_CUMULUS_ORIGIN } from "@emdash-cms/registry-lexicons";
import { isFindingSeverity } from "@emdash-cms/registry-moderation";
import { recordScopedBlobCacheUrl } from "@emdash-cms/registry-verification/artifact";
import { MAX_BUNDLE_COMPRESSED_BYTES } from "@emdash-cms/registry-verification/bundle";

import {
	fetchGuardedResource,
	readBoundedBody,
	type GuardedMediaTransport,
	type MediaHostnameResolver,
} from "../assessment/media.js";
import type { VerifiedReleaseRecord } from "../assessment/records.js";
import { parseSubjectUri } from "../assessment/run-key.js";
import type { ReviewBudget } from "./budget.js";
import {
	unpackPackageBundle,
	verifyPackageBytes,
	type PackageArtifactReference,
	type UnpackedBundle,
} from "./bundle.js";
import { integrityFindings, PACKAGE_EVIDENCE_PREFIX, type CodeFinding } from "./integrity.js";

const BUNDLE_FETCH_TIMEOUT_MS = 20_000;
const MAX_BUNDLE_REDIRECTS = 3;
const MAX_REVIEW_FINDINGS = 16;
const MAX_EVIDENCE_PER_FINDING = 8;
const MAX_SUMMARY_LENGTH = 500;
const REVIEW_CATEGORIES = ["malicious-code", "vulnerability", "reviewer-manipulation"] as const;

export interface PackageCodeSubject {
	uri: string;
	cid: string;
	version: string;
	artifact: PackageArtifactReference;
	declaredAccess: Record<string, unknown>;
}

export interface PackageBundleReader {
	read(subject: PackageCodeSubject, maxBytes: number): Promise<Uint8Array>;
}

/** Listing text shown to the reviewer as the plugin's stated purpose. */
export interface ListingText {
	ref: string;
	text: string;
}

export interface PluginReviewRequest {
	model: string;
	subject: { uri: string; cid: string; version: string };
	listing: readonly ListingText[];
	declaredAccess: Record<string, unknown>;
	files: readonly { path: string; byteLength: number; text?: string }[];
}

/** The `plugin-review` Worker's RPC surface. */
export interface PluginReviewer {
	review(request: PluginReviewRequest): Promise<unknown>;
}

export interface CodeAssessmentDependencies {
	bundleReader: PackageBundleReader;
	reviewer: PluginReviewer;
	/** Every model reviews the bundle independently; a release passes only if none finds anything. */
	models: readonly string[];
	budget?: ReviewBudget;
}

export interface CodeReviewIdentity {
	model: string;
	promptVersion: string;
}

export interface CodeAssessmentIdentity {
	reviewers: readonly CodeReviewIdentity[];
}

export interface PackageCheckResult {
	findings: readonly CodeFinding[];
}

export interface PackageReviewResult {
	identity: CodeReviewIdentity;
	findings: readonly CodeFinding[];
}

export interface CodeAssessmentResult {
	identity: CodeAssessmentIdentity;
	findings: readonly CodeFinding[];
}

export class PackageBundleUnavailableError extends Error {
	override readonly name = "PackageBundleUnavailableError";
}

export class PluginReviewResponseError extends Error {
	override readonly name = "PluginReviewResponseError";
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

/** Archive anomalies, the only findings that come from deterministic checks. */
export async function checkReleasePackage(
	subject: PackageCodeSubject,
	dependencies: Pick<CodeAssessmentDependencies, "bundleReader">,
): Promise<PackageCheckResult> {
	const bundle = await readVerifiedBundle(subject, dependencies.bundleReader);
	return { findings: integrityFindings(bundle.anomalies) };
}

export async function reviewReleasePackage(
	subject: PackageCodeSubject,
	listing: readonly ListingText[],
	model: string,
	dependencies: Pick<CodeAssessmentDependencies, "bundleReader" | "reviewer">,
): Promise<PackageReviewResult> {
	const bundle = await readVerifiedBundle(subject, dependencies.bundleReader);
	const response = await dependencies.reviewer.review({
		model,
		subject: { uri: subject.uri, cid: subject.cid, version: subject.version },
		listing,
		declaredAccess: subject.declaredAccess,
		files: bundle.files.map(({ path, byteLength, text }) =>
			text === undefined ? { path, byteLength } : { path, byteLength, text },
		),
	});
	return parseReviewResponse(response, model, bundle);
}

export function combineCodeAssessment(
	check: PackageCheckResult,
	reviews: readonly PackageReviewResult[],
): CodeAssessmentResult {
	return {
		identity: { reviewers: reviews.map(({ identity }) => identity) },
		findings: [...check.findings, ...reviews.flatMap(({ findings }) => findings)],
	};
}

/**
 * The review Worker already checks citations against the files it was given.
 * This re-checks the response shape and that every citation names a line that
 * exists in the bundle the labeler verified.
 */
export function parseReviewResponse(
	value: unknown,
	model: string,
	bundle: UnpackedBundle,
): PackageReviewResult {
	if (!isRecord(value) || value["model"] !== model || typeof value["promptVersion"] !== "string") {
		throw new PluginReviewResponseError("plugin review response is malformed");
	}
	const findings = value["findings"];
	if (!Array.isArray(findings) || findings.length > MAX_REVIEW_FINDINGS) {
		throw new PluginReviewResponseError("plugin review findings are malformed");
	}
	const lineCounts = new Map(
		bundle.files.flatMap((file) =>
			file.text === undefined ? [] : [[file.path, file.text.split("\n").length] as const],
		),
	);
	return {
		identity: { model, promptVersion: value["promptVersion"].slice(0, 64) },
		findings: findings.map((finding): CodeFinding => {
			if (
				!isRecord(finding) ||
				!isReviewCategory(finding["category"]) ||
				!isFindingSeverity(finding["severity"]) ||
				typeof finding["confidence"] !== "number" ||
				!(finding["confidence"] >= 0 && finding["confidence"] <= 1) ||
				typeof finding["summary"] !== "string" ||
				!Array.isArray(finding["evidence"]) ||
				finding["evidence"].length === 0
			) {
				throw new PluginReviewResponseError("plugin review finding is malformed");
			}
			const evidenceRefs = finding["evidence"]
				.slice(0, MAX_EVIDENCE_PER_FINDING)
				.map((citation: unknown) => {
					if (!isRecord(citation) || typeof citation["file"] !== "string") {
						throw new PluginReviewResponseError("plugin review citation is malformed");
					}
					const lines = lineCounts.get(citation["file"]);
					const line = citation["line"];
					if (
						lines === undefined ||
						typeof line !== "number" ||
						!Number.isInteger(line) ||
						line < 1 ||
						line > lines
					) {
						throw new PluginReviewResponseError("plugin review cites a line outside the bundle");
					}
					return `${PACKAGE_EVIDENCE_PREFIX}${citation["file"]}#L${line}`;
				});
			return {
				category: finding["category"],
				recommendation: "review",
				confidence: finding["confidence"],
				severity: finding["severity"],
				summary: finding["summary"].slice(0, MAX_SUMMARY_LENGTH),
				evidenceRefs: [...new Set(evidenceRefs)],
			};
		}),
	};
}

async function readVerifiedBundle(
	subject: PackageCodeSubject,
	reader: PackageBundleReader,
): Promise<UnpackedBundle> {
	const bytes = await reader.read(subject, MAX_BUNDLE_COMPRESSED_BYTES);
	await verifyPackageBytes(bytes, subject.artifact);
	return unpackPackageBundle(bytes);
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

function isReviewCategory(value: unknown): value is (typeof REVIEW_CATEGORIES)[number] {
	return REVIEW_CATEGORIES.some((category) => category === value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
