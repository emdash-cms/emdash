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
 *
 * Moderation and env-compat helpers import from `@emdash-cms/registry-client`'s
 * `/moderation` and `/env` subpaths, not its package root -- the root entry
 * re-exports the CLI's publishing/credentials surface too, which pulls in
 * Node-only modules (`node:fs/promises`) that don't exist in the browser.
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
import {
	evaluateReleaseViews,
	isModerationBlocking,
	resolveAcceptedPolicy,
	type AcceptedLabelerPolicy,
	type ReleaseModeration,
} from "@emdash-cms/registry-client/moderation";
import { i18n } from "@lingui/core";
import type { MessageDescriptor } from "@lingui/core";
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
export { evaluateReleaseViews, isModerationBlocking, resolveAcceptedPolicy };
export type { AcceptedLabelerPolicy, ReleaseModeration };

/**
 * Union of two accepted-labeler policies, deduped by DID with `redact` OR-ed.
 * Used when package-scope and release-scope labels arrive on separate
 * responses (each with its own `atproto-content-labelers` header): a labeler
 * either response honored is honored for the combined evaluation, so a
 * package/publisher block filtered out of one response's policy is still
 * surfaced. A union only adds label sources; it can never drop a real block.
 */
export function unionAcceptedPolicies(
	a: AcceptedLabelerPolicy[],
	b: AcceptedLabelerPolicy[],
): AcceptedLabelerPolicy[] {
	const byDid = new Map<string, boolean>();
	for (const policy of [...a, ...b]) {
		byDid.set(policy.did, (byDid.get(policy.did) ?? false) || policy.redact);
	}
	return Array.from(byDid, ([did, redact]) => ({ did, redact }));
}

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

// ---------------------------------------------------------------------------
// Moderation
// ---------------------------------------------------------------------------

/**
 * Evaluates a package's package/publisher-scope moderation state without a
 * specific release in view. Browse cards render every package from one
 * `searchPackages` response, before any release has been fetched, so there is
 * no `ValidatedReleaseView` to evaluate against yet.
 *
 * Mirrors `@emdash-cms/plugin-cli`'s `evaluatePackageModeration`: the stub
 * release's `uri`/`cid` can never match a real label's `uri`/`cid`, so
 * release-scope automated blocks and warnings are excluded by construction,
 * not by omission.
 */
export function evaluatePackageModeration(
	packageView: RegistryPackageView,
	accepted: AcceptedLabelerPolicy[],
): ReleaseModeration {
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- stub is never a real record, only compared against label uris that can never equal these placeholders
	const releaseStub = {
		uri: "",
		cid: "",
		did: packageView.did,
		package: packageView.slug,
		version: "",
		indexedAt: packageView.indexedAt,
		release: null,
	} as unknown as RegistryReleaseView;

	return evaluateReleaseViews({
		packageView,
		releaseView: releaseStub,
		publisherDid: packageView.did,
		accepted,
	});
}

/**
 * Hardcoded display text for the moderation label vocabulary, following the
 * `CAPABILITY_LABELS` precedent in `marketplace.ts`. Sourced from
 * `apps/labeler/fixtures/moderation-policy.json`'s label list and
 * `@emdash-cms/registry-moderation`'s `ModerationLabelValue` union.
 *
 * Unknown values (a labeler-issued value this map hasn't been updated for
 * yet) are data, not an error -- `describeModerationLabel` falls back to the
 * raw value rather than throwing or hiding the label.
 */
export const MODERATION_LABEL_TEXT: Record<
	string,
	{ name: MessageDescriptor; description: MessageDescriptor }
