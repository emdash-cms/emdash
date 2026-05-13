/**
 * Registry plugin install handler.
 *
 * Installs a plugin published to the experimental decentralized plugin
 * registry described in RFC 0001. The install flow:
 *
 *   1. Resolve `(handle, slug)` to a publisher DID via the configured
 *      aggregator's `resolvePackage` XRPC.
 *   2. Look up the requested release (or the policy-filtered latest one)
 *      via `getLatestRelease` / `listReleases`.
 *   3. Reject the install if the aggregator surfaces a `security:yanked`
 *      hard-enforcement label or the release is below the configured
 *      minimum release age.
 *   4. Fetch the bundle artifact, walking aggregator mirrors first and
 *      falling back to the publisher-declared URL.
 *   5. Verify the artifact's multibase checksum against the signed
 *      release record's `artifacts.package.checksum`.
 *   6. Extract `manifest.json` + `backend.js` + optional `admin.js` from
 *      the gzipped tar bundle.
 *   7. Store the extracted files in site-local R2 under the
 *      `registry/<plugin-id>/<version>/` prefix.
 *   8. Write a `plugin_states` row with `source = "registry"` and the
 *      `(publisher_did, slug)` pair so updates can be resolved later.
 *   9. Sync the runtime so the plugin becomes active immediately.
 *
 * Known gaps (tracked separately):
 *
 *   - The aggregator-supplied records are not yet cryptographically
 *     verified against the publisher's MST signature. The signed bytes
 *     and CIDs are passed through verbatim per the lexicon, but full
 *     PDS-direct verification with proof traversal is follow-up work.
 *     The artifact checksum is verified end-to-end against the value
 *     in the (aggregator-relayed) release record, which is the actual
 *     trust boundary for the bytes that end up in the sandbox.
 *   - `acceptLabelers` is forwarded as-is to the aggregator; this
 *     handler does not independently re-fetch and verify labels from
 *     each labeller's DID. Aggregator label envelope tampering is
 *     mitigated by the artifact checksum but not detected.
 */

import type { Did } from "@atcute/lexicons";
import type { Kysely } from "kysely";

import type { Database } from "../../database/types.js";
import { extractBundle } from "../../plugins/marketplace.js";
import type { PluginBundle } from "../../plugins/marketplace.js";
import type { SandboxRunner } from "../../plugins/sandbox/types.js";
import { PluginStateRepository } from "../../plugins/state.js";
import {
	canonicalCapabilitiesForDriftCheck,
	coerceRegistryConfig,
	parseDurationSeconds,
	releaseExemptFromMinimumAge,
	validateAggregatorUrl,
} from "../../registry/config.js";
import { makeRegistryPluginId } from "../../registry/plugin-id.js";
import type { RegistryConfigInput } from "../../registry/types.js";
import { resolveAndValidateExternalUrl, SsrfError } from "../../security/ssrf.js";
import { EmDashStorageError } from "../../storage/types.js";
import type { Storage } from "../../storage/types.js";
import type { ApiResult } from "../types.js";
import { deleteBundleFromR2, storeBundleInR2 } from "./marketplace.js";

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
}

// ── Helpers ────────────────────────────────────────────────────────

/** Matches a bare 64-character lowercase/uppercase hex SHA-256 digest. */
const SHA256_HEX_PATTERN = /^[a-f0-9]{64}$/i;

