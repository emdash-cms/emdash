/**
 * Registry API client
 *
 * The admin UI talks to two distinct services for registry features:
 *
 *   - **Browse / search / detail**: directly to the configured aggregator
 *     via `@emdash-cms/registry-client`'s `DiscoveryClient`. The
 *     aggregator is a public, CORS-enabled atproto AppView; no server
 *     proxy is needed.
 *   - **Install**: POST to the EmDash server (which holds the sandbox,
 *     R2, and `_plugin_state` table). The server re-resolves the same
 *     `(handle, slug)` against the aggregator, re-verifies the bundle,
 *     and writes the install. The browser is the consent UI; the server
 *     is the install actor.
 *
 * The discovery client is constructed lazily so we only pull
 * `@atcute/client` into the admin bundle when the registry path is
 * actually exercised. Sites with no `experimental.registry` config never
 * pay the cost (verified at ~2 KB gzip when it does load).
 */

import type { Did, Handle } from "@atcute/lexicons";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import { API_BASE, apiFetch, throwResponseError } from "./client.js";

export type { Did, Handle };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Registry configuration carried on the EmDash manifest. The browser
 * reads this on app boot and passes the relevant fields into the
 * DiscoveryClient and the latest-release policy filter.
 */
export interface RegistryClientConfig {
	aggregatorUrl: string;
	acceptLabelers?: string;
	policy?: {
		minimumReleaseAgeSeconds?: number;
		minimumReleaseAgeExclude?: string[];
	};
}

/**
 * Lightweight aliases for the lexicon-generated types. The hooks return
 * the raw XRPC output -- callers narrow `profile` / `release` as needed
 * (they're typed as `unknown` by the lexicon because the signed records
 * are pass-through).
 */
export interface RegistryPackageView {
	uri: string;
	cid: string;
	did: string;
	handle?: string;
	slug: string;
	indexedAt: string;
	latestVersion?: string;
	profile: unknown;
	labels?: Array<{ val: string; src?: string; uri?: string }>;
}

export interface RegistryReleaseView {
	uri: string;
	cid: string;
	did: string;
	package: string;
	version: string;
	indexedAt: string;
	mirrors?: string[];
	release: unknown;
	labels?: Array<{ val: string; src?: string; uri?: string }>;
}

export interface RegistrySearchResult {
	packages: RegistryPackageView[];
	cursor?: string;
}

export interface RegistrySearchOpts {
	q?: string;
	cursor?: string;
	limit?: number;
}

export interface RegistryInstallRequest {
	did: string;
	slug: string;
	version?: string;
	acknowledgedDeclaredAccess?: unknown;
}

export interface RegistryInstallResult {
	pluginId: string;
	publisherDid: string;
	slug: string;
	version: string;
	capabilities: string[];
}

// ---------------------------------------------------------------------------
// Discovery client (lazy)
// ---------------------------------------------------------------------------

interface WrappedDiscoveryClient {
	searchPackages: (opts: RegistrySearchOpts) => Promise<RegistrySearchResult>;
	resolvePackage: (handle: string, slug: string) => Promise<RegistryPackageView>;
	getPackage: (did: string, slug: string) => Promise<RegistryPackageView>;
	getLatestRelease: (did: string, slug: string) => Promise<RegistryReleaseView>;
	listReleases: (
		did: string,
		slug: string,
		cursor?: string,
	) => Promise<{ releases: RegistryReleaseView[]; cursor?: string }>;
}

let cachedDiscovery: {
	config: RegistryClientConfig;
	client: WrappedDiscoveryClient;
} | null = null;

async function getDiscoveryClient(config: RegistryClientConfig): Promise<WrappedDiscoveryClient> {
	if (
		cachedDiscovery &&
		cachedDiscovery.config.aggregatorUrl === config.aggregatorUrl &&
		cachedDiscovery.config.acceptLabelers === config.acceptLabelers
	) {
		return cachedDiscovery.client;
	}

	const mod = await import("@emdash-cms/registry-client/discovery");
	const DiscoveryClient = mod.DiscoveryClient;
	const discovery = new DiscoveryClient({
		aggregatorUrl: config.aggregatorUrl,
		acceptLabelers: config.acceptLabelers,
	});

	const wrapped: WrappedDiscoveryClient = {
		async searchPackages(opts: RegistrySearchOpts) {
			const result = await discovery.searchPackages({
				q: opts.q,
				cursor: opts.cursor,
				limit: opts.limit,
			});
			return result as RegistrySearchResult;
		},
		async resolvePackage(handle: string, slug: string) {
			const result = await discovery.resolvePackage({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- shape validated by aggregator
				handle: handle as Handle,
				slug,
			});
			return result as RegistryPackageView;
		},
		async getPackage(did: string, slug: string) {
			const result = await discovery.getPackage({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did shape validated by aggregator
				did: did as Did,
				slug,
			});
			return result as RegistryPackageView;
		},
		async getLatestRelease(did: string, slug: string) {
			const result = await discovery.getLatestRelease({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did shape validated by aggregator
				did: did as Did,
				package: slug,
			});
			return result as RegistryReleaseView;
		},
		async listReleases(did: string, slug: string, cursor?: string) {
			const result = await discovery.listReleases({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did shape validated by aggregator
				did: did as Did,
				package: slug,
				cursor,
			});
			return result as { releases: RegistryReleaseView[]; cursor?: string };
		},
	};

	cachedDiscovery = { config, client: wrapped };
	return wrapped;
}

