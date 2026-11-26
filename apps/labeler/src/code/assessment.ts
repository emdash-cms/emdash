import { NSID, REGISTRY_CUMULUS_ORIGIN } from "@emdash-cms/registry-lexicons";
import { isFindingSeverity } from "@emdash-cms/registry-moderation";
import { recordScopedBlobCacheUrl } from "@emdash-cms/registry-verification/artifact";
import { MAX_BUNDLE_COMPRESSED_BYTES } from "@emdash-cms/registry-verification/bundle";

import {
	ByteLimitExceededError,
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
import {
	integrityFindings,
	PACKAGE_EVIDENCE_PREFIX,
	type CodeFinding,
	type EvidenceExcerpt,
} from "./integrity.js";

const BUNDLE_FETCH_TIMEOUT_MS = 20_000;
const MAX_BUNDLE_REDIRECTS = 3;
const MAX_REVIEW_FINDINGS = 16;
const MAX_EVIDENCE_PER_FINDING = 8;
const MAX_SUMMARY_LENGTH = 500;
const MAX_EXCERPTS_PER_FINDING = 4;
const EXCERPT_CONTEXT_LINES = 3;
const MAX_EXCERPT_LINE_LENGTH = 240;
const REVIEW_CATEGORIES = ["malicious-code", "vulnerability", "reviewer-manipulation"] as const;

export interface PackageCodeSubject {
	uri: string;
	cid: string;
	version: string;
	packageSlug: string;
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

/** Finds the current record of a package's profile, which holds the listing's stated purpose. */
export interface PackageProfileLocator {
	currentCid(profileUri: string): Promise<string | null>;
}

/** The `plugin-review` Worker's RPC surface. */
export interface PluginReviewer {
	review(request: PluginReviewRequest): Promise<unknown>;
}

export interface CodeAssessmentDependencies {
	bundleReader: PackageBundleReader;
	reviewer: PluginReviewer;
	profiles: PackageProfileLocator;
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

/** What one reviewer concluded, kept so operators can see where reviewers disagree. */
export interface CodeReviewReport extends CodeReviewIdentity {
	summary: string;
	findingCount: number;
	declined?: true;
}

export interface PackageCheckResult {
	findings: readonly CodeFinding[];
	/** False when the archive has no files or repeats a path, so no reviewer can be given it. */
	reviewable: boolean;
}

export interface PackageReviewResult {
	identity: CodeReviewIdentity;
	summary: string;
	declined?: true;
	findings: readonly CodeFinding[];
}

export interface CodeAssessmentResult {
	identity: CodeAssessmentIdentity;
	reviews: readonly CodeReviewReport[];
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
		packageSlug: verified.record.package,
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
	const paths = new Set(bundle.files.map(({ path }) => path));
	const reviewable = bundle.files.length > 0 && paths.size === bundle.files.length;
	const findings = integrityFindings(bundle.anomalies);
	if (!reviewable && findings.length === 0) {
		throw new PackageBundleUnavailableError("package cannot be reviewed and reports no anomaly");
	}
	return { findings, reviewable };
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
		reviews: reviews.map((review) => ({
			...review.identity,
			summary: review.summary,
			findingCount: review.declined ? 0 : review.findings.length,
			...(review.declined ? { declined: true as const } : {}),
		})),
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
	const identity = { model, promptVersion: value["promptVersion"].slice(0, 64) };
	const summary =
		typeof value["summary"] === "string" ? value["summary"].slice(0, MAX_SUMMARY_LENGTH) : "";
	if (value["declined"] === true) {
		const reason = summary;
		return {
			identity,
			summary,
			declined: true,
			findings: [
				{
					category: "review-declined",
					source: model,
					recommendation: "review",
					confidence: 1,
					summary: `${model} declined to review the package. ${reason}`
						.trim()
						.slice(0, MAX_SUMMARY_LENGTH),
					evidenceRefs: [],
				},
			],
		};
	}
	const findings = value["findings"];
	if (!Array.isArray(findings) || findings.length > MAX_REVIEW_FINDINGS) {
		throw new PluginReviewResponseError("plugin review findings are malformed");
	}
	const fileLines = new Map(
		bundle.files.flatMap((file) =>
			file.text === undefined ? [] : [[file.path, file.text.split("\n")] as const],
		),
	);
	return {
		identity,
		summary,
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
			const citations = finding["evidence"]
				.slice(0, MAX_EVIDENCE_PER_FINDING)
				.map((citation: unknown) => {
					if (!isRecord(citation) || typeof citation["file"] !== "string") {
						throw new PluginReviewResponseError("plugin review citation is malformed");
					}
					const lines = fileLines.get(citation["file"]);
					const line = citation["line"];
					if (
						lines === undefined ||
						typeof line !== "number" ||
						!Number.isInteger(line) ||
						line < 1 ||
						line > lines.length
					) {
						throw new PluginReviewResponseError("plugin review cites a line outside the bundle");
					}
					const quote = typeof citation["quote"] === "string" ? citation["quote"] : "";
					return {
						ref: `${PACKAGE_EVIDENCE_PREFIX}${citation["file"]}#L${line}`,
						lines,
						line,
						quote,
					};
				});
			const evidenceRefs = citations.map(({ ref }) => ref);
			return {
				category: finding["category"],
				source: model,
				recommendation: "review",
				confidence: finding["confidence"],
				severity: finding["severity"],
				summary: finding["summary"].slice(0, MAX_SUMMARY_LENGTH),
				evidenceRefs: [...new Set(evidenceRefs)],
				excerpts: excerptsFor(citations),
			};
		}),
	};
}

function excerptsFor(
	citations: readonly { ref: string; lines: readonly string[]; line: number; quote: string }[],
): EvidenceExcerpt[] {
	const seen = new Set<string>();
	return citations
		.filter(({ ref }) => !seen.has(ref) && seen.add(ref))
		.slice(0, MAX_EXCERPTS_PER_FINDING)
		.map(({ ref, lines, line, quote }) => {
			const start = Math.max(1, line - EXCERPT_CONTEXT_LINES);
			const end = Math.min(lines.length, line + EXCERPT_CONTEXT_LINES);
			return {
				ref,
				startLine: start,
				lines: lines
					.slice(start - 1, end)
					.map((text, index) => clipLine(text, start + index === line ? quote : "")),
			};
		});
}

/** Cuts a long line to a window around `focus`, marking each cut with an ellipsis. */
function clipLine(text: string, focus: string): string {
	if (text.length <= MAX_EXCERPT_LINE_LENGTH) return text;
	const at = focus ? text.indexOf(focus) : -1;
	const centred = at - Math.floor((MAX_EXCERPT_LINE_LENGTH - focus.length) / 2);
	const start =
		at === -1 ? 0 : Math.max(0, Math.min(centred, text.length - MAX_EXCERPT_LINE_LENGTH, at));
	const end = start + MAX_EXCERPT_LINE_LENGTH;
	return `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`;
}

async function readVerifiedBundle(
	subject: PackageCodeSubject,
	reader: PackageBundleReader,
): Promise<UnpackedBundle> {
	let bytes: Uint8Array;
	try {
		bytes = await reader.read(subject, MAX_BUNDLE_COMPRESSED_BYTES);
	} catch (error) {
		if (error instanceof ByteLimitExceededError) {
			return { files: [], anomalies: [{ code: "compressed-size-exceeded" }] };
		}
		throw error;
	}
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
