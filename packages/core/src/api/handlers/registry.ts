/**
 * Registry installs use aggregator results only for discovery and moderation
 * metadata. The handler reads profile and release records from the publisher's
 * PDS, verifies their repository proofs, then validates the bundle checksum,
 * manifest, policy, and consent before storing or activating executable code.
 * Applicable labels can block installation but cannot supply any verified
 * record, checksum, permission, or executable byte.
 */

import { ClientResponseError, ClientValidationError } from "@atcute/client";
import type { Did } from "@atcute/lexicons";
import { canonicalizeDeclaredAccess } from "@emdash-cms/plugin-types";
import type { CanonicalDeclaredAccess } from "@emdash-cms/plugin-types";
import { checkEnvCompatibility, findSkippedEnvConstraints } from "@emdash-cms/registry-client/env";
import type { HostEnv } from "@emdash-cms/registry-client/env";
import { evaluateRegistryReleaseWithdrawal } from "@emdash-cms/registry-client/withdrawal";
import { NSID } from "@emdash-cms/registry-lexicons";
import {
	fetchReleaseArtifact,
	type ReleaseArtifactReference,
} from "@emdash-cms/registry-verification/artifact";
import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import type { SandboxRunner } from "../../plugins/sandbox/types.js";
import { PluginStateRepository } from "../../plugins/state.js";
import {
	removeAllPluginIndexes,
	syncDeclaredStorageIndexes,
} from "../../plugins/storage-indexes.js";
import { declaredAccessToCapabilities } from "../../plugins/types.js";
import type { DeclaredAccess } from "../../plugins/types.js";
import { fetchRegistryArtifactUrl } from "../../registry/artifact-fetch.js";
import {
	validateRegistryArtifact,
	type RegistryArtifactVerificationCode,
} from "../../registry/artifact-verification.js";
import {
	readAuthoritativePackageRelease,
	verifyAuthoritativePackageRelease,
	type AuthoritativeRecordErrorCode,
	type AuthoritativeRecordReader,
	type AuthoritativeRecordReadOptions,
	type VerifiedAuthoritativeReleaseReport,
	type VerifiedAuthoritativeRecords,
} from "../../registry/authoritative-records.js";
import {
	canonicalCapabilitiesForDriftCheck,
	coerceRegistryConfig,
	parseDurationSeconds,
	releaseExemptFromMinimumAge,
	validateAggregatorUrl,
} from "../../registry/config.js";
import { makeRegistryPluginId } from "../../registry/plugin-id.js";
import { hasCurrentRecordLabel } from "../../registry/record-labels.js";
import type { RegistryConfigInput } from "../../registry/types.js";
import { resolveAndValidateExternalUrlTarget } from "../../security/ssrf.js";
import { EmDashStorageError } from "../../storage/types.js";
import type { Storage } from "../../storage/types.js";
import type { ApiResult } from "../types.js";
import {
	deleteBundleFromR2,
	diffCapabilities,
	diffRouteVisibility,
	loadBundleFromR2,
	storeBundleInR2,
} from "./marketplace.js";

export { assertSafeArtifactUrl } from "../../registry/artifact-fetch.js";

/**
 * Whether two `declaredAccess` blocks grant exactly the same enforced access --
 * the same capabilities AND the same host allow-list. Both are lowered through
 * the canonical converter so that constraint content (`allowedHosts`), not just
 * the capability set, is part of the comparison. The capability-set consent
 * gate is blind to host scope; this is what keeps a bundle from being installed
 * with a wider (or simply different) host allow-list than its published record
 * advertised and the user consented to.
 */
export function enforcedAccessEqual(a: DeclaredAccess, b: DeclaredAccess): boolean {
	const aa = declaredAccessToCapabilities(a);
	const bb = declaredAccessToCapabilities(b);
	return (
		JSON.stringify(aa.capabilities.toSorted()) === JSON.stringify(bb.capabilities.toSorted()) &&
		JSON.stringify(aa.allowedHosts.toSorted()) === JSON.stringify(bb.allowedHosts.toSorted())
	);
}

function verifiedAccessEqual(a: CanonicalDeclaredAccess, b: DeclaredAccess): boolean {
	return JSON.stringify(a) === JSON.stringify(canonicalizeDeclaredAccess(b));
}

// ── Types ──────────────────────────────────────────────────────────

export interface RegistryInstallInput {
	/**
	 * Publisher DID. Required. The browser is expected to resolve
	 * `(handle, slug) → (did, slug)` via the aggregator's
	 * `resolvePackage` XRPC before posting -- the server then skips that
	 * round-trip and looks up the package directly.
	 *
	 * Passing DID rather than handle here means installs work for
	 * publishers whose handle the aggregator couldn't resolve at view
	 * time (handle is "best-effort" per the lexicon -- absent for any
	 * publisher whose DID document didn't resolve cleanly at ingest).
	 */
	did: string;
	/** Package slug (rkey of the publisher's profile record). */
	slug: string;
	/** Optional explicit version. When omitted, the aggregator's latest. */
	version?: string;
	/**
	 * Capabilities the admin acknowledged in the consent dialog, lifted
	 * from the release record's `declaredAccess` block. Compared against
	 * the bundle's `manifest.declaredAccess` to detect drift between
	 * what the admin agreed to and what the bundle actually requests.
	 *
	 * When omitted, drift detection is skipped -- callers that don't
	 * surface a consent UI before posting (e.g. CI scripts) opt out.
	 */
	acknowledgedDeclaredAccess?: unknown;
	acknowledgedMcpTools?: unknown;
	acknowledgedProfileCid?: string;
	acknowledgedReleaseCid?: string;
}

export interface RegistryInstallResult {
	/** Hashed, opaque plugin id used everywhere in the runtime. */
	pluginId: string;
	/** Publisher DID resolved from the handle. */
	publisherDid: string;
	/** Publisher slug (== the registry slug). */
	slug: string;
	/** Installed version. */
	version: string;
	/** Capabilities surfaced from the bundle's manifest. */
	capabilities: string[];
	declaredAccess: DeclaredAccess;
	mcpTools: RegistryMcpConsentTool[];
	verification: RegistryRecordVerificationSummary;
}

export interface RegistryMcpConsentTool {
	name: string;
	description: string;
	route: string;
	permission: string;
	destructive: boolean;
}

export interface RegistryRecordVerificationSummary {
	profileCid: string;
	releaseCid: string;
	provenance: "verified" | "absent-optional";
	policy: {
		requireProvenance: boolean;
		confirmation: "escalation-only" | "always";
		approvers: string[];
	};
}

// ── Helpers ────────────────────────────────────────────────────────

export function registryArtifactError(
	code: RegistryArtifactVerificationCode,
	message: string,
	operation: "install" | "update",
): ApiResult<never> {
	let apiCode: string;
	switch (code) {
		case "BUNDLE_ID_MISMATCH":
			apiCode = operation === "install" ? "MANIFEST_ID_MISMATCH" : "BUNDLE_IDENTITY_MISMATCH";
			break;
		case "BUNDLE_VERSION_MISMATCH":
			apiCode = operation === "install" ? "MANIFEST_VERSION_MISMATCH" : code;
			break;
		case "CHECKSUM_MISMATCH":
		case "INVALID_MULTIHASH":
		case "UNSUPPORTED_MULTIHASH":
			apiCode = "CHECKSUM_MISMATCH";
			break;
		case "FETCH_FAILED":
		case "HOST_REJECTED":
		case "REDIRECT_LIMIT_EXCEEDED":
		case "REDIRECT_LOCATION_MISSING":
		case "RESOURCE_STATUS_ERROR":
		case "RESOURCE_TIMEOUT":
			apiCode = operation === "install" ? "INSTALL_FAILED" : "UPDATE_FAILED";
			break;
		default:
			apiCode = "INVALID_BUNDLE";
	}
	return {
		success: false,
		error: {
			code: apiCode,
			message,
			details: { verificationCode: code },
		},
	};
}

