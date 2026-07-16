/**
 * Verified artifact acquisition (plan W7.2, spec §9.3/§9.4). Resolves a
 * verified release's package artifact from the preferred source, fetches it
 * under the shared SSRF-hardened controls, verifies its bytes against the
 * signed checksum, and unpacks the canonical bundle into the analysis file
 * set. Every failure is classified into the four ratified acquisition
 * categories — mirror miss, transient fetch failure, permanent checksum
 * mismatch, and policy rejection — each carrying the disposition the
 * orchestrator applies (retry as a transient stage error, or a permanent
 * deterministic finding).
 *
 * Composes `@emdash-cms/registry-verification` (W7.1): its guarded fetch,
 * multihash verification, and canonical bundle validation are the shared
 * foundation. This module adds the labeler's mirror-first source preference,
 * declared-URL fallback, and the acquisition-category classification on top —
 * it does not reimplement any of them.
 *
 * Mirror-ready seam: the source preference defaults to mirror-first, but v1
 * ships no mirror binding (`deps.mirror` absent), so the mirror source always
 * misses and every acquisition resolves via the publisher's declared URL
 * (plan W0.6). Injecting a mirror binding activates mirror-first ordering with
 * no change to this contract.
 */

import {
	decodeMultihash,
	fetchVerifiedResource,
	MAX_BUNDLE_COMPRESSED_BYTES,
	validatePluginBundle,
	verifyMultihash,
	type FetchImplementation,
	type HostnameResolver,
	type ValidatedPluginBundle,
	type VerificationErrorCode,
	type VerificationResult,
} from "@emdash-cms/registry-verification";

import type { StageAdapter, StageContext } from "./assessment-orchestrator.js";
import { StageTransientError } from "./assessment-orchestrator.js";
import type { Assessment } from "./assessment-store.js";
import type { CodeAnalysisFile } from "./code-ai-adapter.js";
import type { NormalizedFinding } from "./findings.js";

/** Where a release artifact is fetched from. `mirror` prefers the aggregator's
 * durable copy; `declared-url` fetches the publisher's signed artifact URL. */
export type ArtifactSource = "mirror" | "declared-url";

/**
 * Mirror-ready preference order. v1 has no mirror binding, so the mirror
 * source misses and acquisition falls through to the declared URL. Landing a
 * mirror binding activates mirror-first without touching this default.
 */
export const DEFAULT_ARTIFACT_SOURCES: readonly ArtifactSource[] = ["mirror", "declared-url"];

/**
 * Fetch budgets for a declared-URL artifact download. The byte budget equals
 * the compressed-bundle cap, so an artifact larger than any valid bundle is
 * rejected during streaming (the earliest point) and classified as an invalid
 * bundle. Timeouts bound a slow or stalled origin.
 */
export const ACQUISITION_FETCH_LIMITS = {
	headerTimeoutMs: 10_000,
	totalTimeoutMs: 30_000,
	maxBytes: MAX_BUNDLE_COMPRESSED_BYTES,
	maxRedirects: 3,
} as const;

/** Tool identifier recorded on the deterministic findings this stage emits. */
export const ACQUISITION_TOOL = "artifact-acquisition";
export const ACQUISITION_TOOL_VERSION = "1";

/** The four ratified acquisition categories (plan W7.2). */
export type AcquisitionFailureKind =
	| "mirror-miss"
	| "transient"
	| "permanent-mismatch"
	| "policy-rejection";

/** Deterministic finding a permanent acquisition failure maps onto (spec §9.4). */
export type AcquisitionFinding = "artifact-integrity-failure" | "invalid-bundle";

/**
 * How the orchestrator adapter finalizes a failure:
 *  - `retry`: a transient stage error — network, timeout, an unfetchable
 *    declared URL, or an exhausted source. Retries, then finalizes as
 *    `assessment-error`. Never a public block label: a transport failure is
 *    not evidence the plugin is malicious (spec §9.4).
 *  - a `finding`: a permanent, blocking deterministic finding.
 */