/** Compute the SHA-256 of `bytes` as a lowercase hex string. */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Uint8Array is a valid BufferSource at runtime
	const buf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
	const arr = new Uint8Array(buf);
	return Array.from(arr, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** multihash code for sha2-256 (single-byte varint). */
const MULTIHASH_SHA256_CODE = 0x12;
/** sha2-256 digest length in bytes (single-byte varint). */
const MULTIHASH_SHA256_LENGTH = 0x20;

/**
 * Compute the multibase-multihash sha2-256 checksum of `bytes`, in the
 * same `b<base32>` shape the registry CLI publishes
 * (`packages/registry-cli/src/multihash.ts`). Returns a 56-character
 * string starting with `b`.
 *
 * The trust contract is: if both sides produce the same string for
 * the same bytes, the bytes are unchanged. We don't decode the
 * publisher-supplied checksum -- we just re-encode our own and compare,
 * which is equivalent and avoids needing a base32 decoder.
 */
async function sha256MultibaseMultihash(bytes: Uint8Array): Promise<string> {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- Uint8Array is a valid BufferSource at runtime
	const digestBuf = await crypto.subtle.digest("SHA-256", bytes as unknown as BufferSource);
	const digest = new Uint8Array(digestBuf);
	const multihash = new Uint8Array(2 + digest.length);
	multihash[0] = MULTIHASH_SHA256_CODE;
	multihash[1] = MULTIHASH_SHA256_LENGTH;
	multihash.set(digest, 2);
	const { toBase32 } = await import("@atcute/multibase");
	return `b${toBase32(multihash)}`;
}

/**
 * Verify that a checksum string from a release record's
 * `artifact.checksum` field corresponds to the SHA-256 of the given
 * bytes.
 *
 * Accepts two formats:
 *
 *   - Bare lowercase/uppercase hex SHA-256 (64 chars). Convenience for
 *     publishers / tools that emit hex rather than multibase.
 *   - Multibase-multihash with the `b` (base32) prefix and sha2-256.
 *     This is the format RFC 0001 mandates and the registry CLI emits
 *     (see `packages/registry-cli/src/multihash.ts`).
 *
 * Hash functions other than sha2-256 are out of scope for this
 * initial release; the install fails closed.
 */
async function verifyChecksum(bytes: Uint8Array, checksum: string): Promise<boolean> {
	if (SHA256_HEX_PATTERN.test(checksum)) {
		const actual = await sha256Hex(bytes);
		return checksum.toLowerCase() === actual;
	}

	// Multibase-base32 multihash with sha2-256. We re-encode our own
	// digest in the same shape and compare strings -- equivalent to
	// decoding and comparing bytes, but doesn't need a base32 decoder.
	// 56 chars = 'b' + base32(34 bytes) = 'b' + 55 chars.
	if (checksum.length === 56 && checksum.startsWith("b")) {
		const actual = await sha256MultibaseMultihash(bytes);
		// Case-insensitive: multibase 'b' is lowercase by convention but
		// some emitters use uppercase. RFC 4648 base32 alphabets are
		// case-insensitive.
		return actual.toLowerCase() === checksum.toLowerCase();
	}

	return false;
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
 * Defends against slow-loris mirrors that accept the connection but
 * never finish sending headers or body.
 */
const ARTIFACT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Total wall-clock budget for the artifact-download phase across all
 * mirrors and the declared URL. Even with the per-URL timeout, a
 * malicious mirror list could otherwise tie up the install request for
 * minutes; this caps total time at a budget interactive admins can
 * tolerate. Tuned so a fast happy path takes <1s of budget per
 * attempt and a worst case still completes in under a minute.
 */
const ARTIFACT_TOTAL_BUDGET_MS = 45_000;

/**
 * Cap on the number of mirror URLs we try before falling back to the
 * publisher-declared URL. Matches the aggregator lexicon's
 * `mirrors` array length cap (16) but enforced here independently so
 * a misbehaving aggregator can't slow-loris us through hundreds of
 * URLs.
 */
const MAX_MIRRORS = 16;

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

/**
 * Localhost-equivalent hostnames the artifact fetcher rejects in
 * production. The full literal-IP / DNS-rebinding blocklist lives in
 * `#security/ssrf.js` and is invoked via `resolveAndValidateExternalUrl`
 * below; this small set exists only because the artifact handler has
 * a dev-mode escape hatch that lets `http://localhost` through.
 */
const FORBIDDEN_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
]);