function registryRecordError(
	code: AuthoritativeRecordErrorCode,
	message: string,
): ApiResult<never> {
	return {
		success: false,
		error: {
			code: "RECORD_VERIFICATION_FAILED",
			message,
			details: { verificationCode: code },
		},
	};
}

function recordConsentError(
	input: { profileCid?: string; releaseCid?: string },
	records: VerifiedAuthoritativeRecords,
): ApiResult<never> | null {
	if (!input.profileCid || !input.releaseCid) {
		return {
			success: false,
			error: {
				code: "RECORD_CONSENT_REQUIRED",
				message: "Verify the signed package records before confirming this action.",
			},
		};
	}
	if (input.profileCid !== records.profile.cid || input.releaseCid !== records.release.cid) {
		return {
			success: false,
			error: {
				code: "RECORD_VERIFICATION_DRIFT",
				message: "The signed package records changed after review. Verify them again.",
			},
		};
	}
	return null;
}

function recordVerificationSummary(
	records: VerifiedAuthoritativeRecords,
	report: VerifiedAuthoritativeReleaseReport,
): RegistryRecordVerificationSummary {
	return {
		profileCid: records.profile.cid,
		releaseCid: records.release.cid,
		provenance: report.provenance.status,
		policy: report.value.policy,
	};
}

/**
 * Bytes-per-artifact cap on the gzipped tarball we'll download before
 * decompression. RFC 0001 caps a sandboxed plugin bundle at 256 KiB
 * decompressed (see `MAX_BUNDLE_SIZE` in cli/commands/bundle-utils.ts);
 * gzip on a mix of JSON manifest + JS code typically gives 0.3-0.6
 * ratio, so compressed bundles are well under 200 KiB in practice.
 * 512 KiB leaves margin for unusual file mixes that compress poorly
 * while still rejecting anything that's obviously not a legitimate
 * plugin bundle.
 */
const MAX_ARTIFACT_BYTES = 512 * 1024;

/**
 * Maximum number of HTTP redirects followed during artifact download.
 * Each hop is independently URL-validated, so a malicious server cannot
 * redirect through a series of allowed-looking origins to reach a
 * forbidden one.
 */
const MAX_REDIRECTS = 5;

/**
 * Wall-clock cap on any single artifact fetch attempt (per URL).
 * Defends against slow-loris artifact sources that accept the connection but
 * never finish sending headers or body.
 */
const ARTIFACT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Total wall-clock budget for the artifact-download phase across all
 * advertised caches, the publisher PDS, and the declared URL. Even with the
 * per-URL timeout, unavailable sources could otherwise tie up the install request for
 * minutes; this caps total time at a budget interactive admins can
 * tolerate. Tuned so a fast happy path takes <1s of budget per
 * attempt and a worst case still completes in under a minute.
 */
const ARTIFACT_TOTAL_BUDGET_MS = 45_000;

/**
 * Per-request timeout applied to every aggregator XRPC call
 * (`resolvePackage`, `getLatestRelease`, `listReleases`). Matches the
 * per-URL artifact-fetch cap. Without this, a slow-loris aggregator
 * can stall the install before the artifact phase even starts.
 */
const AGGREGATOR_REQUEST_TIMEOUT_MS = 15_000;

/**
 * Total wall-clock budget for the aggregator-discovery phase
 * (resolve + selected-release lookup). Mirrors the artifact-download
 * budget. Worst case with the pinned-version path's 20-page cap is
 * 20 + 1 calls; capping the total ensures any one stalled call
 * still bounds the whole phase.
 */
const AGGREGATOR_TOTAL_BUDGET_MS = 30_000;

class RegistryArtifactFetchError extends Error {
	constructor(
		readonly code: RegistryArtifactVerificationCode,
		message: string,
	) {
		super(message);
		this.name = "RegistryArtifactFetchError";
	}
}

/** Build a fetch function that enforces a per-request and per-budget timeout. */
function timedFetch(totalDeadline: number): typeof fetch {
	return (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
		const now = Date.now();
		const remaining = Math.max(0, totalDeadline - now);
		if (remaining === 0) {
			return Promise.reject(new Error("Aggregator request budget exhausted"));
		}
		const timeout = Math.min(AGGREGATOR_REQUEST_TIMEOUT_MS, remaining);
		const controller = new AbortController();
		const timer = setTimeout(() => controller.abort(), timeout);
		const callerSignal = init?.signal;
		if (callerSignal) {
			if (callerSignal.aborted) controller.abort(callerSignal.reason);
			else callerSignal.addEventListener("abort", () => controller.abort(callerSignal.reason));
		}
		return fetch(input, { ...init, signal: controller.signal }).finally(() => {
			clearTimeout(timer);
		});
	};
}

async function fetchArtifact(
	artifactCaches: readonly unknown[],
	artifact: ReleaseArtifactReference,
	record: {
		did: string;
		collection: string;
		rkey: string;
		cid: string;
	},
	auth?: unknown,
): Promise<Uint8Array> {
	const result = await fetchReleaseArtifact(
		{
			artifact,
			record,
			artifactCaches,
			...(auth === undefined ? {} : { auth }),
		},
		{
			fetch: async (url, init) => {
				if (!init.signal) throw new Error("Registry artifact fetch requires an abort signal");
				return fetchRegistryArtifactUrl(url.href, {
					signal: init.signal,
					maxResponseBytes: MAX_ARTIFACT_BYTES,
				});
			},
			resolveHostname: async (hostname) =>
				(await resolveAndValidateExternalUrlTarget(`https://${hostname}`)).addresses,
			allowHttpLocalhost: import.meta.env.DEV,
			headerTimeoutMs: ARTIFACT_FETCH_TIMEOUT_MS,
			totalTimeoutMs: ARTIFACT_TOTAL_BUDGET_MS,
			maxBytes: MAX_ARTIFACT_BYTES,
			maxRedirects: MAX_REDIRECTS,
		},
	);
	if (!result.success) {
		throw new RegistryArtifactFetchError(result.error.code, result.error.message);
	}
	return result.value.bytes;
}

/**
 * The shape of a single env-compatibility failure returned to the admin in
 * the `ENV_INCOMPATIBLE` error's `details`.
 */
interface EnvIncompatibleError {
	code: "ENV_INCOMPATIBLE";
	message: string;
	details: { requires: Record<string, string>; host: HostEnv };
}

/**
 * Gate a release's `requires` constraints against the running host
 * environment. `requires` is the lexicon-`unknown` value off the signed
 * release record — never trust its shape; `checkEnvCompatibility` guards it.
 *
 * Returns `null` when every advertised constraint is satisfied (or there are
 * none), or a structured `ENV_INCOMPATIBLE` error naming the unsatisfied
 * constraints and the host versions. The error carries the guarded `requires`
 * and `host` maps so the admin can render the same mismatch the UI gate shows.
 */