export type AcquisitionDisposition =
	| { readonly retry: true }
	| { readonly retry: false; readonly finding: AcquisitionFinding };

export interface AcquisitionFailure {
	readonly kind: AcquisitionFailureKind;
	/** Underlying verification code, or an acquisition-specific code. */
	readonly code: VerificationErrorCode | AcquisitionCode;
	readonly message: string;
	/** The source whose attempt produced this terminal failure. */
	readonly source: ArtifactSource;
	readonly disposition: AcquisitionDisposition;
}

/** Acquisition-specific codes with no registry-verification equivalent. */
export type AcquisitionCode = "MIRROR_MISS" | "COORDINATE_MISMATCH" | "NON_UTF8_CODE_FILE";

/** The verified release's package-artifact declaration plus the pinned
 * coordinates acquisition cross-checks it against. */
export interface AcquisitionTarget {
	/** Package-artifact download URL from the signed release. */
	readonly url: string;
	/** Multibase-multihash checksum from the signed release. */
	readonly checksum: string;
	/** Package slug (release.package) — the expected manifest id. */
	readonly slug: string;
	/** Release version — the expected manifest version. */
	readonly version: string;
	/** Artifact id from the signed release (artifacts.package.id), when present. */
	readonly artifactId?: string;
	/** Artifact coordinates pinned on the assessment; cross-checked against the
	 * declaration when present. */
	readonly pinnedChecksum?: string | null;
	readonly pinnedArtifactId?: string | null;
}

export interface AcquiredArtifact {
	readonly source: ArtifactSource;
	readonly bundle: ValidatedPluginBundle;
	/** UTF-8-decodable bundle files as the code stages' input. Binary files
	 * (images) are excluded here and remain available on `bundle.files`. */
	readonly files: readonly CodeAnalysisFile[];
	/** The checksum-verified compressed bundle bytes. */
	readonly bytes: Uint8Array;
}

export type AcquisitionResult =
	| { readonly success: true; readonly value: AcquiredArtifact }
	| { readonly success: false; readonly error: AcquisitionFailure };

/**
 * The aggregator artifact mirror. v1 ships no implementation; a future binding
 * resolves a deterministic R2 object (see `mirrorObjectKey`) through the
 * aggregator service binding (plan W0.6). `fetch` returns the raw compressed
 * bundle bytes, or `null` when the mirror holds no object for the release.
 */
export interface ArtifactMirror {
	fetch(key: string, target: AcquisitionTarget): Promise<Uint8Array | null>;
}

export interface AcquisitionDeps {
	readonly fetch: FetchImplementation;
	readonly resolveHostname: HostnameResolver;
	/** Future aggregator mirror binding. Absent in v1 — the mirror source misses. */
	readonly mirror?: ArtifactMirror;
	/** Source preference order. Defaults to `DEFAULT_ARTIFACT_SOURCES`. */
	readonly sources?: readonly ArtifactSource[];
	/** Fetch budget overrides; defaults to `ACQUISITION_FETCH_LIMITS`. */
	readonly limits?: Partial<typeof ACQUISITION_FETCH_LIMITS>;
}

/**
 * Deterministic mirror object key derived from release coordinates. The mirror
 * is a content-addressed copy of the exact signed artifact, so the key is
 * stable across acquisitions and independent of the declared URL.
 */
export function mirrorObjectKey(target: AcquisitionTarget): string {
	return `${target.slug}/${target.version}/${target.artifactId ?? "package"}`;
}