/** Trailing dot on a hostname, stripped before URL host comparisons. */
const TRAILING_DOT = /\.$/;

/** Hostnames that resolve to the local machine; rejected outright in production. */
function isLocalhostHostname(hostname: string): boolean {
	// WHATWG URL preserves brackets on IPv6 hostnames; strip them before
	// comparison so `[::1]` is recognised as localhost.
	const stripped = hostname.toLowerCase().replace(TRAILING_DOT, "");
	const h = stripped.startsWith("[") && stripped.endsWith("]") ? stripped.slice(1, -1) : stripped;
	if (FORBIDDEN_HOSTNAMES.has(h)) return true;
	if (h === "localhost") return true;
	if (h.endsWith(".localhost")) return true;
	if (h === "127.0.0.1" || h === "::1") return true;
	if (h.startsWith("::ffff:127.") || h.startsWith("::ffff:7f00:")) return true;
	return false;
}

/**
 * Validate that `urlString` is a safe outbound target for artifact
 * downloads. Rejects non-HTTPS (except localhost in dev), embedded
 * credentials, any host that's a loopback / private / link-local
 * literal address, and any hostname whose resolved A or AAAA records
 * point at one of those addresses (closes the DNS-rebinding gap).
 *
 * Wraps `resolveAndValidateExternalUrl` from the import-pipeline SSRF
 * module so both code paths share one DoH cache, one resolver, one
 * blocklist, and one set of regression tests. Layers an
 * artifact-specific protocol/dev-localhost policy on top.
 *
 * `import.meta.env.DEV` is a Vite/Astro compile-time constant, so
 * production bundles cannot enable the dev escape hatch at runtime.
 */
async function assertSafeArtifactUrl(urlString: string): Promise<URL> {
	let url: URL;
	try {
		url = new URL(urlString);
	} catch {
		throw new Error(`Invalid artifact URL: ${urlString}`);
	}
	if (url.protocol !== "https:" && url.protocol !== "http:") {
		throw new Error(`Artifact URL protocol not allowed: ${url.protocol}`);
	}
	if (url.username || url.password) {
		throw new Error("Artifact URL must not contain embedded credentials");
	}

	const rawHostname = url.hostname.toLowerCase().replace(TRAILING_DOT, "");
	// Strip brackets so the IPv4/IPv6 checks see the canonical form.
	const hostname =
		rawHostname.startsWith("[") && rawHostname.endsWith("]")
			? rawHostname.slice(1, -1)
			: rawHostname;
	const localhost = isLocalhostHostname(hostname);

	// In production: reject HTTP entirely and reject localhost over any
	// protocol -- a publisher pointing at `https://localhost` is still
	// trying to bounce the server through its own loopback interface.
	if (!import.meta.env.DEV) {
		if (url.protocol === "http:") {
			throw new Error("Artifact URL must use https");
		}
		if (localhost) {
			throw new Error(`Artifact URL points to localhost: ${hostname}`);
		}
	} else if (url.protocol === "http:" && !localhost) {
		// Dev mode: http allowed only for localhost.
		throw new Error("Artifact URL must use https (http allowed only for localhost in dev)");
	}

	if (localhost) {
		// Dev-only path; nothing to resolve.
		return url;
	}

	// Delegate IP-literal + DNS-rebinding validation to the import
	// pipeline's SSRF helper. Adapts the SsrfError to the existing
	// artifact-URL error vocabulary so callers keep their current
	// catch shape.
	try {
		return await resolveAndValidateExternalUrl(url.href);
	} catch (err) {
		if (err instanceof SsrfError) {
			throw new Error(`Artifact URL rejected: ${err.message}`);
		}
		throw err;
	}
}

/**
 * Fetch one URL with manual redirect handling so every hop is
 * URL-validated, a hard byte cap so a malicious response body cannot
 * exhaust memory before the checksum check rejects it, and a wall-clock
 * timeout that covers connect, headers, and body together. The timeout
 * is the minimum of the per-URL cap and the remaining total budget so
 * a late-arriving mirror still respects the install's global budget.
 */