export function assertEnvCompatible(
	requires: unknown,
	hostEnv: HostEnv,
): EnvIncompatibleError | null {
	// A constraint the host can't evaluate (unknown or unparseable host
	// version) downgrades the gate to a no-op for that env. Log it so a
	// silent bypass is observable rather than invisible.
	for (const skipped of findSkippedEnvConstraints(requires, hostEnv)) {
		console.warn(
			`[registry] env compatibility constraint skipped: ${skipped.key} requires ${skipped.required} but host version is ${skipped.reason}`,
		);
	}
	const mismatches = checkEnvCompatibility(requires, hostEnv);
	if (mismatches.length === 0) return null;
	const guarded: Record<string, string> = {};
	for (const m of mismatches) guarded[m.key] = m.required;
	const summary = mismatches
		.map((m) => `${m.key} requires ${m.required} but host is ${m.host}`)
		.join("; ");
	return {
		code: "ENV_INCOMPATIBLE",
		message: `This release is not compatible with the current environment: ${summary}.`,
		details: { requires: guarded, host: hostEnv },
	};
}

// ── Install ────────────────────────────────────────────────────────

export async function handleRegistryInstall(
	db: Kysely<Database>,
	storage: Storage | null,
	sandboxRunner: SandboxRunner | null,
	registryConfigInput: RegistryConfigInput | undefined,
	input: RegistryInstallInput,
	opts?: {
		configuredPluginIds?: Set<string>;
		hostEnv?: HostEnv;
		authoritativeRecords?: AuthoritativeRecordReadOptions;
		readAuthoritativeRecords?: AuthoritativeRecordReader;
		verifyOnly?: boolean;
	},
): Promise<ApiResult<RegistryInstallResult>> {
	// Accept either the bare-string shorthand or the full
	// `RegistryConfig` object (see `RegistryConfigInput`).
	const registryConfig = coerceRegistryConfig(registryConfigInput);
	if (!registryConfig) {
		return {
			success: false,
			error: {
				code: "REGISTRY_NOT_CONFIGURED",
				message: "Registry is not configured",
			},
		};
	}

	if (!storage) {
		return {
			success: false,
			error: {
				code: "STORAGE_NOT_CONFIGURED",
				message: "Storage is required for registry plugin installation",
			},
		};
	}

	if (!sandboxRunner || !sandboxRunner.isAvailable()) {
		return {
			success: false,
			error: {
				code: "SANDBOX_NOT_AVAILABLE",
				message: "Sandbox runner is required for registry plugins",
			},
		};
	}

	// Defense in depth: validate the aggregator URL even though the same
	// check runs at config-normalize time. Keeps every entrypoint into
	// `handleRegistryInstall` safe regardless of how the caller obtained
	// the config.
	try {
		validateAggregatorUrl(registryConfig.aggregatorUrl);
	} catch (err) {
		return {
			success: false,
			error: {
				code: "REGISTRY_NOT_CONFIGURED",
				message: err instanceof Error ? err.message : "Invalid aggregator URL",
			},
		};
	}

	const { did, slug, version: requestedVersion } = input;

	// Lazy-load the discovery client. Avoids pulling @atcute/client into
	// every code path that imports core/api/handlers.
	const { DiscoveryClient, registryLabelerPolicy } =
		await import("@emdash-cms/registry-client/discovery");

	// Every aggregator XRPC call passes through `timedFetch`, which
	// enforces a per-request timeout and shares a single total-budget
	// deadline. Defends against a slow-loris aggregator stalling the
	// install before the artifact phase begins.
	const aggregatorDeadline = Date.now() + AGGREGATOR_TOTAL_BUDGET_MS;
	const discovery = new DiscoveryClient({
		aggregatorUrl: registryConfig.aggregatorUrl,
		acceptLabelers: registryConfig.acceptLabelers,
		labelerPolicy: registryLabelerPolicy(registryConfig.acceptLabelers),
		fetch: timedFetch(aggregatorDeadline),
	});

	// Basic shape check on the DID. The browser is expected to send a
	// DID resolved via the aggregator's `resolvePackage`; reject obvious
	// malformations here rather than letting the XRPC call fail
	// opaquely. The lexicon's `did:${string}:${string}` template is the
	// authoritative check.
	if (!did.startsWith("did:") || did.split(":").length < 3) {
		return {
			success: false,
			error: {
				code: "INVALID_DID",
				message: "DID must be a valid atproto DID (e.g. did:plc:abc123)",
			},
		};
	}

	try {
		// Step 1: look up the package by DID + slug. The browser already
		// resolved any handle to a DID via `resolvePackage`; we skip that
		// round-trip and go straight to `getPackage`.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- validated above
		const publisherDid = did as Did;
		const packageView = await discovery.getPackage({
			did: publisherDid,
			slug,
		});

		// Step 2: select the target release.
		// For an explicit version, page through listReleases until we find
		// the matching record; the aggregator returns releases ordered by
		// semver descending. For "latest", use the dedicated convenience
		// endpoint which applies the aggregator's policy filter (yanked
		// exclusion etc.) server-side.
		//
		// Pagination is bounded both by total pages and by repeated-cursor
		// detection: a buggy or compromised aggregator could otherwise
		// return endless distinct cursors that never include the
		// requested version, hanging the install for the platform's
		// request-time budget.
		const MAX_LIST_PAGES = 20; // 20 * 50 limit = 1000 releases worth
		const latestRelease = await (async () => {
			if (!requestedVersion) {
				return discovery.getLatestRelease({
					did: publisherDid,
					package: slug,
				});
			}
			let cursor: string | undefined;
			const seenCursors = new Set<string>();
			for (let page = 0; page < MAX_LIST_PAGES; page++) {
				if (cursor !== undefined) {
					if (seenCursors.has(cursor)) break;
					seenCursors.add(cursor);
				}
				const result = await discovery.listReleases({
					did: publisherDid,
					package: slug,
					cursor,
					limit: 50,
				});
				for (const r of result.releases) {
					if (r.version === requestedVersion) return r;
				}
				if (!result.cursor) break;
				cursor = result.cursor;
			}
			return undefined;
		})();
		const releaseView = latestRelease;

		if (!releaseView) {
			return {
				success: false,
				error: {
					code: "NO_RELEASE",
					message: requestedVersion
						? `Version ${requestedVersion} not found for ${publisherDid}/${slug}`
						: `No installable release found for ${publisherDid}/${slug}`,
				},
			};
		}

		// The aggregator selects the package/version and supplies mirrors and
		// moderation metadata. Its copies of the signed records are not
		// verification inputs.
		if (packageView.did !== publisherDid || packageView.slug !== slug) {
			return {
				success: false,
				error: {
					code: "AGGREGATOR_IDENTITY_MISMATCH",
					message: "Aggregator returned a package view for a different publisher or slug.",
				},
			};
		}
		if (
			releaseView.did !== publisherDid ||
			releaseView.package !== slug ||
			(requestedVersion !== undefined && releaseView.version !== requestedVersion)
		) {
			return {
				success: false,
				error: {
					code: "AGGREGATOR_IDENTITY_MISMATCH",
					message:
						"Aggregator returned a release view that does not match the requested package or version.",
				},
			};
		}

		const version = releaseView.version;
		if (evaluateRegistryReleaseWithdrawal(releaseView, discovery.labelerPolicy).withdrawn) {
			return {
				success: false,
				error: {
					code: "RELEASE_YANKED",
					message: "This release has been withdrawn",
				},
			};
		}

		const authoritative = await (opts?.readAuthoritativeRecords ?? readAuthoritativePackageRelease)(
			publisherDid,
			slug,
			version,
			opts?.authoritativeRecords,
		);
		if (!authoritative.success) {
			return registryRecordError(authoritative.error.code, authoritative.error.message);
		}
		const records = authoritative.value;
		const { profile, release } = records.inspection.value;
		if (
			packageView.uri !== records.profile.uri ||
			packageView.cid !== records.profile.cid ||
			releaseView.uri !== records.release.uri ||
			releaseView.cid !== records.release.cid
		) {
			return {
				success: false,
				error: {
					code: "AGGREGATOR_RECORD_MISMATCH",
					message: "Aggregator metadata does not match the publisher's signed records.",
				},
			};
		}
		if (!opts?.verifyOnly) {
			const consentError = recordConsentError(
				{
					profileCid: input.acknowledgedProfileCid,
					releaseCid: input.acknowledgedReleaseCid,
				},
				records,
			);
			if (consentError) return consentError;
		}

		const packageYanked =
			hasCurrentRecordLabel(packageView.labels ?? [], "security:yanked", records.profile) ||
			hasCurrentRecordLabel(packageView.labels ?? [], "security-yanked", records.profile);
		if (packageYanked) {
			return {
				success: false,
				error: {
					code: "RELEASE_YANKED",
					message: "This release has been withdrawn",
				},
			};
		}

		// Environment compatibility remains an install-safety gate. Listing
		// approval says only that displayed metadata passed moderation. A release
		// may carry a `requires` block (`env:emdash`, `env:astro`, ...). Refuse
		// the install if the running host doesn't satisfy a constraint, so a
		// stale browser tab or non-UI caller can't bypass the admin's
		// disabled Install button. `requires` is lexicon-`unknown`; the
		// helper guards its shape.
		if (opts?.hostEnv) {
			const envError = assertEnvCompatible(release.requires, opts.hostEnv);
			if (envError) return { success: false, error: envError };
		}

		// Step 3a: enforce the configured minimum release age. The browser
		// applies the same check up front for UX, but the gate lives here
		// -- a stale browser tab, a deep link, or a non-admin-UI caller
		// must still hit the holdback. The `minimumReleaseAgeExclude`
		// allowlist short-circuits the check for trusted publisher DIDs.
		//
		// `releaseView.indexedAt` is aggregator operational data, not part
		// of the signed release. The release schema has no publication
		// timestamp, so minimum age remains a local discovery holdback
		// rather than a cryptographic property. A missing or malformed
		// timestamp fails closed.
		// `registryConfig` is the user-supplied integration option, not
		// the normalized manifest shape, so the duration parse runs once
		// per install. Catch a malformed value here -- normally caught at
		// `normalizeRegistryConfig` time, but a future config-mutation
		// path could re-enter with a bad value -- and surface it as a
		// structured error rather than letting it bubble out as a generic
		// 500.
		const minimumReleaseAge = registryConfig.policy?.minimumReleaseAge;
		let minimumReleaseAgeSeconds = 0;
		if (minimumReleaseAge !== undefined) {
			try {
				minimumReleaseAgeSeconds = parseDurationSeconds(minimumReleaseAge);
			} catch (err) {
				return {
					success: false,
					error: {
						code: "REGISTRY_POLICY_INVALID",
						message:
							err instanceof Error
								? err.message
								: "Invalid minimumReleaseAge value in registry config",
					},
				};
			}
		}
		if (minimumReleaseAgeSeconds > 0) {
			const exclude = registryConfig.policy?.minimumReleaseAgeExclude?.map((e) =>
				e.trim().toLowerCase(),
			);
			const exempt = releaseExemptFromMinimumAge(exclude, publisherDid, slug);
			if (!exempt) {
				const indexedAt = Date.parse(releaseView.indexedAt);
				if (!Number.isFinite(indexedAt)) {
					return {
						success: false,
						error: {
							code: "RELEASE_TIMESTAMP_INVALID",
							message:
								"Release record is missing a valid indexed-at timestamp; cannot evaluate minimum release age policy.",
						},
					};
				}
				const ageSeconds = (Date.now() - indexedAt) / 1000;
				if (ageSeconds < minimumReleaseAgeSeconds) {
					const remaining = Math.ceil(minimumReleaseAgeSeconds - ageSeconds);
					return {
						success: false,
						error: {
							code: "RELEASE_TOO_NEW",
							message:
								`This release does not meet the configured minimum release age of ` +
								`${minimumReleaseAgeSeconds}s. It will be installable in ~${remaining}s.`,
						},
					};
				}
			}
		}

		// Derive the normalized opaque plugin id we'll use as the
		// runtime-wide identifier from here on. The publisher_did + slug
		// stay in the state row for update resolution and admin display.
		const pluginId = await makeRegistryPluginId(publisherDid, slug);

		// Block installation if a configured (trusted) plugin shares this
		// id. Mirrors the marketplace install's PLUGIN_ID_CONFLICT check.
		if (opts?.configuredPluginIds?.has(pluginId)) {
			return {
				success: false,
				error: {
					code: "PLUGIN_ID_CONFLICT",
					message: "A configured plugin with the same derived id already exists",
				},
			};
		}

		// Check for an existing install (any source) under the derived id.
		// We reject all pre-existing rows -- if the row is from a registry
		// install of this same package, the caller should go through the
		// (future) update flow; if it's from any other source, the
		// pluginId collision means installing would silently mutate an
		// unrelated plugin's lifecycle row.
		const stateRepo = new PluginStateRepository(db);
		const existing = await stateRepo.get(pluginId);
		if (existing) {
			if (existing.source === "registry") {
				return {
					success: false,
					error: {
						code: "ALREADY_INSTALLED",
						message: `Plugin ${publisherDid}/${slug} is already installed`,
					},
				};
			}
			return {
				success: false,
				error: {
					code: "PLUGIN_ID_COLLISION",
					message:
						`A non-registry plugin already exists at the derived id ${pluginId}. ` +
						"Uninstall it before installing this registry plugin.",
				},
			};
		}

		// Step 6: fetch bytes through an aggregator cache, the publisher PDS,
		// or the URL in the authoritative signed release. Every source remains untrusted.
		const packageArtifact = release.artifacts.package;
		const declaredChecksum = release.artifacts.package.checksum;

		if (!packageArtifact || !declaredChecksum) {
			return {
				success: false,
				error: {
					code: "INVALID_RELEASE",
					message: "Release record is missing its package artifact or checksum",
				},
			};
		}

		let artifactBytes: Uint8Array;
		try {
			artifactBytes = await fetchArtifact(
				releaseView.artifactCaches ?? [],
				packageArtifact,
				{
					did: publisherDid,
					collection: NSID.packageRelease,
					rkey: `${slug}:${version}`,
					cid: releaseView.cid,
				},
				release.auth,
			);
		} catch (error) {
			if (error instanceof RegistryArtifactFetchError) {
				return registryArtifactError(error.code, error.message, "install");
			}
			throw error;
		}

		// Steps 6-7: verify the signed checksum, archive, manifest, and
		// expected package identity with the runtime-neutral verifier used
		// by the release service.
		const artifactReport = await validateRegistryArtifact(
			artifactBytes,
			declaredChecksum,
			slug,
			version,
		);
		if (!artifactReport.success) {
			return registryArtifactError(
				artifactReport.error.code,
				artifactReport.error.message,
				"install",
			);
		}
		const { bundle, artifactDigest, artifactDigests } = artifactReport.value;
		const recordReport = await verifyAuthoritativePackageRelease(records, artifactDigest, {
			...opts?.authoritativeRecords,
			artifactDigests,
		});
		if (!recordReport.success) {
			return registryRecordError(
				recordReport.code,
				recordReport.reasons[0]?.message ?? "The release provenance is invalid.",
			);
		}
		const verification = recordVerificationSummary(records, recordReport);

		// Rewrite the manifest's id to the derived opaque pluginId before
		// it reaches R2 storage or the sandbox loader. The sandbox uses
		// `manifest.id` as its identity for per-plugin storage and bridge
		// calls; addressing it by the same pluginId we use in the runtime
		// cache, R2 prefix, and `_plugin_state` row keeps every layer
		// in sync and prevents registry installs from colliding with
		// marketplace plugins that happen to share the publisher's slug.
		bundle.manifest = { ...bundle.manifest, id: pluginId };

		// Integrity: the bundle that will run MUST declare exactly the access
		// the signed release record advertises. The consent dialog is driven
		// from the record's `declaredAccess`, so a bundle enforcing something
		// different -- a wider host allow-list, an extra capability -- would run
		// outside what the user reviewed. The capability-set consent gate below
		// is blind to constraint content (host scope), so compare the full
		// enforced access of record vs bundle here and refuse on any difference.
		if (
			!verifiedAccessEqual(recordReport.value.declaredAccess, bundle.manifest.declaredAccess ?? {})
		) {
			return {
				success: false,
				error: {
					code: "DECLARED_ACCESS_DRIFT",
					message:
						"The plugin bundle declares different permissions than its published record. Installation refused.",
				},
			};
		}

		// Capability consent gate: the admin MUST acknowledge the
		// capabilities the bundle's manifest actually declares before we
		// install it. The bundle manifest is the runtime enforcement
		// currency; the exact-equality check above binds it to the
		// independently verified signed release.
		//
		// Two outcomes after normalization (filter to strings, dedupe,
		// sort):
		//
		//   1. The bundle declares no capabilities: install is allowed
		//      without any acknowledgement (nothing to consent to).
		//   2. The bundle declares capabilities: install requires the
		//      caller to send `acknowledgedDeclaredAccess`, and the
		//      sorted lists must match exactly.
		//
		// We compare against the bundle's *capabilities* (the legacy
		// shape) for v1 because EmDash's existing sandbox enforces
		// capabilities, not the RFC's structured `declaredAccess`. Once
		// the runtime starts enforcing `declaredAccess` natively, this
		// comparison switches to that shape.
		const actualCapabilities = canonicalCapabilitiesForDriftCheck(bundle.manifest.capabilities);
		if (!opts?.verifyOnly && actualCapabilities.length > 0) {
			if (input.acknowledgedDeclaredAccess === undefined) {
				return {
					success: false,
					error: {
						code: "DECLARED_ACCESS_REQUIRED",
						message:
							"This plugin declares capabilities that require consent. Re-open the install dialog to review and acknowledge them.",
					},
				};
			}
			const acknowledged = canonicalCapabilitiesForDriftCheck(input.acknowledgedDeclaredAccess);
			if (
				acknowledged.length !== actualCapabilities.length ||
				acknowledged.some((cap, i) => cap !== actualCapabilities[i])
			) {
				return {
					success: false,
					error: {
						code: "DECLARED_ACCESS_DRIFT",
						message:
							"Plugin manifest has changed since you consented. Re-open the install dialog to review the new permissions.",
					},
				};
			}
		}

		const actualMcpTools = (bundle.manifest.mcp?.tools ?? []).map(
			({ inputSchema: _, outputSchema: __, ...tool }) => tool,
		);
		if (!opts?.verifyOnly && actualMcpTools.length > 0) {
			if (JSON.stringify(input.acknowledgedMcpTools) !== JSON.stringify(actualMcpTools)) {
				return {
					success: false,
					error: {
						code: "MCP_TOOL_CONSENT_REQUIRED",
						message: "Plugin MCP tools require explicit consent",
						details: { mcpTools: actualMcpTools, verification },
					},
				};
			}
		}

		const result: RegistryInstallResult = {
			pluginId,
			publisherDid,
			slug,
			version,
			capabilities: bundle.manifest.capabilities,
			declaredAccess: recordReport.value.releaseExtension.declaredAccess,
			mcpTools: actualMcpTools,
			verification,
		};
		if (opts?.verifyOnly) return { success: true, data: result };

		// Step 7: store in R2 under the registry prefix.
		await storeBundleInR2(storage, pluginId, version, bundle, "registry");

		// Step 8: write plugin state.
		// Display name and description come from the *package profile*
		// (the signed record from the publisher's repo), not from the
		// bundle manifest -- the manifest carries the trust contract,
		// the profile carries the marketing copy.
		//
		// On failure, we may need to clean up the R2 bundle we just
		// wrote. But two parallel installs of the same (did, slug,
		// version) both pass the earlier `existing` check at line 822
		// (the read is not transactional with the insert), both upload
		// to the same deterministic R2 prefix (overwrites are
		// content-identical because R2 keys include the version and
		// the bundle is checksum-verified upstream), and then one wins
		// the insert while the other fails with a PK constraint
		// violation.
		//
		// If we blindly clean up R2 on every state-write failure, the
		// loser of that race would delete the winner's bundle and the
		// runtime would fail to load the plugin on the next sync.
		//
		// Instead: on state-write failure, re-query the state row. If
		// a row now exists for this pluginId, we lost the race -- the
		// winner owns the R2 bundle and we must not touch it. If the
		// row doesn't exist, the failure was a real DB error and the
		// R2 bytes are orphans; clean them up.
		//
		// Cleanup is best-effort; if it also fails, the row failure
		// still surfaces to the caller and the orphan R2 bundle costs
		// only the storage of a single checksum-verified zip.
		try {
			await stateRepo.upsert(pluginId, version, "active", {
				source: "registry",
				displayName: profile.name ?? slug,
				description: profile.description ?? undefined,
				registryPublisherDid: publisherDid,
				registrySlug: slug,
			});
		} catch (stateErr) {
			let lostRace = false;
			try {
				const winner = await stateRepo.get(pluginId);
				lostRace = winner !== undefined && winner !== null;
			} catch (probeErr) {
				console.warn(
					`[registry-install] Failed to probe state row for ${pluginId} after state-write failure; treating as orphan:`,
					probeErr,
				);
			}
			if (!lostRace) {
				try {
					await deleteBundleFromR2(storage, pluginId, version, "registry");
				} catch (cleanupErr) {
					console.warn(
						`[registry-install] Failed to clean up R2 bundle for ${pluginId}@${version} after state-row write failure:`,
						cleanupErr,
					);
				}
			}
			throw stateErr;
		}

		await syncDeclaredStorageIndexes(db, [bundle.manifest]);

		return {
			success: true,
			data: result,
		};
	} catch (err) {
		if (err instanceof ClientValidationError) {
			return {
				success: false,
				error: {
					code: "AGGREGATOR_RESPONSE_INVALID",
					message: `Aggregator returned a response that does not conform to its lexicon (${err.target})`,
				},
			};
		}
		if (err instanceof ClientResponseError) {
			if (err.error === "ListingUnavailable") {
				return {
					success: false,
					error: {
						code: "LISTING_UNAVAILABLE",
						message: "This plugin is unavailable under the active registry policy",
					},
				};
			}
			return {
				success: false,
				error: {
					code: err.status === 404 ? "AGGREGATOR_NOT_FOUND" : "AGGREGATOR_HTTP_ERROR",
					message: `Aggregator returned ${err.status}: ${err.error}`,
				},
			};
		}
		if (err instanceof EmDashStorageError) {
			return {
				success: false,
				error: {
					code: err.code ?? "STORAGE_ERROR",
					message: "Storage error while installing plugin",
				},
			};
		}
		console.error("[registry-install] Failed:", err);
		return {
			success: false,
			error: {
				code: "INSTALL_FAILED",
				message: err instanceof Error ? err.message : "Failed to install plugin from registry",
			},
		};
	}
}