export async function acquireArtifact(
	deps: AcquisitionDeps,
	target: AcquisitionTarget,
): Promise<AcquisitionResult> {
	const coordinate = crossCheckCoordinates(target);
	if (coordinate) return { success: false, error: coordinate };

	const sources = deps.sources ?? DEFAULT_ARTIFACT_SOURCES;
	let lastFailure: AcquisitionFailure | undefined;

	for (const source of sources) {
		if (source === "mirror") {
			const bytes = await loadFromMirror(deps, target);
			if (bytes === null) {
				lastFailure = mirrorMiss();
				continue;
			}
			const result = await verifyAndUnpack(bytes, target, "mirror");
			// The mirror is an untrusted transport cache (spec §9.3): bytes that
			// fail the signed checksum mean a stale or corrupt copy, so fall
			// through to the authoritative declared URL rather than failing. Any
			// other outcome is inherent to the checksum-pinned artifact and is
			// terminal — the declared URL would yield byte-identical content.
			if (!result.success && result.error.code === "CHECKSUM_MISMATCH") {
				lastFailure = mirrorMiss();
				continue;
			}
			return result;
		}

		const fetched = await fetchDeclared(deps, target);
		if (!fetched.success) {
			lastFailure = classifyFailure(fetched.error.code, fetched.error.message, "declared-url");
			continue;
		}
		return verifyAndUnpack(fetched.value, target, "declared-url");
	}

	return { success: false, error: lastFailure ?? mirrorMiss() };
}

/** Cross-checks the pinned coordinates and the declared checksum before any
 * network work: a drift between what discovery pinned and what the release
 * declares, or a malformed declared checksum, is a permanent integrity fault. */
function crossCheckCoordinates(target: AcquisitionTarget): AcquisitionFailure | null {
	if (
		typeof target.pinnedChecksum === "string" &&
		target.pinnedChecksum.length > 0 &&
		target.pinnedChecksum !== target.checksum
	) {
		return classifyFailure(
			"COORDINATE_MISMATCH",
			"The pinned artifact checksum does not match the signed release declaration.",
			"declared-url",
		);
	}
	if (
		typeof target.pinnedArtifactId === "string" &&
		target.pinnedArtifactId.length > 0 &&
		target.pinnedArtifactId !== (target.artifactId ?? null)
	) {
		return classifyFailure(
			"COORDINATE_MISMATCH",
			"The pinned artifact id does not match the signed release declaration.",
			"declared-url",
		);
	}
	const decoded = decodeMultihash(target.checksum);
	if (!decoded.success) {
		return classifyFailure(decoded.error.code, decoded.error.message, "declared-url");
	}
	return null;
}

async function loadFromMirror(
	deps: AcquisitionDeps,
	target: AcquisitionTarget,
): Promise<Uint8Array | null> {
	if (!deps.mirror) return null;
	try {
		return await deps.mirror.fetch(mirrorObjectKey(target), target);
	} catch {
		// A mirror binding fault is not authoritative — treat it as a miss and
		// fall through to the declared URL.
		return null;
	}
}

async function fetchDeclared(
	deps: AcquisitionDeps,
	target: AcquisitionTarget,
): Promise<VerificationResult<Uint8Array>> {
	const limits = { ...ACQUISITION_FETCH_LIMITS, ...deps.limits };
	const result = await fetchVerifiedResource(target.url, {
		fetch: deps.fetch,
		resolveHostname: deps.resolveHostname,
		headerTimeoutMs: limits.headerTimeoutMs,
		totalTimeoutMs: limits.totalTimeoutMs,
		maxBytes: limits.maxBytes,
		maxRedirects: limits.maxRedirects,
	});
	if (!result.success) return result;
	return { success: true, value: result.value.bytes };
}

async function verifyAndUnpack(
	bytes: Uint8Array,
	target: AcquisitionTarget,
	source: ArtifactSource,
): Promise<AcquisitionResult> {
	const checksum = await verifyMultihash(bytes, target.checksum);
	if (!checksum.success) {
		return {
			success: false,
			error: classifyFailure(checksum.error.code, checksum.error.message, source),
		};
	}
	// The bytes are the exact signed artifact; validation ignores the declared
	// content-type and proves the archive shape itself (spec §9.3).
	const bundle = await validatePluginBundle(bytes, {
		expectedSlug: target.slug,
		expectedVersion: target.version,
	});
	if (!bundle.success) {
		return {
			success: false,
			error: classifyFailure(bundle.error.code, bundle.error.message, source),
		};
	}
	const fileSet = buildCodeFileSet(bundle.value);
	if (!fileSet.ok) {
		return { success: false, error: classifyFailure(fileSet.code, fileSet.message, source) };
	}
	return {
		success: true,
		value: {
			source,
			bundle: bundle.value,
			files: fileSet.files,
			bytes,
		},
	};
}