> = {
	"assessment-passed": {
		name: msg`Assessment passed`,
		description: msg`This release passed its required moderation assessment.`,
	},
	"assessment-overridden": {
		name: msg`Assessment overridden`,
		description: msg`A reviewer manually approved this release, superseding the automated outcome.`,
	},
	"assessment-pending": {
		name: msg`Assessment pending`,
		description: msg`This release's moderation assessment hasn't completed yet.`,
	},
	"assessment-error": {
		name: msg`Assessment error`,
		description: msg`This release's moderation assessment failed to complete.`,
	},
	malware: {
		name: msg`Malware`,
		description: msg`The release contains code intentionally designed to cause harm.`,
	},
	"data-exfiltration": {
		name: msg`Data exfiltration`,
		description: msg`The release sends protected data somewhere it shouldn't.`,
	},
	"credential-harvesting": {
		name: msg`Credential harvesting`,
		description: msg`The release captures or transmits credentials deceptively.`,
	},
	"supply-chain-compromise": {
		name: msg`Supply-chain compromise`,
		description: msg`Evidence suggests a dependency or build artifact was tampered with.`,
	},
	"critical-vulnerability": {
		name: msg`Critical vulnerability`,
		description: msg`A critical security vulnerability was found in this release.`,
	},
	"artifact-integrity-failure": {
		name: msg`Artifact integrity failure`,
		description: msg`The downloaded bundle doesn't match the checksum in the signed release.`,
	},
	"invalid-bundle": {
		name: msg`Invalid bundle`,
		description: msg`The installable bundle is malformed, unsafe, or incomplete.`,
	},
	"undeclared-access": {
		name: msg`Undeclared access`,
		description: msg`The bundle behaves outside of what its declared permissions cover.`,
	},
	impersonation: {
		name: msg`Impersonation`,
		description: msg`This release impersonates another identity, project, or product.`,
	},
	"suspicious-code": {
		name: msg`Suspicious code`,
		description: msg`The code shows concerning patterns, though evidence is inconclusive.`,
	},
	"obfuscated-code": {
		name: msg`Obfuscated code`,
		description: msg`Material parts of the code are intentionally difficult to inspect.`,
	},
	"privacy-risk": {
		name: msg`Privacy risk`,
		description: msg`The release creates a privacy concern that isn't blocking.`,
	},
	"misleading-metadata": {
		name: msg`Misleading metadata`,
		description: msg`The listing's metadata or screenshots don't match its actual behavior.`,
	},
	"low-quality": {
		name: msg`Low quality`,
		description: msg`The release doesn't provide meaningful functionality.`,
	},
	"broken-release": {
		name: msg`Broken release`,
		description: msg`The bundle is structurally valid but doesn't work as described.`,
	},
	"package-disputed": {
		name: msg`Package disputed`,
		description: msg`This package has an unresolved ownership or policy dispute.`,
	},
	"security-yanked": {
		name: msg`Security yanked`,
		description: msg`A reviewer withdrew this release for security reasons.`,
	},
	"publisher-compromised": {
		name: msg`Publisher compromised`,
		description: msg`This publisher's identity is believed to be compromised.`,
	},
	"!takedown": {
		name: msg`Taken down`,
		description: msg`An administrator issued an emergency takedown action.`,
	},
};

/**
 * Resolves a moderation label value to its localized display text. Falls
 * back to the raw value (with no description) for a value this map doesn't
 * cover -- an unrecognised label is data the UI still must render, not an
 * error to hide or throw on.
 */