// ── Uninstall ──────────────────────────────────────────────────────

export interface RegistryUninstallResult {
	pluginId: string;
	/** True when `_plugin_storage` rows were also deleted (opts.deleteData). */
	dataDeleted: boolean;
}

/**
 * Uninstall a registry-source plugin. Deletes the R2 bundle under
 * `registry/<pluginId>/<version>/`, optionally drops the plugin's
 * `_plugin_storage` rows, and removes the `_plugin_state` row. The
 * sandbox runtime is reconciled by the route's `syncRegistryPlugins`
 * call after this returns.
 *
 * Refuses to uninstall plugins whose `source` is not `"registry"` to
 * avoid trashing a marketplace/config plugin that happens to share the
 * pluginId namespace.
 */
export async function handleRegistryUninstall(
	db: Kysely<Database>,
	storage: Storage | null,
	pluginId: string,
	opts?: { deleteData?: boolean },
): Promise<ApiResult<RegistryUninstallResult>> {
	try {
		const stateRepo = new PluginStateRepository(db);
		const existing = await stateRepo.get(pluginId);
		if (!existing || existing.source !== "registry") {
			return {
				success: false,
				error: {
					code: "NOT_FOUND",
					message: `No registry plugin found: ${pluginId}`,
				},
			};
		}

		// `_plugin_state.version` carries the installed version directly for
		// registry-source rows (there's no shadow column like marketplace's
		// `marketplaceVersion`). Use it verbatim for the R2 prefix.
		const version = existing.version;

		// Order: optional storage cleanup → bundle delete → state row delete.
		// The most failure-prone step runs first so a transient DB error
		// (deadlock, contention) cascades to the outer catch with the state
		// row and bundle intact — admin retries safely. Bundle delete is
		// idempotent on misses.
		let dataDeleted = false;
		if (opts?.deleteData) {
			await db.deleteFrom("_plugin_storage").where("plugin_id", "=", pluginId).execute();
			dataDeleted = true;
		}

		if (storage) {
			await deleteBundleFromR2(storage, pluginId, version, "registry");
		}

		try {
			await removeAllPluginIndexes(db, pluginId);
		} catch {
			// Nothing to drop, or tracking table predates the feature
		}

		await stateRepo.delete(pluginId);

		return { success: true, data: { pluginId, dataDeleted } };
	} catch (err) {
		console.error("[registry-uninstall] Failed:", err);
		return {
			success: false,
			error: {
				code: "UNINSTALL_FAILED",
				message: "Failed to uninstall plugin",
			},
		};
	}
}