const utf8 = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false });

const CODE_FILE_EXTENSIONS = [
	".js",
	".mjs",
	".cjs",
	".jsx",
	".ts",
	".mts",
	".cts",
	".tsx",
	".json",
] as const;

function isCodeFile(path: string): boolean {
	const lower = path.toLowerCase();
	return CODE_FILE_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

type FileSetResult =
	| { readonly ok: true; readonly files: readonly CodeAnalysisFile[] }
	| { readonly ok: false; readonly code: AcquisitionCode; readonly message: string };

/**
 * Decodes the validated inventory into the code stages' file set, in tar order.
 * A code file (JS/TS/JSON, including the `backend.js`/`admin.js` entrypoints)
 * that is not valid UTF-8 is rejected as `invalid-bundle`: valid source is by
 * definition valid Unicode, and a raw invalid byte in an executable is an
 * evasion — a lenient runtime still runs it while the code AI, handed only the
 * decodable files, would never see it. The analyzed set must be a superset of
 * the executable set, so such a file may not be silently dropped. Genuine
 * binary assets (images) are the only files that legitimately fail to decode;
 * they are skipped here and remain on `bundle.files` for the image path.
 */
function buildCodeFileSet(bundle: ValidatedPluginBundle): FileSetResult {
	const files: CodeAnalysisFile[] = [];
	for (const file of bundle.files) {
		let content: string;
		try {
			content = utf8.decode(file.bytes);
		} catch {
			if (isCodeFile(file.path)) {
				return {
					ok: false,
					code: "NON_UTF8_CODE_FILE",
					message: `The plugin bundle code file ${file.path} is not valid UTF-8.`,
				};
			}
			continue;
		}
		files.push({ path: file.path, content });
	}
	return { ok: true, files };
}

function mirrorMiss(): AcquisitionFailure {
	return classifyFailure(
		"MIRROR_MISS",
		"The artifact mirror has no object for this release.",
		"mirror",
	);
}

/**
 * Retry → `assessment-error`, never a public block. Covers three faults that
 * are all "not evidence the artifact is bad": genuine network/origin failures;
 * a transport-size cap tripped mid-fetch, before any checksum, so the aborted
 * bytes were never verified (mapping them to a public block would let a MITM or
 * a misbehaving CDN mislabel a legitimate plugin — spec §9.4); and a
 * malformed/unsupported *declared* checksum, which is a bad record or a labeler
 * capability gap (e.g. a forward-compat hash), not tampering. A genuine
 * decompression bomb is still a permanent block via
 * `BUNDLE_DECOMPRESSED_SIZE_EXCEEDED`, which fires on checksum-verified bytes.
 */
const TRANSIENT_CODES: ReadonlySet<string> = new Set<VerificationErrorCode>([
	"FETCH_FAILED",
	"RESOURCE_TIMEOUT",
	"RESOURCE_STATUS_ERROR",
	"RESOURCE_SIZE_EXCEEDED",
	"INVALID_MULTIHASH",
	"UNSUPPORTED_MULTIHASH",
]);

/** URL-safety and redirect refusals: we will not fetch the declared URL. No
 * bytes, so no malicious signal — retried, then `assessment-error`. */
const URL_POLICY_CODES: ReadonlySet<string> = new Set<VerificationErrorCode>([
	"INVALID_URL",
	"HOST_REJECTED",
	"REDIRECT_LIMIT_EXCEEDED",
	"REDIRECT_LOCATION_MISSING",
]);

/** Genuine integrity faults on verified/authoritative inputs: the signed bytes
 * do not match the pin (`CHECKSUM_MISMATCH`), or the pinned coordinates drift
 * from the signed declaration (`COORDINATE_MISMATCH`). A malformed declared
 * checksum is NOT here — see `TRANSIENT_CODES` — because it is proven decodable
 * pre-fetch, so `verifyMultihash` can only ever return `CHECKSUM_MISMATCH` on
 * fetched bytes. */
const INTEGRITY_CODES: ReadonlySet<string> = new Set<VerificationErrorCode | AcquisitionCode>([
	"CHECKSUM_MISMATCH",
	"COORDINATE_MISMATCH",
]);

function classifyFailure(
	code: VerificationErrorCode | AcquisitionCode,
	message: string,
	source: ArtifactSource,
): AcquisitionFailure {
	if (code === "MIRROR_MISS") {
		return { kind: "mirror-miss", code, message, source, disposition: { retry: true } };
	}
	if (TRANSIENT_CODES.has(code)) {
		return { kind: "transient", code, message, source, disposition: { retry: true } };
	}
	if (URL_POLICY_CODES.has(code)) {
		return { kind: "policy-rejection", code, message, source, disposition: { retry: true } };
	}
	if (INTEGRITY_CODES.has(code)) {
		return {
			kind: "permanent-mismatch",
			code,
			message,
			source,
			disposition: { retry: false, finding: "artifact-integrity-failure" },
		};
	}
	// Every remaining code is a checksum-verified bundle rejected on its own
	// content: a structurally-invalid archive, or a non-UTF-8 code file. The
	// bytes match the signed pin, but the bundle itself is rejected by policy
	// (spec §9.4 → invalid-bundle).
	return {
		kind: "policy-rejection",
		code,
		message,
		source,
		disposition: { retry: false, finding: "invalid-bundle" },
	};
}

/** Populated by the acquire stage so downstream stages read the acquired
 * bundle and file set. The orchestrator's `StageContext` carries only the
 * assessment, so acquisition publishes its output through this shared handle —
 * the seam the production Workflow wiring will read. */
export interface AcquisitionHolder {
	result?: AcquiredArtifact;
}

export interface AcquireStageOptions {
	readonly deps: AcquisitionDeps;
	/** Resolves the acquisition target from the assessment. Future wiring loads
	 * the verified release record and its pinned coordinates here. */
	readonly resolveTarget: (assessment: Assessment) => Promise<AcquisitionTarget>;
	/** Populated on success for downstream stages to consume. */
	readonly holder: AcquisitionHolder;
}

/**
 * Builds the orchestrator's `acquire` stage adapter. On success it publishes
 * the acquired artifact to the holder and reports no findings; a permanent
 * failure becomes the mapped deterministic finding; a transient failure throws
 * `StageTransientError` for the orchestrator to retry.
 */
export function createAcquireStage(options: AcquireStageOptions): StageAdapter {
	return async (ctx: StageContext) => {
		const target = await options.resolveTarget(ctx.assessment);
		const result = await acquireArtifact(options.deps, target);
		if (result.success) {
			options.holder.result = result.value;
			return [];
		}
		const { error } = result;
		if (error.disposition.retry) {
			throw new StageTransientError(
				`artifact acquisition failed (${error.kind}/${error.code}): ${error.message}`,
			);
		}
		return [acquisitionFinding(error, error.disposition.finding)];
	};
}

function acquisitionFinding(
	error: AcquisitionFailure,
	category: AcquisitionFinding,
): NormalizedFinding {
	const isIntegrity = category === "artifact-integrity-failure";
	return {
		source: "deterministic",
		category,
		severity: "critical",
		confidence: 1,
		title: isIntegrity ? "Artifact integrity check failed" : "Plugin bundle rejected",
		publicSummary: isIntegrity
			? "The plugin artifact does not match the checksum in its signed release record."
			: "The plugin bundle is malformed, unsafe, or missing required installable content.",
		privateDetail: `Acquisition failed (${error.kind}/${error.code}) from ${error.source}: ${error.message}`,
		evidenceRefs: [],
		sourceMetadata: { kind: "tool", tool: ACQUISITION_TOOL, version: ACQUISITION_TOOL_VERSION },
	};
}
