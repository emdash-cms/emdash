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
import type {
	ValidatedListReleases,
	ValidatedPackageView,
	ValidatedReleaseView,
	ValidatedSearchPackages,
} from "@emdash-cms/registry-client/discovery";
import { hostEnvFromVersions } from "@emdash-cms/registry-client/env";
import type { HostEnv } from "@emdash-cms/registry-client/env";
import { i18n } from "@lingui/core";
import { msg } from "@lingui/core/macro";

import {
	API_BASE,
	apiFetch,
	parseApiResponse,
	throwResponseError,
	type AdminManifest,
} from "./client.js";

export type { Did, Handle };
export type { HostEnv };

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
 * Re-exports of the registry-client view types. `DiscoveryClient` validates
 * the embedded signed `profile` / `release` records against their lexicons
 * at the read-side trust boundary, so they arrive here as the typed lexicon
 * shape or `null` when the aggregator returned a non-conforming record.
 * Callers must null-check; they no longer need to shape-narrow.
 */
export type RegistryPackageView = ValidatedPackageView;
export type RegistryReleaseView = ValidatedReleaseView;
export type RegistrySearchResult = ValidatedSearchPackages;

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
		opts?: { cursor?: string; limit?: number },
	) => Promise<ValidatedListReleases>;
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
			return discovery.searchPackages({
				q: opts.q,
				cursor: opts.cursor,
				limit: opts.limit,
			});
		},
		async resolvePackage(handle: string, slug: string) {
			return discovery.resolvePackage({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did/handle shape validated by aggregator
				handle: handle as Handle,
				slug,
			});
		},
		async getPackage(did: string, slug: string) {
			return discovery.getPackage({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did shape validated by aggregator
				did: did as Did,
				slug,
			});
		},
		async getLatestRelease(did: string, slug: string) {
			return discovery.getLatestRelease({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did shape validated by aggregator
				did: did as Did,
				package: slug,
			});
		},
		async listReleases(did: string, slug: string, opts?: { cursor?: string; limit?: number }) {
			return discovery.listReleases({
				// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did shape validated by aggregator
				did: did as Did,
				package: slug,
				cursor: opts?.cursor,
				limit: opts?.limit,
			});
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
	opts?: { cursor?: string; limit?: number },
): Promise<ValidatedListReleases> {
	const client = await getDiscoveryClient(config);
	return client.listReleases(did, slug, opts);
}

/**
 * Derive the host environment versions (`env:emdash`, `env:astro`) the running
 * EmDash install advertises, so a release's `requires` constraints can be
 * evaluated client-side before offering install. Reads the already-fetched
 * admin manifest (`version`, `astroVersion`) rather than issuing a second
 * request. The dev-skip / astro-omit rule is shared with the server gate via
 * `hostEnvFromVersions`.
 */
export function hostEnvFromManifest(manifest: AdminManifest | undefined): HostEnv {
	return hostEnvFromVersions(manifest?.version, manifest?.astroVersion);
}

/**
 * Resolve a publisher DID to its claimed handle using the same
 * `LocalActorResolver` pattern as `@emdash-cms/plugin-cli` and
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

function isCachedResolution(value: unknown): value is CachedResolution {
	if (typeof value !== "object" || value === null) return false;
	// eslint-disable-next-line typescript-eslint/no-unsafe-type-assertion -- narrowed to non-null object above; field shapes validated below
	const candidate = value as Record<string, unknown>;
	return (
		typeof candidate.expiresAt === "number" &&
		typeof candidate.resolution === "object" &&
		candidate.resolution !== null
	);
}

function readHandleCache(did: string): DidHandleResolution | null {
	if (typeof localStorage === "undefined") return null;
	try {
		const raw = localStorage.getItem(`${HANDLE_CACHE_KEY_PREFIX}${did}`);
		if (!raw) return null;
		const parsed: unknown = JSON.parse(raw);
		if (!isCachedResolution(parsed) || parsed.expiresAt < Date.now()) {
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
	return parseApiResponse<RegistryInstallResult>(response, i18n._(msg`Failed to install plugin`));
}

// ---------------------------------------------------------------------------
// Lifecycle: update + uninstall
// ---------------------------------------------------------------------------

export interface RegistryUpdateOpts {
	version?: string;
	confirmCapabilityChanges?: boolean;
	confirmRouteVisibilityChanges?: boolean;
}

export interface RegistryUninstallOpts {
	deleteData?: boolean;
}

/**
 * Server-side escalation gate raised by the update endpoint when the
 * target version widens the trust contract. Carries the diff the user
 * needs to see in the consent dialog before the call is retried with the
 * matching `confirm*` flag.
 */
