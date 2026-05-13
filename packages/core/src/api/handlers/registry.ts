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

import type { Handle } from "@atcute/lexicons";
import type { Kysely } from "kysely";

import type { RegistryConfig } from "../../astro/integration/runtime.js";
import type { Database } from "../../database/types.js";
import { extractBundle } from "../../plugins/marketplace.js";
import type { PluginBundle } from "../../plugins/marketplace.js";
import type { SandboxRunner } from "../../plugins/sandbox/types.js";
import { PluginStateRepository } from "../../plugins/state.js";
import {
	parseDurationSeconds,
	releaseExemptFromMinimumAge,
	validateAggregatorUrl,
} from "../../registry/config.js";
import { makeRegistryPluginId } from "../../registry/plugin-id.js";
import { EmDashStorageError } from "../../storage/types.js";
import type { Storage } from "../../storage/types.js";
import type { ApiResult } from "../types.js";
import { storeBundleInR2 } from "./marketplace.js";

// ── Types ──────────────────────────────────────────────────────────

export interface RegistryInstallInput {
	/** Publisher's atproto handle, e.g. `"example.dev"`. */
	handle: string;
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

/**
 * Verify that a multibase multihash string from a release record's
 * `artifact.checksum` field corresponds to the SHA-256 of the given
 * bytes.
 *
 * The lexicon mandates support for sha2-256 (multihash code 0x12) and
 * recommends base32 ('b' prefix) encoding. We accept the canonical
 * `b<base32>` shape and reject anything we can't unambiguously verify.
 * Hash functions other than sha2-256 are out of scope for this initial
 * release; the install fails closed.
 */
async function verifyChecksum(bytes: Uint8Array, checksum: string): Promise<boolean> {
	// Bare hex-sha256 (no multibase prefix) -- accepted as a convenience
	// because PluginBundle.checksum from extractBundle() is plain hex,
	// and registries that haven't fully adopted multibase yet emit hex.
	if (SHA256_HEX_PATTERN.test(checksum)) {
		const actual = await sha256Hex(bytes);
		return checksum.toLowerCase() === actual;
	}

	// Multibase-base32 multihash with sha2-256: 'b' + base32(0x12, 0x20, <32 bytes>).
	// The full decode pipeline (base32 → multihash header → digest bytes →
	// hex) is more code than the trust boundary it gains us today, given
	// the verification step is fundamentally bounded by what algorithm
	// the upstream record chose. Leaving the multibase path for the
	// followup that pairs with full MST verification.
	//
	// For now we fail closed on multibase strings rather than risk a
	// false-positive verification.
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
 * IPv4 octets that resolve to non-routable or loopback addresses. The
 * registry artifact fetcher refuses to make outbound HTTP requests to
 * any host whose hostname is one of these literal addresses, because
 * a compromised aggregator or publisher could otherwise use the
 * EmDash worker as an SSRF stepping stone into the deploy environment
 * (private networks, instance metadata, cloud-provider IMDS).
 *
 * Hostname-based DNS rebinding is not addressed here; the only
 * mitigation that closes that gap is doing the address resolution
 * ourselves and re-checking after connect. Out of scope for this
 * iteration but documented as a follow-up.
 */
const FORBIDDEN_HOSTNAMES = new Set([
	"localhost",
	"localhost.localdomain",
	"ip6-localhost",
	"ip6-loopback",
]);

/** Matches a literal IPv4 address (four dotted decimal octets, 0-255). */
const IPV4_PATTERN = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

/** Trailing dot on a hostname, stripped before URL host comparisons. */
const TRAILING_DOT = /\.$/;

function isForbiddenIPv4(hostname: string): boolean {
	const match = IPV4_PATTERN.exec(hostname);
	if (!match) return false;
	const octets = match.slice(1, 5).map((s) => Number(s));
	if (octets.some((o) => o < 0 || o > 255)) return true; // malformed
	const [a, b] = octets;
	// 127.0.0.0/8 loopback, 10.0.0.0/8 RFC1918, 172.16.0.0/12 RFC1918,
	// 192.168.0.0/16 RFC1918, 169.254.0.0/16 link-local (incl. AWS IMDS),
	// 100.64.0.0/10 CGNAT, 0.0.0.0/8 reserved, 224.0.0.0/4 multicast,
	// 240.0.0.0/4 reserved.
	if (a === 0 || a === 10 || a === 127) return true;
	if (a === 169 && b === 254) return true;
	if (a === 172 && b! >= 16 && b! <= 31) return true;
	if (a === 192 && b === 168) return true;
	if (a === 100 && b! >= 64 && b! <= 127) return true;
	if (a! >= 224) return true;
	return false;
}

function isForbiddenIPv6(hostname: string): boolean {
	// URL.hostname strips brackets, but a leading colon (`::1`) or
	// IPv6 format is enough to identify. We err on the side of rejecting
	// any literal IPv6 address rather than enumerating private ranges
	// (fc00::/7, fe80::/10, ::1/128, etc.) -- legitimate registry
	// artifacts are not served from raw IPv6 literals.
	if (hostname.includes(":")) return true;
	return false;
}

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
 * credentials, and any host that's a loopback / private / link-local
 * literal address.
 *
 * `import.meta.env.DEV` is a Vite/Astro compile-time constant, so
 * production bundles cannot enable the dev escape hatch at runtime.
 */
function assertSafeArtifactUrl(urlString: string): URL {
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

	if (!localhost) {
		if (isForbiddenIPv4(hostname) || isForbiddenIPv6(hostname)) {
			throw new Error(`Artifact URL points to a non-routable address: ${hostname}`);
		}
	}

	return url;
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
		let current = assertSafeArtifactUrl(initialUrl);
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
			current = assertSafeArtifactUrl(next.href);
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

/** Walk artifact source URLs in priority order and return the first that fetches successfully. */
async function fetchArtifact(mirrors: string[], declaredUrl: string): Promise<Uint8Array> {
	// Clamp mirrors regardless of what the lexicon type says -- a buggy
	// or malicious aggregator could return more than the spec'd limit
	// and slow-loris each one. The declared URL is always tried last.
	const clampedMirrors = mirrors.slice(0, MAX_MIRRORS);
	const urls = [...clampedMirrors, declaredUrl];
	const errors: string[] = [];

	const totalDeadline = Date.now() + ARTIFACT_TOTAL_BUDGET_MS;

	for (const url of urls) {
		if (Date.now() >= totalDeadline) {
			errors.push("(total artifact download budget exhausted)");
			break;
		}
		try {
			return await fetchWithLimits(url, totalDeadline);
		} catch (err) {
			errors.push(`${url}: ${err instanceof Error ? err.message : String(err)}`);
		}
	}

	throw new Error(`Failed to download artifact from any source. Tried:\n  ${errors.join("\n  ")}`);
}

// ── Install ────────────────────────────────────────────────────────

export async function handleRegistryInstall(
	db: Kysely<Database>,
	storage: Storage | null,
	sandboxRunner: SandboxRunner | null,
	registryConfig: RegistryConfig | undefined,
	input: RegistryInstallInput,
	opts?: { configuredPluginIds?: Set<string> },
): Promise<ApiResult<RegistryInstallResult>> {
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

	const { handle, slug, version: requestedVersion } = input;

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

	// Basic shape check on the handle. Aggregator's lexicon types the
	// param as `${string}.${string}`, but the handler accepts a plain
	// string from request bodies; reject malformed shapes here rather
	// than letting the XRPC call fail opaquely. Full RFC 3986 handle
	// validation is the aggregator's job.
	if (!handle.includes(".")) {
		return {
			success: false,
			error: {
				code: "INVALID_HANDLE",
				message: "Handle must be a domain-like identifier (e.g. example.dev)",
			},
		};
	}

	try {
		// Step 1: resolve (handle, slug) → (did, slug)
		// Cast: the validation above ensures `handle` matches the lexicon's
		// `${string}.${string}` shape.
		const packageView = await discovery.resolvePackage({
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape validated above
			handle: handle as Handle,
			slug,
		});
		const publisherDid = packageView.did;

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
						? `Version ${requestedVersion} not found for ${handle}/${slug}`
						: `No installable release found for ${handle}/${slug}`,
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
		const minimumReleaseAge = registryConfig.policy?.minimumReleaseAge;
		const minimumReleaseAgeSeconds =
			minimumReleaseAge !== undefined ? parseDurationSeconds(minimumReleaseAge) : 0;
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
						message: `Plugin ${handle}/${slug} is already installed`,
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

		// Drift check: capabilities the admin acknowledged must match
		// what the bundle's manifest actually declares. Aggregator-side
		// label envelope and release-record `declaredAccess` are
		// independent assertions; this catches the case where they
		// diverged between the consent dialog and the install POST.
		if (
			input.acknowledgedDeclaredAccess !== undefined &&
			JSON.stringify(input.acknowledgedDeclaredAccess) !==
				JSON.stringify(bundle.manifest.capabilities)
		) {
			// We compare against the bundle's *capabilities* (the legacy
			// shape) for v1 because EmDash's existing sandbox enforces
			// capabilities, not the RFC's structured `declaredAccess`.
			// Once the runtime starts enforcing `declaredAccess` natively,
			// this comparison switches to that shape. Until then the
			// admin UI lifts capabilities from the release record's
			// extension data and the comparison is meaningful.
			return {
				success: false,
				error: {
					code: "DECLARED_ACCESS_DRIFT",
					message:
						"Plugin manifest has changed since you consented. Re-open the install dialog to review the new permissions.",
				},
			};
		}

		// Step 7: store in R2 under the registry prefix.
		await storeBundleInR2(storage, pluginId, version, bundle, "registry");

		// Step 8: write plugin state.
		// Display name and description come from the *package profile*
		// (the signed record from the publisher's repo), not from the
		// bundle manifest -- the manifest carries the trust contract,
		// the profile carries the marketing copy.
		const profile = packageView.profile as { name?: string; description?: string };
		await stateRepo.upsert(pluginId, version, "active", {
			source: "registry",
			displayName: profile.name ?? slug,
			description: profile.description ?? undefined,
			registryPublisherDid: publisherDid,
			registrySlug: slug,
		});

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