async function fetchWithLimits(initialUrl: string, totalDeadline: number): Promise<Uint8Array> {
	const now = Date.now();
	const remaining = Math.max(0, totalDeadline - now);
	if (remaining === 0) {
		throw new Error("Artifact download budget exhausted");
	}
	const perUrlTimeout = Math.min(ARTIFACT_FETCH_TIMEOUT_MS, remaining);
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), perUrlTimeout);
	try {
		let current = await assertSafeArtifactUrl(initialUrl);
		let response: Response;
		for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
			response = await fetch(current.href, { redirect: "manual", signal: controller.signal });
			if (response.status < 300 || response.status >= 400) break;
			const location = response.headers.get("location");
			if (!location) break;
			if (hop === MAX_REDIRECTS) {
				throw new Error(`Too many redirects fetching artifact (>${MAX_REDIRECTS})`);
			}
			const next = new URL(location, current);
			current = await assertSafeArtifactUrl(next.href);
		}
		// eslint-disable-next-line @typescript-eslint/no-non-null-assertion -- response is assigned in the first loop iteration
		const finalResponse = response!;
		if (!finalResponse.ok) {
			throw new Error(`HTTP ${finalResponse.status}`);
		}

		// Check Content-Length up front when present. Untrusted servers can
		// lie or omit it; the streaming cap below is the real defense.
		const lengthHeader = finalResponse.headers.get("content-length");
		if (lengthHeader) {
			const declared = Number(lengthHeader);
			if (Number.isFinite(declared) && declared > MAX_ARTIFACT_BYTES) {
				throw new Error(
					`Artifact too large (declared ${declared} bytes, limit ${MAX_ARTIFACT_BYTES})`,
				);
			}
		}

		const body = finalResponse.body;
		if (!body) {
			// Workers can't return a null body for a normal GET; defensive fallback.
			const buf = new Uint8Array(await finalResponse.arrayBuffer());
			if (buf.byteLength > MAX_ARTIFACT_BYTES) {
				throw new Error(`Artifact too large (limit ${MAX_ARTIFACT_BYTES} bytes)`);
			}
			return buf;
		}

		const reader = body.getReader();
		const chunks: Uint8Array[] = [];
		let total = 0;
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			if (!value) continue;
			total += value.byteLength;
			if (total > MAX_ARTIFACT_BYTES) {
				try {
					await reader.cancel();
				} catch {
					// nothing to do
				}
				throw new Error(`Artifact too large (limit ${MAX_ARTIFACT_BYTES} bytes)`);
			}
			chunks.push(value);
		}

		const out = new Uint8Array(total);
		let offset = 0;
		for (const chunk of chunks) {
			out.set(chunk, offset);
			offset += chunk.byteLength;
		}
		return out;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Strip query string and fragment from a URL for use in
 * client-visible error messages. Registry artifacts are often hosted
 * on storage backends that include presigned tokens in the query
 * string; surfacing the raw URL on a failed install leaks those
 * tokens into the admin's HTTP response and any log drain that
 * captures the error chain. Origin + pathname is enough to identify
 * the host and resource without exposing credentials.
 *
 * Falls back to a generic placeholder when the URL is malformed.
 */
function redactUrlForError(raw: string): string {
	try {
		const u = new URL(raw);
		return `${u.origin}${u.pathname}`;
	} catch {
		return "<malformed url>";
	}
}