// ---------------------------------------------------------------------------
// Latest-release policy filter
// ---------------------------------------------------------------------------

/**
 * Returns whether a release should be considered installable given the
 * configured policy. Currently implements the minimum-release-age check
 * described in RFC 0001's "Pre-label gap and launch tempo" section,
 * plus the `minimumReleaseAgeExclude` allowlist.
 *
 * Returns `false` (release blocked) when the policy is configured but
 * the release is missing a valid `indexedAt` -- we fail closed rather
 * than silently letting unbounded-age releases through.
 */
export function releasePassesPolicy(
	release: RegistryReleaseView,
	pkg: { did: string; slug: string },
	policy: RegistryClientConfig["policy"],
	now: number = Date.now(),
): boolean {
	if (!policy?.minimumReleaseAgeSeconds) return true;
	if (releaseExemptFromMinimumAge(policy.minimumReleaseAgeExclude, pkg.did, pkg.slug)) {
		return true;
	}
	const indexedAt = Date.parse(release.indexedAt);
	if (!Number.isFinite(indexedAt)) return false;
	const ageSeconds = (now - indexedAt) / 1000;
	return ageSeconds >= policy.minimumReleaseAgeSeconds;
}

/**
 * Canonicalize a capabilities list for set-style comparison. Mirrors
 * the server-side helper `canonicalCapabilitiesForDriftCheck` in
 * `packages/core/src/registry/config.ts` -- both sides must produce
 * the same canonical shape so the install handler's drift check is
 * stable across reorderings, duplicates, and junk entries.
 *
 * Filters non-strings, deduplicates, and sorts lexically.
 */
export function canonicalCapabilitiesForDriftCheck(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	const seen = new Set<string>();
	for (const entry of value) {
		if (typeof entry === "string" && entry.length > 0) {
			seen.add(entry);
		}
	}
	return [...seen].toSorted();
}

/**
 * Matches a `(publisher_did, slug)` against the
 * `minimumReleaseAgeExclude` allowlist. Mirrors the server-side helper
 * of the same name in `packages/core/src/registry/config.ts`.
 *
 * DID-only on purpose: handles are aggregator-supplied envelope data
 * and accepting them as a trust input would let a compromised
 * aggregator bypass the holdback by claiming any handle for any
 * package. DIDs are tied to the AT URI of the record itself.
 *
 * Entries from the config list have already been lowercased at
 * manifest build time, so this only needs to lowercase the runtime
 * values for comparison.
 */
export function releaseExemptFromMinimumAge(
	exclude: readonly string[] | undefined,
	publisherDid: string,
	slug: string,
): boolean {
	if (!exclude || exclude.length === 0) return false;
	const didLower = publisherDid.toLowerCase();
	const slugLower = slug.toLowerCase();
	const fullDid = `${didLower}/${slugLower}`;

	for (const entry of exclude) {
		if (entry === didLower) return true;
		if (entry === fullDid) return true;
	}
	return false;
}

// ---------------------------------------------------------------------------
// Public discovery hooks (callable by React Query)
// ---------------------------------------------------------------------------

export async function searchRegistryPackages(
	config: RegistryClientConfig,
	opts: RegistrySearchOpts,
): Promise<RegistrySearchResult> {
	const client = await getDiscoveryClient(config);
	return client.searchPackages(opts);
}

export async function resolveRegistryPackage(
	config: RegistryClientConfig,
	handle: string,
	slug: string,
): Promise<RegistryPackageView> {
	const client = await getDiscoveryClient(config);
	return client.resolvePackage(handle, slug);
}

export async function getRegistryPackage(
	config: RegistryClientConfig,
	did: string,
	slug: string,
): Promise<RegistryPackageView> {
	const client = await getDiscoveryClient(config);
	return client.getPackage(did, slug);
}

export async function getLatestRegistryRelease(
	config: RegistryClientConfig,
	did: string,
	slug: string,
): Promise<RegistryReleaseView> {
	const client = await getDiscoveryClient(config);
	return client.getLatestRelease(did, slug);
}

export async function listRegistryReleases(
	config: RegistryClientConfig,
	did: string,
	slug: string,
	cursor?: string,
): Promise<{ releases: RegistryReleaseView[]; cursor?: string }> {
	const client = await getDiscoveryClient(config);
	return client.listReleases(did, slug, cursor);
}