// ── Update ─────────────────────────────────────────────────────────

export interface RegistryUpdateResult {
	pluginId: string;
	oldVersion: string;
	newVersion: string;
	capabilityChanges: { added: string[]; removed: string[] };
	/** Set only when `newlyPublic` is non-empty, mirroring marketplace. */
	routeVisibilityChanges?: { newlyPublic: string[] };
	verification: RegistryRecordVerificationSummary;
}

/**
 * Update a registry-source plugin to a newer release. Mirrors
 * `handleMarketplaceUpdate`: resolves the target version via the aggregator,
 * re-runs the artifact fetch / checksum / extract pipeline, diffs capabilities
 * and route visibility against the currently installed bundle, and gates
 * escalations behind `confirmCapabilityChanges` / `confirmRouteVisibilityChanges`
 * so the admin re-consents to widened permissions.
 *
 * Refuses non-registry sources. Refuses when the stored state row is missing
 * the `(publisherDid, slug)` it needs to resolve against the aggregator.
 */
export async function handleRegistryUpdate(
	db: Kysely<Database>,
	storage: Storage | null,
	sandboxRunner: SandboxRunner | null,
	registryConfigInput: RegistryConfigInput | undefined,
	pluginId: string,
	opts?: {
		version?: string;
		confirmCapabilityChanges?: boolean;
		confirmRouteVisibilityChanges?: boolean;
		confirmMcpTools?: boolean;
		acknowledgedProfileCid?: string;
		acknowledgedReleaseCid?: string;
		hostEnv?: HostEnv;
		authoritativeRecords?: AuthoritativeRecordReadOptions;
		readAuthoritativeRecords?: AuthoritativeRecordReader;
	},
): Promise<ApiResult<RegistryUpdateResult>> {
	const registryConfig = coerceRegistryConfig(registryConfigInput);
	if (!registryConfig) {
		return {
			success: false,
			error: { code: "REGISTRY_NOT_CONFIGURED", message: "Registry is not configured" },
		};
	}
	if (!storage) {
		return {
			success: false,
			error: {
				code: "STORAGE_NOT_CONFIGURED",
				message: "Storage is required for registry plugin updates",
			},
		};
	}
	if (!sandboxRunner || !sandboxRunner.isAvailable()) {
		return {
			success: false,
			error: { code: "SANDBOX_NOT_AVAILABLE", message: "Sandbox runner is required" },
		};
	}
	try {
		validateAggregatorUrl(registryConfig.aggregatorUrl);
	} catch (err) {
		return {
			success: false,
			error: {
				code: "REGISTRY_NOT_CONFIGURED",
				message: err instanceof Error ? err.message : "Invalid aggregator URL",
			},
		};
	}

	try {
		const stateRepo = new PluginStateRepository(db);
		const existing = await stateRepo.get(pluginId);
		if (!existing || existing.source !== "registry") {
			return {
				success: false,
				error: { code: "NOT_FOUND", message: `No registry plugin found: ${pluginId}` },
			};
		}
		if (!existing.registryPublisherDid || !existing.registrySlug) {
			return {
				success: false,
				error: {
					code: "INVALID_STATE",
					message: `Registry plugin ${pluginId} is missing publisher DID or slug in state`,
				},
			};
		}
		const oldVersion = existing.version;
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- existing.registryPublisherDid is a DID string written by the install handler
		const publisherDid = existing.registryPublisherDid as Did;
		const slug = existing.registrySlug;

		const { DiscoveryClient, registryLabelerPolicy } =
			await import("@emdash-cms/registry-client/discovery");
		const aggregatorDeadline = Date.now() + AGGREGATOR_TOTAL_BUDGET_MS;
		const discovery = new DiscoveryClient({
			aggregatorUrl: registryConfig.aggregatorUrl,
			acceptLabelers: registryConfig.acceptLabelers,
			labelerPolicy: registryLabelerPolicy(registryConfig.acceptLabelers),
			fetch: timedFetch(aggregatorDeadline),
		});

		// Resolve target release. Explicit version → paginate listReleases;
		// otherwise getLatestRelease (aggregator applies its own filters).
		const MAX_LIST_PAGES = 20;
		const releaseView = await (async () => {
			if (!opts?.version) {
				return discovery.getLatestRelease({ did: publisherDid, package: slug });
			}
			let cursor: string | undefined;
			const seenCursors = new Set<string>();
			for (let page = 0; page < MAX_LIST_PAGES; page++) {
				if (cursor !== undefined) {
					if (seenCursors.has(cursor)) break;
					seenCursors.add(cursor);
				}
				const result = await discovery.listReleases({
					did: publisherDid,
					package: slug,
					cursor,
					limit: 50,
				});
				for (const r of result.releases) {
					if (r.version === opts.version) return r;
				}
				if (!result.cursor) break;
				cursor = result.cursor;
			}
			return undefined;
		})();

		if (!releaseView) {
			return {
				success: false,
				error: {
					code: "NO_VERSION",
					message: opts?.version
						? `Version ${opts.version} not found for ${publisherDid}/${slug}`
						: `No installable release found for ${publisherDid}/${slug}`,
				},
			};
		}

		// The aggregator selects the target version and supplies mirrors and
		// moderation metadata. Its release-record copy is not trusted.
		if (
			releaseView.did !== publisherDid ||
			releaseView.package !== slug ||
			(opts?.version !== undefined && releaseView.version !== opts.version)
		) {
			return {
				success: false,
				error: {
					code: "AGGREGATOR_IDENTITY_MISMATCH",
					message:
						"Aggregator returned a release view that does not match the requested package or version.",
				},
			};
		}
		const packageView = await discovery.getPackage({ did: publisherDid, slug });
		if (!packageView || packageView.did !== publisherDid || packageView.slug !== slug) {
			return {
				success: false,
				error: {
					code: "AGGREGATOR_IDENTITY_MISMATCH",
					message: "Aggregator returned a package view that does not match the installed plugin.",
				},
			};
		}

		const newVersion = releaseView.version;
		if (evaluateRegistryReleaseWithdrawal(releaseView, discovery.labelerPolicy).withdrawn) {
			return {
				success: false,
				error: { code: "YANKED", message: "Release has been withdrawn" },
			};
		}
		if (newVersion === oldVersion) {
			return {
				success: false,
				error: {
					code: "ALREADY_UP_TO_DATE",
					message: "Plugin is already at the requested version",
				},
			};
		}
		const authoritative = await (opts?.readAuthoritativeRecords ?? readAuthoritativePackageRelease)(
			publisherDid,
			slug,
			newVersion,
			opts?.authoritativeRecords,
		);
		if (!authoritative.success) {
			return registryRecordError(authoritative.error.code, authoritative.error.message);
		}
		const records = authoritative.value;
		const { profile, release } = records.inspection.value;
		if (
			packageView.uri !== records.profile.uri ||
			packageView.cid !== records.profile.cid ||
			releaseView.uri !== records.release.uri ||
			releaseView.cid !== records.release.cid
		) {
			return {
				success: false,
				error: {
					code: "AGGREGATOR_RECORD_MISMATCH",
					message: "Aggregator metadata does not match the publisher's signed records.",
				},
			};
		}
		const packageYanked =
			hasCurrentRecordLabel(packageView.labels ?? [], "security:yanked", records.profile) ||
			hasCurrentRecordLabel(packageView.labels ?? [], "security-yanked", records.profile);
		if (packageYanked) {
			return {
				success: false,
				error: { code: "YANKED", message: "Package has been withdrawn" },
			};
		}
		if (
			opts?.confirmCapabilityChanges ||
			opts?.confirmRouteVisibilityChanges ||
			opts?.confirmMcpTools
		) {
			const consentError = recordConsentError(
				{
					profileCid: opts.acknowledgedProfileCid,
					releaseCid: opts.acknowledgedReleaseCid,
				},
				records,
			);
			if (consentError) return consentError;
		}
		// Environment compatibility remains independent from listing approval.
		// An ungated update could otherwise
		// land a version whose `requires` the host doesn't satisfy. Same
		// guard as install; `requires` is lexicon-`unknown`.
		if (opts?.hostEnv) {
			const envError = assertEnvCompatible(release.requires, opts.hostEnv);
			if (envError) return { success: false, error: envError };
		}

		const packageArtifact = release.artifacts.package;
		const declaredChecksum = packageArtifact?.checksum;
		if (!packageArtifact || !declaredChecksum) {
			return {
				success: false,
				error: {
					code: "INVALID_RELEASE",
					message: "Release record is missing its package artifact or checksum",
				},
			};
		}

		let artifactBytes: Uint8Array;
		try {
			artifactBytes = await fetchArtifact(
				releaseView.artifactCaches ?? [],
				packageArtifact,
				{
					did: publisherDid,
					collection: NSID.packageRelease,
					rkey: `${slug}:${newVersion}`,
					cid: releaseView.cid,
				},
				release.auth,
			);
		} catch (error) {
			if (error instanceof RegistryArtifactFetchError) {
				return registryArtifactError(error.code, error.message, "update");
			}
			throw error;
		}
		const artifactReport = await validateRegistryArtifact(
			artifactBytes,
			declaredChecksum,
			slug,
			newVersion,
		);
		if (!artifactReport.success) {
			return registryArtifactError(
				artifactReport.error.code,
				artifactReport.error.message,
				"update",
			);
		}
		const { bundle, artifactDigest, artifactDigests } = artifactReport.value;
		const recordReport = await verifyAuthoritativePackageRelease(records, artifactDigest, {
			...opts?.authoritativeRecords,
			artifactDigests,
		});
		if (!recordReport.success) {
			return registryRecordError(
				recordReport.code,
				recordReport.reasons[0]?.message ?? "The release provenance is invalid.",
			);
		}
		const verification = recordVerificationSummary(records, recordReport);

		// Rewrite manifest.id to the opaque pluginId so the sandbox loader
		// and R2 layout stay in sync across install and update.
		bundle.manifest = { ...bundle.manifest, id: pluginId };

		// Integrity: same gate as install. The new bundle must declare exactly
		// the access its signed release record advertises. Without it, an update
		// that changes only the host scope (e.g. api.good.com -> evil.com) keeps
		// the capability set identical, sails through the escalation diff below,
		// and installs a bundle enforcing a scope the record never showed.
		if (
			!verifiedAccessEqual(recordReport.value.declaredAccess, bundle.manifest.declaredAccess ?? {})
		) {
			return {
				success: false,
				error: {
					code: "DECLARED_ACCESS_DRIFT",
					message:
						"The plugin bundle declares different permissions than its published record. Update refused.",
				},
			};
		}

		// Diff capabilities + route visibility against the currently
		// installed bundle. Loading from R2 keeps us honest: the diff is
		// against the bytes the sandbox is actually running, not whatever
		// the state row claims.
		const oldBundle = await loadBundleFromR2(storage, pluginId, oldVersion, "registry");
		const oldCaps = oldBundle?.manifest.capabilities ?? [];
		const capabilityChanges = diffCapabilities(oldCaps, bundle.manifest.capabilities);
		const hasEscalation = capabilityChanges.added.length > 0;
		if (hasEscalation && !opts?.confirmCapabilityChanges) {
			return {
				success: false,
				error: {
					code: "CAPABILITY_ESCALATION",
					message: "Plugin update requires new capabilities",
					details: { capabilityChanges, verification },
				},
			};
		}

		const routeVisibilityChanges = diffRouteVisibility(oldBundle?.manifest, bundle.manifest);
		const hasNewPublicRoutes = routeVisibilityChanges.newlyPublic.length > 0;
		if (hasNewPublicRoutes && !opts?.confirmRouteVisibilityChanges) {
			return {
				success: false,
				error: {
					code: "ROUTE_VISIBILITY_ESCALATION",
					message: "Plugin update exposes new public (unauthenticated) routes",
					details: { routeVisibilityChanges, capabilityChanges, verification },
				},
			};
		}

		const oldMcpTools = [...(oldBundle?.manifest.mcp?.tools ?? [])].toSorted((a, b) =>
			a.name.localeCompare(b.name),
		);
		const newMcpTools = [...(bundle.manifest.mcp?.tools ?? [])].toSorted((a, b) =>
			a.name.localeCompare(b.name),
		);
		if (JSON.stringify(oldMcpTools) !== JSON.stringify(newMcpTools) && !opts?.confirmMcpTools) {
			return {
				success: false,
				error: {
					code: "MCP_TOOL_CONSENT_REQUIRED",
					message: "Plugin update changes its MCP tools",
					details: {
						mcpTools: newMcpTools.map(({ inputSchema: _, outputSchema: __, ...tool }) => tool),
						verification,
					},
				},
			};
		}

		// Store new bundle. R2 prefix is deterministic per (pluginId, version),
		// so a retry of the same update is idempotent.
		await storeBundleInR2(storage, pluginId, newVersion, bundle, "registry");

		// Refresh display metadata from the same signed profile used for
		// release-policy verification.
		await stateRepo.upsert(pluginId, newVersion, "active", {
			source: "registry",
			registryPublisherDid: publisherDid,
			registrySlug: slug,
			displayName: profile.name ?? slug,
			description: profile.description ?? undefined,
			mcpToolsEnabled: false,
			mcpToolsConsent: null,
		});

		await syncDeclaredStorageIndexes(db, [bundle.manifest]);

		// Best-effort cleanup of the old bundle. Failures here don't roll
		// back the upgrade (the new bundle is already stored and committed
		// in the state row); the orphan is just storage we'll pay for.
		deleteBundleFromR2(storage, pluginId, oldVersion, "registry").catch(() => {});

		return {
			success: true,
			data: {
				pluginId,
				oldVersion,
				newVersion,
				capabilityChanges,
				routeVisibilityChanges: hasNewPublicRoutes ? routeVisibilityChanges : undefined,
				verification,
			},
		};
	} catch (err) {
		if (err instanceof ClientValidationError) {
			return {
				success: false,
				error: {
					code: "AGGREGATOR_RESPONSE_INVALID",
					message: `Aggregator returned a response that does not conform to its lexicon (${err.target})`,
				},
			};
		}
		if (err instanceof ClientResponseError) {
			if (err.error === "ListingUnavailable") {
				return {
					success: false,
					error: {
						code: "LISTING_UNAVAILABLE",
						message: "This plugin is unavailable under the active registry policy",
					},
				};
			}
			return {
				success: false,
				error: {
					code: err.status === 404 ? "AGGREGATOR_NOT_FOUND" : "AGGREGATOR_HTTP_ERROR",
					message: `Aggregator returned ${err.status}: ${err.error}`,
				},
			};
		}
		if (err instanceof EmDashStorageError) {
			return {
				success: false,
				error: {
					code: err.code ?? "STORAGE_ERROR",
					message: "Storage error while updating plugin",
				},
			};
		}
		console.error("[registry-update] Failed:", err);
		return {
			success: false,
			error: {
				code: "UPDATE_FAILED",
				message: err instanceof Error ? err.message : "Failed to update plugin",
			},
		};
	}
}