/** Walk artifact source URLs in priority order and return the first that fetches successfully. */
async function fetchArtifact(mirrors: string[], declaredUrl: string): Promise<Uint8Array> {
	// Clamp mirrors regardless of what the lexicon type says -- a buggy
	// or malicious aggregator could return more than the spec'd limit
	// and slow-loris each one. The declared URL is always tried last.
	const clampedMirrors = mirrors.slice(0, MAX_MIRRORS);
	const urls = [...clampedMirrors, declaredUrl];
	// Client-visible errors carry redacted URLs (origin + path only).
	// The full URL with any query-string token is logged server-side
	// so operators can still debug delivery failures.
	const clientErrors: string[] = [];

	const totalDeadline = Date.now() + ARTIFACT_TOTAL_BUDGET_MS;

	for (const url of urls) {
		if (Date.now() >= totalDeadline) {
			clientErrors.push("(total artifact download budget exhausted)");
			break;
		}
		try {
			return await fetchWithLimits(url, totalDeadline);
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			console.warn(`[registry-install] Artifact fetch failed from ${url}:`, message);
			clientErrors.push(`${redactUrlForError(url)}: ${message}`);
		}
	}

	throw new Error(
		`Failed to download artifact from any source. Tried:\n  ${clientErrors.join("\n  ")}`,
	);
}

// ── Install ────────────────────────────────────────────────────────