/**
 * Resolve a publisher DID to its claimed handle using the same
 * `LocalActorResolver` pattern as `@emdash-cms/registry-cli` and
 * `@emdash-cms/auth-atproto`. Bidirectional verification (handle's
 * domain points back to the same DID) is part of the resolver --
 * `LocalActorResolver` returns the sentinel `"handle.invalid"` when
 * the `alsoKnownAs` handle is present but doesn't round-trip.
 *
 * Three distinct outcomes the UI can render:
 *
 *   - `{ status: "ok", handle }` — verified handle, round-trip OK.
 *   - `{ status: "invalid" }` — DID claims a handle but it doesn't
 *     resolve back. The publisher's handle setup is broken; the admin
 *     should see a clear "Invalid handle" indicator rather than the
 *     raw DID.
 *   - `{ status: "missing" }` — no handle claimed at all (no
 *     `alsoKnownAs`), or the DID document couldn't be fetched (network
 *     error, unsupported DID method).
 */
let actorResolver: import("@atcute/identity-resolver").LocalActorResolver | null = null;
async function getActorResolver(): Promise<import("@atcute/identity-resolver").LocalActorResolver> {
	if (actorResolver) return actorResolver;
	const {
		CompositeDidDocumentResolver,
		CompositeHandleResolver,
		DohJsonHandleResolver,
		LocalActorResolver,
		PlcDidDocumentResolver,
		WebDidDocumentResolver,
		WellKnownHandleResolver,
	} = await import("@atcute/identity-resolver");
	actorResolver = new LocalActorResolver({
		handleResolver: new CompositeHandleResolver({
			methods: {
				dns: new DohJsonHandleResolver({ dohUrl: "https://cloudflare-dns.com/dns-query" }),
				http: new WellKnownHandleResolver(),
			},
		}),
		didDocumentResolver: new CompositeDidDocumentResolver({
			methods: {
				plc: new PlcDidDocumentResolver(),
				web: new WebDidDocumentResolver(),
			},
		}),
	});
	return actorResolver;
}

export type DidHandleResolution =
	| { status: "ok"; handle: string }
	| { status: "invalid" }
	| { status: "missing" };

/**
 * localStorage-backed cache for DID→handle resolutions. Handles are
 * stable for hours-to-days in practice, but bound the cache so a
 * compromised handle eventually flips back to "invalid" without a
 * forced refresh. 24h matches the typical atproto handle TTL.
 *
 * Failures (network errors, unsupported DID method) are *not* cached --
 * those should retry on the next render.
 */
const HANDLE_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const HANDLE_CACHE_KEY_PREFIX = "emdash:did-handle:";

interface CachedResolution {
	resolution: DidHandleResolution;
	expiresAt: number;
}

function readHandleCache(did: string): DidHandleResolution | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(`${HANDLE_CACHE_KEY_PREFIX}${did}`);
		if (!raw) return null;
		const parsed = JSON.parse(raw) as CachedResolution;
		if (!parsed || typeof parsed.expiresAt !== "number" || parsed.expiresAt < Date.now()) {
			return null;
		}
		return parsed.resolution;
	} catch {
		return null;
	}
}

function writeHandleCache(did: string, resolution: DidHandleResolution): void {
	if (typeof localStorage === "undefined") return;
	try {
		const entry: CachedResolution = { resolution, expiresAt: Date.now() + HANDLE_CACHE_TTL_MS };
		localStorage.setItem(`${HANDLE_CACHE_KEY_PREFIX}${did}`, JSON.stringify(entry));
	} catch {
		// quota exceeded or storage disabled; drop silently
	}
}

export async function resolveDidToHandle(did: string): Promise<DidHandleResolution> {
	const cached = readHandleCache(did);
	if (cached) return cached;

	let result: DidHandleResolution;
	try {
		const resolver = await getActorResolver();
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- caller's DID has the right shape
		const resolved = await resolver.resolve(did as Did);
		if (resolved.handle === "handle.invalid") {
			result = { status: "invalid" };
		} else if (resolved.handle) {
			result = { status: "ok", handle: resolved.handle };
		} else {
			result = { status: "missing" };
		}
	} catch (err) {
		// Network / DID-method failure: don't cache, so a transient
		// outage doesn't poison the cache for 24h. Log so a publisher
		// debugging "why is my handle not resolving?" can see the cause.
		console.warn(`[registry] DID->handle resolution failed for ${did}:`, err);
		return { status: "missing" };
	}

	writeHandleCache(did, result);
	return result;
}

// ---------------------------------------------------------------------------
// Install (server POST)
// ---------------------------------------------------------------------------

const INSTALL_ENDPOINT = `${API_BASE}/admin/plugins/registry/install`;

/**
 * Install a plugin from the registry.
 *
 * Posts to the EmDash server, which re-resolves the same `(handle,
 * slug)` against the aggregator, re-verifies the bundle's checksum
 * against the signed release record, and writes the install. Surfaces
 * structured error codes (`RELEASE_YANKED`, `CHECKSUM_MISMATCH`,
 * `DECLARED_ACCESS_DRIFT`, etc.) that callers map to localized
 * messages.
 */
export async function installRegistryPlugin(
	body: RegistryInstallRequest,
): Promise<RegistryInstallResult> {
	const response = await apiFetch(INSTALL_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to install plugin`));
	const json = (await response.json()) as { data: RegistryInstallResult };
	return json.data;
}