export class RegistryUpdateEscalationError extends Error {
	readonly code: "CAPABILITY_ESCALATION" | "ROUTE_VISIBILITY_ESCALATION";
	readonly capabilityChanges: { added: string[]; removed: string[] };
	readonly routeVisibilityChanges?: { newlyPublic: string[] };
	constructor(
		code: "CAPABILITY_ESCALATION" | "ROUTE_VISIBILITY_ESCALATION",
		message: string,
		capabilityChanges: { added: string[]; removed: string[] },
		routeVisibilityChanges?: { newlyPublic: string[] },
	) {
		super(message);
		this.name = "RegistryUpdateEscalationError";
		this.code = code;
		this.capabilityChanges = capabilityChanges;
		this.routeVisibilityChanges = routeVisibilityChanges;
	}
}

/**
 * Update a registry-source plugin to a newer version.
 * `POST /_emdash/api/admin/plugins/registry/:id/update`
 *
 * Called without `confirm*` flags first, this throws
 * `RegistryUpdateEscalationError` when the target version widens
 * permissions; the caller renders a consent dialog populated from the
 * error's diff, then re-calls with the matching `confirm*` flag once
 * the user agrees.
 */
export async function updateRegistryPlugin(
	pluginId: string,
	opts: RegistryUpdateOpts = {},
): Promise<void> {
	const response = await apiFetch(
		`${API_BASE}/admin/plugins/registry/${encodeURIComponent(pluginId)}/update`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(opts),
		},
	);
	if (response.ok) return;

	const body: unknown = await response
		.clone()
		.json()
		.catch(() => undefined);
	const escalation = parseEscalation(body);
	if (escalation) throw escalation;
	await throwResponseError(response, i18n._(msg`Failed to update plugin`));
}

function parseEscalation(body: unknown): RegistryUpdateEscalationError | null {
	if (!body || typeof body !== "object" || !("error" in body)) return null;
	const error = body.error;
	if (!error || typeof error !== "object" || !("code" in error)) return null;
	const code = error.code;
	if (code !== "CAPABILITY_ESCALATION" && code !== "ROUTE_VISIBILITY_ESCALATION") return null;
	const details =
		"details" in error && error.details && typeof error.details === "object" ? error.details : {};
	const capabilityChanges = normaliseCapabilityChanges(
		"capabilityChanges" in details ? details.capabilityChanges : undefined,
	);
	const routeVisibilityChanges = normaliseRouteVisibilityChanges(
		"routeVisibilityChanges" in details ? details.routeVisibilityChanges : undefined,
	);
	const message =
		"message" in error && typeof error.message === "string"
			? error.message
			: i18n._(msg`Plugin update requires re-consent`);
	return new RegistryUpdateEscalationError(
		code,
		message,
		capabilityChanges,
		routeVisibilityChanges,
	);
}

function normaliseCapabilityChanges(value: unknown): { added: string[]; removed: string[] } {
	if (!value || typeof value !== "object") return { added: [], removed: [] };
	const v = value as { added?: unknown; removed?: unknown };
	return {
		added: Array.isArray(v.added) ? v.added.filter((s): s is string => typeof s === "string") : [],
		removed: Array.isArray(v.removed)
			? v.removed.filter((s): s is string => typeof s === "string")
			: [],
	};
}

function normaliseRouteVisibilityChanges(value: unknown): { newlyPublic: string[] } | undefined {
	if (!value || typeof value !== "object") return undefined;
	const v = value as { newlyPublic?: unknown };
	if (!Array.isArray(v.newlyPublic)) return undefined;
	const newlyPublic = v.newlyPublic.filter((s): s is string => typeof s === "string");
	return newlyPublic.length > 0 ? { newlyPublic } : undefined;
}

/**
 * Uninstall a registry-source plugin.
 * `POST /_emdash/api/admin/plugins/registry/:id/uninstall`
 *
 * The server refuses to uninstall non-registry sources, so calling this
 * with a marketplace or config plugin id is a no-op error rather than a
 * destructive cross-source action.
 */
export async function uninstallRegistryPlugin(
	pluginId: string,
	opts: RegistryUninstallOpts = {},
): Promise<void> {
	const response = await apiFetch(
		`${API_BASE}/admin/plugins/registry/${encodeURIComponent(pluginId)}/uninstall`,
		{
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(opts),
		},
	);
	if (!response.ok) await throwResponseError(response, i18n._(msg`Failed to uninstall plugin`));
}