export async function handleRegistryInstall(
	db: Kysely<Database>,
	storage: Storage | null,
	sandboxRunner: SandboxRunner | null,
	registryConfigInput: RegistryConfigInput | undefined,
	input: RegistryInstallInput,
	opts?: { configuredPluginIds?: Set<string> },
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
	const { DiscoveryClient } = await import("@emdash-cms/registry-client/discovery");

	// Every aggregator XRPC call passes through `timedFetch`, which
	// enforces a per-request timeout and shares a single total-budget
	// deadline. Defends against a slow-loris aggregator stalling the
	// install before the artifact phase begins.
	const aggregatorDeadline = Date.now() + AGGREGATOR_TOTAL_BUDGET_MS;
	const discovery = new DiscoveryClient({
		aggregatorUrl: registryConfig.aggregatorUrl,
		acceptLabelers: registryConfig.acceptLabelers,
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

		// Identity cross-check on every field the aggregator denormalises
		// onto the package and release views. A buggy or compromised
		// aggregator could otherwise return a release view for a
		// different `(did, slug, version)` than we asked for; the
		// handler would then fetch + checksum-verify + install bytes
		// under the requested package's pluginId but for a different
		// publisher's record. Checksum verification only proves the bytes
		// match the *returned* record, not that the record belongs to
		// the package we requested.
		const signedRelease = releaseView.release as
			| { package?: unknown; version?: unknown }
			| null
			| undefined;
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
			signedRelease?.package !== slug ||
			(requestedVersion !== undefined && releaseView.version !== requestedVersion) ||
			signedRelease?.version !== releaseView.version
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

		// Step 3: takedown label check (hard-enforced via aggregator's
		// `atproto-accept-labelers` filtering, but we belt-and-suspenders
		// the package-level labels too).
		const yanked = (packageView.labels ?? []).some(
			(l: { val?: string }) => l.val === "security:yanked",
		);
		const releaseYanked = (releaseView.labels ?? []).some(
			(l: { val?: string }) => l.val === "security:yanked",
		);
		if (yanked || releaseYanked) {
			return {
				success: false,
				error: {
					code: "RELEASE_YANKED",
					message: "This release has been withdrawn (security:yanked label).",
				},
			};
		}

		// Step 3a: enforce the configured minimum release age. The browser
		// applies the same check up front for UX, but the gate lives here
		// -- a stale browser tab, a deep link, or a non-admin-UI caller
		// must still hit the holdback. The `minimumReleaseAgeExclude`
		// allowlist short-circuits the check for trusted publisher DIDs.
		//
		// Caveat: `releaseView.indexedAt` is aggregator-supplied envelope
		// data, not a signed timestamp. A compromised aggregator can
		// claim an arbitrary indexed-at date and bypass the holdback;
		// closing this gap requires fetching the release record's
		// signed createdAt from the publisher's PDS (deferred to the
		// follow-up that adds full MST verification). If the timestamp
		// is missing or malformed, we fail closed and reject the install.
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

		// Step 4: fetch the artifact bytes.
		// The signed release record is `releaseView.release`; the lexicon
		// types it as `unknown` so we extract the package artifact via
		// duck-typed access. Mirrors come from the envelope (aggregator
		// operational data, not part of the signed record).
		const release = releaseView.release as {
			artifacts?: {
				package?: { url?: string; checksum?: string };
			};
		};
		const declaredUrl = release.artifacts?.package?.url;
		const declaredChecksum = release.artifacts?.package?.checksum;

		if (!declaredUrl || !declaredChecksum) {
			return {
				success: false,
				error: {
					code: "INVALID_RELEASE",
					message: "Release record is missing artifact url or checksum",
				},
			};
		}

		const mirrors = releaseView.mirrors ?? [];
		const artifactBytes = await fetchArtifact(mirrors, declaredUrl);

		// Step 5: verify the bytes against the signed record's checksum.
		const checksumOk = await verifyChecksum(artifactBytes, declaredChecksum);
		if (!checksumOk) {
			return {
				success: false,
				error: {
					code: "CHECKSUM_MISMATCH",
					message:
						"Artifact bytes do not match the release record's checksum, or the checksum encoding is unsupported.",
				},
			};
		}

		// Step 6: extract the bundle.
		let bundle: PluginBundle;
		try {
			bundle = await extractBundle(artifactBytes);
		} catch (err) {
			return {
				success: false,
				error: {
					code: "INVALID_BUNDLE",
					message: err instanceof Error ? err.message : "Failed to extract plugin bundle",
				},
			};
		}

		// Manifest sanity: declared version must match the release's version.
		if (bundle.manifest.version !== version) {
			return {
				success: false,
				error: {
					code: "MANIFEST_VERSION_MISMATCH",
					message: `Bundle manifest version (${bundle.manifest.version}) does not match release version (${version})`,
				},
			};
		}

		// Manifest identity: the bundle's `manifest.id` is the publisher's
		// natural plugin id (their slug). It MUST equal the slug the
		// install was requested for; otherwise a malicious registry bundle
		// could declare `manifest.id: "audit-log"` and confuse the sandbox
		// bridge, which uses `manifest.id` as the trust key for
		// per-plugin storage, cron schedules, and bridge-scoped
		// operations.
		if (bundle.manifest.id !== slug) {
			return {
				success: false,
				error: {
					code: "MANIFEST_ID_MISMATCH",
					message: `Bundle manifest id (${bundle.manifest.id}) does not match registry slug (${slug})`,
				},
			};
		}

		// Rewrite the manifest's id to the derived opaque pluginId before
		// it reaches R2 storage or the sandbox loader. The sandbox uses
		// `manifest.id` as its identity for per-plugin storage and bridge
		// calls; addressing it by the same pluginId we use in the runtime
		// cache, R2 prefix, and `_plugin_state` row keeps every layer
		// in sync and prevents registry installs from colliding with
		// marketplace plugins that happen to share the publisher's slug.
		bundle.manifest = { ...bundle.manifest, id: pluginId };

		// Capability consent gate: the admin MUST acknowledge the
		// capabilities the bundle's manifest actually declares before we
		// install it. The bundle manifest is the only source of truth
		// the runtime sandbox enforces -- the release record's
		// `declaredAccess` extension is an aggregator-supplied
		// assertion that the publisher may or may not have included,
		// and trusting it would let a malicious publisher (or a
		// compromised aggregator) ship a bundle whose manifest
		// requests `content:*` etc. behind an empty consent dialog.
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
		if (actualCapabilities.length > 0) {
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
		const profile = packageView.profile as { name?: string; description?: string };
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

		return {
			success: true,
			data: {
				pluginId,
				publisherDid,
				slug,
				version,
				capabilities: bundle.manifest.capabilities,
			},
		};
	} catch (err) {
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