// ── Update check ───────────────────────────────────────────────────

export interface RegistryUpdateCheck {
	pluginId: string;
	installed: string;
	latest: string;
	hasUpdate: boolean;
	/**
	 * Both diff fields are `false` here by design: computing them at
	 * update-check time would require downloading both bundles (or
	 * extracting from the signed release extension and the installed
	 * R2 bundle), which is too expensive for a bulk preview. The actual
	 * escalation gate runs at update time in `handleRegistryUpdate`.
	 * Mirrors marketplace's `hasRouteVisibilityChanges: false`.
	 */
	hasCapabilityChanges: boolean;
	hasRouteVisibilityChanges: boolean;
}

/**
 * Bulk update check across every installed registry plugin. Queries the
 * aggregator for each plugin's latest release and reports `hasUpdate`
 * based on the version comparison. Plugins whose aggregator lookup fails
 * (unreachable, delisted, malformed) are skipped silently — one bad
 * publisher must not blank the whole admin Updates list.
 */
export async function handleRegistryUpdateCheck(
	db: Kysely<Database>,
	registryConfigInput: RegistryConfigInput | undefined,
): Promise<ApiResult<{ items: RegistryUpdateCheck[] }>> {
	const registryConfig = coerceRegistryConfig(registryConfigInput);
	if (!registryConfig) {
		return {
			success: false,
			error: { code: "REGISTRY_NOT_CONFIGURED", message: "Registry is not configured" },
		};
	}

	try {
		const stateRepo = new PluginStateRepository(db);
		const registryPlugins = await stateRepo.getRegistryPlugins();
		if (registryPlugins.length === 0) {
			return { success: true, data: { items: [] } };
		}

		const { DiscoveryClient, registryLabelerPolicy } =
			await import("@emdash-cms/registry-client/discovery");
		const aggregatorDeadline = Date.now() + AGGREGATOR_TOTAL_BUDGET_MS;
		const discovery = new DiscoveryClient({
			aggregatorUrl: registryConfig.aggregatorUrl,
			acceptLabelers: registryConfig.acceptLabelers,
			labelerPolicy: registryLabelerPolicy(registryConfig.acceptLabelers),
			fetch: timedFetch(aggregatorDeadline),
		});

		const items: RegistryUpdateCheck[] = [];
		for (const plugin of registryPlugins) {
			if (!plugin.registryPublisherDid || !plugin.registrySlug) continue;
			try {
				const releaseView = await discovery.getLatestRelease({
					// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- DID string was validated by the install handler
					did: plugin.registryPublisherDid as Did,
					package: plugin.registrySlug,
				});
				if (evaluateRegistryReleaseWithdrawal(releaseView, discovery.labelerPolicy).withdrawn) {
					continue;
				}
				const latest = releaseView.version;
				if (!latest) continue;
				const installed = plugin.version;
				items.push({
					pluginId: plugin.pluginId,
					installed,
					latest,
					hasUpdate: latest !== installed,
					hasCapabilityChanges: false,
					hasRouteVisibilityChanges: false,
				});
			} catch (err) {
				// Skip plugins that can't be checked. Don't fail the whole
				// list because one aggregator query went wrong.
				console.warn(`[registry-update-check] Skipped ${plugin.pluginId}:`, err);
			}
		}

		return { success: true, data: { items } };
	} catch (err) {
		if (err instanceof ClientValidationError) {
			return {
				success: false,
				error: {
					code: "AGGREGATOR_RESPONSE_INVALID",
					message: `Aggregator returned a response that does not conform to its lexicon (${err.target})`,
				},
			};
		}
		if (err instanceof ClientResponseError) {
			return {
				success: false,
				error: {
					code: err.status === 404 ? "AGGREGATOR_NOT_FOUND" : "AGGREGATOR_HTTP_ERROR",
					message: `Aggregator returned ${err.status}: ${err.error}`,
				},
			};
		}
		console.error("[registry-update-check] Failed:", err);
		return {
			success: false,
			error: { code: "UPDATE_CHECK_FAILED", message: "Failed to check for registry updates" },
		};
	}
}