export function describeModerationLabel(value: string): {
	name: string;
	description: string | null;
} {
	const entry = MODERATION_LABEL_TEXT[value];
	if (!entry) return { name: value, description: null };
	return { name: i18n._(entry.name), description: i18n._(entry.description) };
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

/**
 * A discovery result paired with the `atproto-content-labelers` header the
 * aggregator sent back for THIS specific response. Moderation evaluation
 * must use this header (via `resolveAcceptedPolicy`), not just the site's
 * statically configured `acceptLabelers` -- the aggregator reports what it
 * actually applied, which can differ per-request.
 */
type WithContentLabelers<T> = T & { contentLabelers?: string };

let cachedDiscoveryModule: typeof import("@emdash-cms/registry-client/discovery") | null = null;

async function loadDiscoveryModule(): Promise<
	typeof import("@emdash-cms/registry-client/discovery")
> {
	cachedDiscoveryModule ??= await import("@emdash-cms/registry-client/discovery");
	return cachedDiscoveryModule;
}

/**
 * Runs one discovery call against a fresh `DiscoveryClient` instance and
 * pairs its result with the response's `atproto-content-labelers` header.
 *
 * A fresh client is constructed per call (cheap -- it only binds a fetch
 * wrapper) rather than reused from a shared instance: `onResponseMeta` is
 * fixed at construction, so sharing one client across concurrent calls would
 * require correlating which invocation a given response belongs to. A
 * per-call client sidesteps that entirely -- the `contentLabelers` closure
 * variable can only ever be written by the one request this call made.
 */
async function callDiscovery<T>(
	config: RegistryClientConfig,
	fn: (
		client: InstanceType<
			(typeof import("@emdash-cms/registry-client/discovery"))["DiscoveryClient"]
		>,
	) => Promise<T>,
): Promise<WithContentLabelers<T>> {
	const { DiscoveryClient } = await loadDiscoveryModule();
	let contentLabelers: string | undefined;
	const discovery = new DiscoveryClient({
		aggregatorUrl: config.aggregatorUrl,
		acceptLabelers: config.acceptLabelers,
		onResponseMeta: (meta) => {
			contentLabelers = meta.contentLabelers;
		},
	});
	const data = await fn(discovery);
	return { ...data, contentLabelers };
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
// Profile sections
// ---------------------------------------------------------------------------

/**
 * The FAIR-recognised long-form section keys, in display order. Publishers may
 * also ship unrecognised keys (the lexicon's `sections` map is open), but the
 * admin renders only this known set so an aggregator can't inject a section
 * with an attacker-chosen heading; everything else is ignored.
 */
export const SECTION_ORDER = [
	"description",
	"installation",
	"faq",
	"changelog",
	"security",
] as const;

export type SectionKey = (typeof SECTION_ORDER)[number];

export interface PresentSection {
	key: SectionKey;
	markdown: string;
}

/**
 * Select the non-empty long-form sections off a package profile, in
 * `SECTION_ORDER`. `profile.sections` is a lexicon-validated map of Markdown
 * strings (or `null` when the aggregator returned a non-conforming record), so
 * each value is narrowed to a non-whitespace string before inclusion. Empty,
 * missing, whitespace-only, and non-string entries are dropped, so callers can
 * suppress the whole sections UI when the result is empty.
 */
export function presentSections(
	profile: { sections?: unknown } | null | undefined,
): PresentSection[] {
	const sections = profile?.sections;
	if (!sections || typeof sections !== "object") return [];
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to non-null object above; each value is string-checked below
	const map = sections as Record<string, unknown>;
	const out: PresentSection[] = [];
	for (const key of SECTION_ORDER) {
		const value = map[key];
		if (typeof value === "string" && value.trim().length > 0) {
			out.push({ key, markdown: value });
		}
	}
	return out;
}

// ---------------------------------------------------------------------------
// SBOM
// ---------------------------------------------------------------------------

export interface ReleaseSbom {
	format?: string;
	url?: string;
	checksum?: string;
}

/**
 * Narrow a release record's `sbom` field to the fields the admin renders.
 * Returns `null` unless the value is an object carrying at least one usable
 * field (`format` or `url`); every field is independently optional per the
 * lexicon. `sbom` is lexicon-validated at the DiscoveryClient boundary, but the
 * record is a publisher pass-through, so its inner shape still needs narrowing.
 */
export function extractSbom(value: unknown): ReleaseSbom | null {
	if (!value || typeof value !== "object") return null;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to non-null object above; fields checked below
	const v = value as Record<string, unknown>;
	const sbom: ReleaseSbom = {};
	if (typeof v.format === "string" && v.format.length > 0) sbom.format = v.format;
	if (typeof v.url === "string" && v.url.length > 0) sbom.url = v.url;
	if (typeof v.checksum === "string") sbom.checksum = v.checksum;
	if (!sbom.format && !sbom.url) return null;
	return sbom;
}

/**
 * Validate an SBOM document URL for use in a download `href`. Returns the
 * normalised URL only when it is an absolute `http(s)` URL; everything else
 * (relative, `javascript:`, `data:`, non-string) returns `null`. The release
 * record is a remote pass-through, so an unsanitised SBOM `href` would be
 * stored XSS in the authenticated admin origin. The browser fetches the SBOM
 * client-side on click — no server proxy, so SSRF isn't a concern here.
 */
export function sbomDownloadHref(value: unknown): string | null {
	if (typeof value !== "string" || value.length === 0) return null;
	let parsed: URL;
	try {
		parsed = new URL(value);
	} catch {
		return null;
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;
	return parsed.href;
}

// ---------------------------------------------------------------------------
// Public discovery hooks (callable by React Query)
// ---------------------------------------------------------------------------

export async function searchRegistryPackages(
	config: RegistryClientConfig,
	opts: RegistrySearchOpts,
): Promise<WithContentLabelers<RegistrySearchResult>> {
	return callDiscovery(config, (discovery) =>
		discovery.searchPackages({ q: opts.q, cursor: opts.cursor, limit: opts.limit }),
	);
}

export async function resolveRegistryPackage(
	config: RegistryClientConfig,
	handle: string,
	slug: string,
): Promise<WithContentLabelers<RegistryPackageView>> {
	return callDiscovery(config, (discovery) =>
		discovery.resolvePackage({
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did/handle shape validated by aggregator
			handle: handle as Handle,
			slug,
		}),
	);
}

export async function getRegistryPackage(
	config: RegistryClientConfig,
	did: string,
	slug: string,
): Promise<WithContentLabelers<RegistryPackageView>> {
	return callDiscovery(config, (discovery) =>
		discovery.getPackage({
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did shape validated by aggregator
			did: did as Did,
			slug,
		}),
	);
}

export async function getLatestRegistryRelease(
	config: RegistryClientConfig,
	did: string,
	slug: string,
): Promise<WithContentLabelers<RegistryReleaseView>> {
	return callDiscovery(config, (discovery) =>
		discovery.getLatestRelease({
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did shape validated by aggregator
			did: did as Did,
			package: slug,
		}),
	);
}

export async function listRegistryReleases(
	config: RegistryClientConfig,
	did: string,
	slug: string,
	opts?: { cursor?: string; limit?: number },
): Promise<WithContentLabelers<ValidatedListReleases>> {
	return callDiscovery(config, (discovery) =>
		discovery.listReleases({
			// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- did shape validated by aggregator
			did: did as Did,
			package: slug,
			cursor: opts?.cursor,
			limit: opts?.limit,
		}),
	);
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
// Artifact proxy (server GET)
// ---------------------------------------------------------------------------

const ARTIFACT_PROXY_ENDPOINT = `${API_BASE}/admin/plugins/registry/artifact`;

/** Artifact kinds the server proxy can resolve from a release record. */
export type ArtifactKind = "icon" | "banner" | "screenshot";

/**
 * Coordinates identifying one image artifact on a release record. The browser
 * sends these to the server proxy, which resolves the publisher-declared URL
 * server-side from the validated release record — the raw publisher URL never
 * leaves the server, so the client cannot coerce the proxy into fetching an
 * undeclared URL.
 */
export interface ArtifactCoords {
	did: string;
	slug: string;
	version?: string;
	kind: ArtifactKind;
	/** Required for `kind: "screenshot"`; ignored otherwise. */
	index?: number;
}

/**
 * Build the URL of the server-side artifact proxy for an artifact addressed by
 * its `(did, slug, version, kind, index)` coordinates. The browser never sends
 * the publisher's URL — the proxy resolves the *declared* URL from the release
 * record, applies SSRF defences, enforces an image content-type allowlist, and
 * serves the bytes back same-origin.
 *
 * Empty `version` (latest) and `index` (non-screenshot kinds) are omitted.
 */
export function artifactProxyUrl(coords: ArtifactCoords): string {
	const params = new URLSearchParams();
	params.set("did", coords.did);
	params.set("slug", coords.slug);
	params.set("kind", coords.kind);
	if (coords.version) params.set("version", coords.version);
	if (coords.kind === "screenshot" && coords.index !== undefined) {
		params.set("index", String(coords.index));
	}
	return `${ARTIFACT_PROXY_ENDPOINT}?${params.toString()}`;
}

/**
 * A single image artifact lifted off a release record. Carries presentation
 * dimensions only — the URL is resolved server-side, so the client never holds
 * the publisher-supplied URL.
 */
export interface MediaArtifact {
	width?: number;
	height?: number;
}

/**
 * A screenshot artifact, carrying the index into the release's raw
 * `screenshots` array. The proxy resolves by that index, so dropped (malformed)
 * entries must not shift the indices of the surviving ones.
 */
export interface ScreenshotArtifact extends MediaArtifact {
	index: number;
}

export interface MediaArtifacts {
	icon?: MediaArtifact;
	banner?: MediaArtifact;
	screenshots: ScreenshotArtifact[];
}

/**
 * Narrow one entry of a release's `artifacts` map to the fields we render.
 * Returns `null` when the value isn't an object carrying a usable `url`
 * (presence gate), keeping only the dimensions for layout.
 *
 * Records are lexicon-validated at the DiscoveryClient boundary, but
 * `artifacts` is an aggregator pass-through, so each entry still needs
 * shape-narrowing.
 */
function asMediaArtifact(value: unknown): MediaArtifact | null {
	if (!value || typeof value !== "object") return null;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to non-null object above; field shapes checked below
	const v = value as Record<string, unknown>;
	if (typeof v.url !== "string" || v.url.length === 0) return null;
	const artifact: MediaArtifact = {};
	if (typeof v.width === "number") artifact.width = v.width;
	if (typeof v.height === "number") artifact.height = v.height;
	return artifact;
}

/**
 * Pull icon, banner, and the screenshot gallery out of a release's `artifacts`
 * map, keeping presence and dimensions only. The lexicon types `screenshots`
 * as an array of artifacts; entries without a usable `url` are dropped, and
 * gallery order is preserved so screenshot indices line up with the proxy's.
 */
export function extractMediaArtifacts(artifacts: unknown): MediaArtifacts {
	const result: MediaArtifacts = { screenshots: [] };
	if (!artifacts || typeof artifacts !== "object") return result;
	// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- narrowed to non-null object above; each entry is shape-narrowed by asMediaArtifact
	const map = artifacts as Record<string, unknown>;

	const icon = asMediaArtifact(map.icon);
	if (icon) result.icon = icon;
	const banner = asMediaArtifact(map.banner);
	if (banner) result.banner = banner;

	if (Array.isArray(map.screenshots)) {
		map.screenshots.forEach((entry, index) => {
			const artifact = asMediaArtifact(entry);
			if (artifact) result.screenshots.push({ ...artifact, index });
		});
	}
	return result;
}

// ---------------------------------------------------------------------------
// Install (server POST)
// ---------------------------------------------------------------------------

const INSTALL_ENDPOINT = `${API_BASE}/admin/plugins/registry/install`;

/**
 * Server-side moderation block raised by the install or update endpoint when
 * the target release is blocked (`RELEASE_BLOCKED`) or has been withdrawn
 * (`RELEASE_YANKED`). Carries the reason codes and blocking label values so
 * the caller can render a localized headline and label list instead of the
 * raw server message.
 */
export class RegistryModerationBlockError extends Error {
	readonly code: "RELEASE_BLOCKED" | "RELEASE_YANKED";
	readonly reasonCodes: string[];
	readonly blockingLabels: string[];
	constructor(
		code: "RELEASE_BLOCKED" | "RELEASE_YANKED",
		message: string,
		details: { reasonCodes: string[]; blockingLabels: string[] },
	) {
		super(message);
		this.name = "RegistryModerationBlockError";
		this.code = code;
		this.reasonCodes = details.reasonCodes;
		this.blockingLabels = details.blockingLabels;
	}
}

function parseModerationBlock(body: unknown): RegistryModerationBlockError | null {
	if (!body || typeof body !== "object" || !("error" in body)) return null;
	const error = body.error;
	if (!error || typeof error !== "object" || !("code" in error)) return null;
	const code = error.code;
	if (code !== "RELEASE_BLOCKED" && code !== "RELEASE_YANKED") return null;
	const details =
		"details" in error && error.details && typeof error.details === "object" ? error.details : {};
	const reasonCodes = normaliseStringArray(
		"reasonCodes" in details ? details.reasonCodes : undefined,
	);
	const blockingLabels = normaliseStringArray(
		"blockingLabels" in details ? details.blockingLabels : undefined,
	);
	const message =
		"message" in error && typeof error.message === "string"
			? error.message
			: i18n._(msg`This release is blocked`);
	return new RegistryModerationBlockError(code, message, { reasonCodes, blockingLabels });
}

function normaliseStringArray(value: unknown): string[] {
	return Array.isArray(value) ? value.filter((s): s is string => typeof s === "string") : [];
}

/**
 * Resolves a mutation error into a localized, multi-line moderation message
 * when it's a `RegistryModerationBlockError`; `null` otherwise, so callers
 * fall back to their generic error text (`getMutationError`) for every other
 * error shape, unknown codes included.
 */
export function describeRegistryModerationError(error: unknown): string | null {
	if (!(error instanceof RegistryModerationBlockError)) return null;
	const headline =
		error.code === "RELEASE_YANKED"
			? i18n._(msg`This release was withdrawn and can't be installed.`)
			: i18n._(msg`This release is blocked and can't be installed.`);
	const labelNames = error.blockingLabels.map((value) => describeModerationLabel(value).name);
	return labelNames.length > 0 ? `${headline}\n${labelNames.join(", ")}` : headline;
}

/**
 * Install a plugin from the registry.
 *
 * Posts to the EmDash server, which re-resolves the same `(handle,
 * slug)` against the aggregator, re-verifies the bundle's checksum
 * against the signed release record, and writes the install. Surfaces
 * structured error codes (`RELEASE_YANKED`, `RELEASE_BLOCKED`,
 * `CHECKSUM_MISMATCH`, `DECLARED_ACCESS_DRIFT`, etc.); `RELEASE_BLOCKED` /
 * `RELEASE_YANKED` responses parse into `RegistryModerationBlockError` so
 * callers can render the localized headline via
 * `describeRegistryModerationError`. Unknown codes keep the raw server
 * message via the generic fallback.
 */
export async function installRegistryPlugin(
	body: RegistryInstallRequest,
): Promise<RegistryInstallResult> {
	const response = await apiFetch(INSTALL_ENDPOINT, {
		method: "POST",
		headers: { "Content-Type": "application/json" },
		body: JSON.stringify(body),
	});
	if (response.ok) return parseApiResponse<RegistryInstallResult>(response);

	const body_: unknown = await response
		.clone()
		.json()
		.catch(() => undefined);
	const moderationBlock = parseModerationBlock(body_);
	if (moderationBlock) throw moderationBlock;
	return throwResponseError(response, i18n._(msg`Failed to install plugin`));
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
	const moderationBlock = parseModerationBlock(body);
	if (moderationBlock) throw moderationBlock;
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
