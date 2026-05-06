/**
 * Programmatic publish API.
 *
 * Pure-ish core of the publish pipeline: given an already-fetched tarball
 * checksum, an extracted manifest, an authenticated `PublishingClient`, and
 * the URL the bytes are hosted at, this writes the profile (if missing) and
 * release records to the publisher's atproto repo.
 *
 * Splits cleanly from the CLI command so tests can run it against a mock
 * `PublishingClient` without going through OAuth, the filesystem credentials
 * store, or an HTTP fetch for the tarball.
 *
 * Atomicity
 * ---------
 *
 * Profile bootstrap + release create happen in a single atproto
 * `applyWrites` commit, so a network blip mid-publish can't leave a profile
 * with no releases (or vice versa). FAIR specifies version-record
 * immutability; we refuse to overwrite an existing release at
 * `<slug>:<version>` unless `allowOverwrite: true` is set.
 *
 * Validation
 * ----------
 *
 * Slug (derived from `manifest.id`) and version are validated against the
 * registry-lexicon constraints before any network round-trip, so the user
 * gets a clear `PublishError` with the offending value rather than a generic
 * `InvalidRequest` from the PDS. Profile-bootstrap fields (license, security
 * contact) are also validated up-front for the same reason.
 *
 * Failure modes:
 *
 *   - `DEPRECATED_CAPABILITY`: the manifest declares one of the deprecated
 *     capability names. Bundle warns; publish refuses.
 *   - `INVALID_SLUG` / `INVALID_VERSION`: the derived slug or the manifest
 *     version doesn't match the lexicon constraints.
 *   - `PROFILE_BOOTSTRAP_MISSING_FIELD`: first publish without the required
 *     `license` and `securityEmail`/`securityUrl`.
 *   - `RELEASE_ALREADY_PUBLISHED`: the release record at `<slug>:<version>`
 *     already exists in the repo. Pass `allowOverwrite: true` to opt in to
 *     overwriting (aggregators may flag the change as a takedown).
 */

import { ClientResponseError } from "@atcute/client";
import type { Nsid } from "@atcute/lexicons";
import { safeParse } from "@atcute/lexicons/validations";
import {
	deriveSlugFromId,
	isDeprecatedCapability,
	isPluginSlug,
	isPluginVersion,
	normalizeCapability,
	type PluginManifest,
} from "@emdash-cms/plugin-types";
import type { Did, PublishingClient } from "@emdash-cms/registry-client";
import {
	NSID,
	PackageProfile,
	PackageRelease,
	PackageReleaseExtension,
} from "@emdash-cms/registry-lexicons";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type PublishErrorCode =
	| "DEPRECATED_CAPABILITY"
	| "INVALID_SLUG"
	| "INVALID_VERSION"
	| "INVALID_MANIFEST"
	| "LEXICON_VALIDATION_FAILED"
	| "PROFILE_BOOTSTRAP_MISSING_FIELD"
	| "RELEASE_ALREADY_PUBLISHED";

export class PublishError extends Error {
	readonly code: PublishErrorCode;
	/** Optional structured detail for callers that want to render specifics. */
	readonly detail: Record<string, unknown> | undefined;

	constructor(code: PublishErrorCode, message: string, detail?: Record<string, unknown>) {
		super(message);
		this.name = "PublishError";
		this.code = code;
		this.detail = detail;
	}
}

export interface PublishLogger {
	info?(message: string): void;
	success?(message: string): void;
	warn?(message: string): void;
}

/**
 * Identity fields supplied at publish time. Used only on first publish, when
 * we bootstrap the `package.profile` record. On subsequent publishes the
 * existing profile wins; any of these passed are ignored, with a warning
 * collected under `result.ignoredProfileFields`.
 */
export interface ProfileBootstrap {
	/** SPDX license expression. Required on first publish. */
	license?: string;
	authorName?: string;
	authorUrl?: string;
	authorEmail?: string;
	securityEmail?: string;
	securityUrl?: string;
}

export interface PublishOptions {
	/** Authenticated client against the publisher's PDS. */
	publisher: PublishingClient;
	/** Publisher DID. Used to construct AT URIs for display/output. */
	did: Did;
	/** The plugin manifest extracted from the tarball. */
	manifest: PluginManifest;
	/** Multibase-multihash sha2-256 of the tarball bytes. */
	checksum: string;
	/** Public URL where the tarball is hosted. */
	url: string;
	/** Identity fields used when bootstrapping a new profile. */
	profile?: ProfileBootstrap;
	/**
	 * Allow overwriting an existing release at `<slug>:<version>`. Default
	 * is `false`, which causes publish to refuse with `RELEASE_ALREADY_PUBLISHED`.
	 */
	allowOverwrite?: boolean;
	/** Optional progress reporter. */
	logger?: PublishLogger;
}

export interface PublishResult {
	/** AT URI of the package profile record (created or existing). */
	profileUri: string;
	/** AT URI of the release record. */
	releaseUri: string;
	/** CID of the release record commit. */
	releaseCid: string;
	/** Multibase-multihash echoed back for convenience. */
	checksum: string;
	/** True if this publish created the profile; false if it reused an existing one. */
	profileCreated: boolean;
	/** True if this publish overwrote an existing release record at the same rkey. */
	releaseOverwritten: boolean;
	/** Computed slug (from manifest id). */
	slug: string;
	/**
	 * Names of profile fields the caller passed that were ignored because the
	 * profile already existed. Empty on first publish.
	 */
	ignoredProfileFields: string[];
}

// ──────────────────────────────────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Lexicon types use atcute's branded template-literal types (`ResourceUri`,
 * `${string}:${string}`, etc.) for fields with format constraints. Those
 * make on-the-wire records hard to construct from raw runtime strings
 * without a `safeParse` round-trip.
 *
 * We build records here against looser local shapes that mirror the lexicon
 * JSON exactly; the PDS validates server-side via `validate: true` (set in
 * the publishing client). The static assertions on `RegistryRecords` would
 * be one obvious thing to add here, but the lexicon-derived `Main` types
 * are *strict subtypes* of these shapes (because of the branded URLs) --
 * not supertypes -- so they aren't useful as guard rails. The validation we
 * rely on is:
 *
 *   - publish-time: `isPluginSlug` + `isPluginVersion` against the lexicon
 *     constraints, before any record construction.
 *   - put-time: PDS lexicon validation via `validate: true`.
 *
 * For untrusted inputs (records read back from a PDS) callers should run
 * the lexicon's `mainSchema.safeParse` themselves.
 */
interface PackageProfileRecordShape {
	$type: typeof NSID.packageProfile;
	id: string;
	type: "emdash-plugin" | (string & {});
	license: string;
	authors: Array<{ name: string; url?: string; email?: string }>;
	security: Array<{ url?: string; email?: string }>;
	slug: string;
	lastUpdated: string;
}

interface PackageReleaseRecordShape {
	$type: typeof NSID.packageRelease;
	package: string;
	version: string;
	artifacts: {
		package: {
			url: string;
			checksum: string;
			contentType?: string;
		};
	};
	/**
	 * Open-union extension container, keyed by NSID. Releases of type
	 * `emdash-plugin` MUST include a `releaseExtension` entry carrying the
	 * sandbox trust contract (declared access). Without it, sandbox runtimes
	 * have no contract to enforce against.
	 */
	extensions: Record<string, unknown>;
}

interface DeclaredAccess {
	content?: { read?: Record<string, unknown>; write?: Record<string, unknown> };
	media?: { read?: Record<string, unknown>; write?: Record<string, unknown> };
	network?: { request?: { allowedHosts?: string[] } };
	email?: { send?: Record<string, unknown> };
}

interface FetchedRecord {
	uri: string;
	cid: string;
	value: unknown;
}

export async function publishRelease(options: PublishOptions): Promise<PublishResult> {
	const log = options.logger ?? {};

	// 1. Synchronous, network-free validation runs first so we fail fast.
	const deprecated = options.manifest.capabilities.filter(isDeprecatedCapability);
	if (deprecated.length > 0) {
		throw new PublishError(
			"DEPRECATED_CAPABILITY",
			`Plugin uses deprecated capability names: ${deprecated.join(", ")}. Rename them before publishing.`,
			{ deprecated },
		);
	}

	const slug = deriveSlugFromId(options.manifest.id);
	if (!isPluginSlug(slug)) {
		throw new PublishError(
			"INVALID_SLUG",
			`Plugin id "${options.manifest.id}" produces slug "${slug}" which doesn't match the lexicon constraint /^[a-z][a-z0-9_-]*$/ (max 64 chars). Rename the plugin id.`,
			{ id: options.manifest.id, slug },
		);
	}

	if (!isPluginVersion(options.manifest.version)) {
		throw new PublishError(
			"INVALID_VERSION",
			`Plugin version "${options.manifest.version}" is not a valid semver (max 64 chars; semver build-metadata "+..." disallowed because the atproto rkey alphabet has no "+").`,
			{ version: options.manifest.version },
		);
	}

	// Refuse `network:request` with no allowedHosts. The lexicon defines
	// `request: {}` (no allowedHosts) as "unrestricted requests" -- but the
	// `network:request` capability name was meant to be host-restricted.
	// Rather than silently publish a record that says "unrestricted" while
	// the bundler told the developer "all requests will be blocked",
	// require the publisher to be explicit: declare hosts, or upgrade to
	// `network:request:unrestricted`.
	const normalizedCaps = options.manifest.capabilities.map((c) => normalizeCapability(c));
	if (
		normalizedCaps.includes("network:request") &&
		!normalizedCaps.includes("network:request:unrestricted") &&
		options.manifest.allowedHosts.length === 0
	) {
		throw new PublishError(
			"INVALID_MANIFEST",
			"Plugin declares `network:request` capability but no `allowedHosts`. Either list specific host patterns in `allowedHosts`, or upgrade to `network:request:unrestricted` if the plugin really needs to call any host.",
			{ capabilities: normalizedCaps, allowedHosts: options.manifest.allowedHosts },
		);
	}

	// Validate profile-bootstrap fields up-front. We don't yet know whether the
	// profile already exists (one round-trip away), but if the user supplied
	// no fields at all and they're needed, we can fail before the network.
	// (We can't fail early when fields are missing-but-required-only-on-first-
	// publish, since that needs the existence check.)

	const profileUri = atUri(options.did, NSID.packageProfile, slug);
	const releaseRkey = `${slug}:${options.manifest.version}`;

	// 2. Read existing profile + release in parallel. Either may be absent.
	const [existingProfile, existingRelease] = await Promise.all([
		getRecordOrNull(options.publisher, NSID.packageProfile, slug),
		getRecordOrNull(options.publisher, NSID.packageRelease, releaseRkey),
	]);

	// 3. Refuse to overwrite an existing release unless asked.
	if (existingRelease !== null && !options.allowOverwrite) {
		throw new PublishError(
			"RELEASE_ALREADY_PUBLISHED",
			`Release ${slug}@${options.manifest.version} is already published. ` +
				"FAIR specifies that version records are immutable; aggregators and " +
				"labellers may treat any change as a takedown event. " +
				"Pass allowOverwrite: true to overwrite anyway.",
			{ slug, version: options.manifest.version },
		);
	}
	const releaseOverwritten = existingRelease !== null;
	if (releaseOverwritten) {
		log.warn?.(
			`Overwriting existing release ${slug}@${options.manifest.version}. ` +
				"Consumers who already installed this version will keep the old bytes; " +
				"aggregators may flag the change.",
		);
	}

	// 4. Build the operations list. We always write the release; the profile
	// is created on first publish or `lastUpdated`-bumped on subsequent.
	const profileCreated = existingProfile === null;
	const ignoredProfileFields: string[] = [];

	// Build the EmDash trust extension (declaredAccess) from the manifest's
	// capabilities + allowedHosts. The lexicon REQUIRES this extension on
	// every emdash-plugin release; without it, sandbox runtimes have no
	// contract to enforce, and aggregators may reject the record.
	const declaredAccess = buildDeclaredAccess(options.manifest);

	// Warn about capabilities that don't appear in the published
	// declaredAccess. The lexicon's vocabulary is closed today (see
	// releaseExtension.json line 20: "Categories not enumerated here cannot
	// be declared"), so any capability not handled by `buildDeclaredAccess`
	// is invisible to the trust contract. Driving the gap detection from
	// what was actually emitted (rather than a hard-coded prefix list)
	// means a future capability added to plugin-types but not to
	// `buildDeclaredAccess` still fires the warning.
	const unmappedCaps = findUnmappedCapabilities(normalizedCaps, declaredAccess);
	if (unmappedCaps.length > 0) {
		log.warn?.(
			`Capabilities ${unmappedCaps.join(", ")} are not expressible in declaredAccess today (lexicon limitation). Sandbox runtimes will gate these on manifest.capabilities until the lexicon evolves to cover them.`,
		);
	}
	const releaseExtension = {
		$type: NSID.packageReleaseExtension,
		declaredAccess,
	};

	const releaseRecord: PackageReleaseRecordShape = {
		$type: NSID.packageRelease,
		package: slug,
		version: options.manifest.version,
		artifacts: {
			package: {
				url: options.url,
				checksum: options.checksum,
				contentType: "application/gzip",
			},
		},
		extensions: {
			[NSID.packageReleaseExtension]: releaseExtension,
		},
	};

	type WriteOp =
		| {
				op: "create";
				collection: typeof NSID.packageProfile;
				rkey: string;
				record: PackageProfileRecordShape;
		  }
		| {
				op: "update";
				collection: typeof NSID.packageProfile;
				rkey: string;
				record: PackageProfileRecordShape;
		  }
		| {
				op: "create";
				collection: typeof NSID.packageRelease;
				rkey: string;
				record: PackageReleaseRecordShape;
		  }
		| {
				op: "update";
				collection: typeof NSID.packageRelease;
				rkey: string;
				record: PackageReleaseRecordShape;
		  };

	const writes: WriteOp[] = [];

	if (profileCreated) {
		const profileRecord = buildProfileRecord({
			slug,
			profileUri,
			profile: options.profile,
		});
		writes.push({
			op: "create",
			collection: NSID.packageProfile,
			rkey: slug,
			record: profileRecord,
		});
		log.info?.(`Bootstrapping profile: ${profileUri}`);
	} else {
		ignoredProfileFields.push(...listProvidedProfileFields(options.profile));
		// Bump `lastUpdated` on the existing profile so aggregators ordering
		// by it see this publish. The user's first-publish-only flags are
		// still ignored (the existing profile owns identity/license/security),
		// but the timestamp follows the latest release. We round-trip the
		// existing record to preserve every other field byte-for-byte.
		const stamped = stampLastUpdated(existingProfile.value);
		if (stamped !== null) {
			writes.push({
				op: "update",
				collection: NSID.packageProfile,
				rkey: slug,
				record: stamped,
			});
			log.info?.(`Reusing profile (bumping lastUpdated): ${profileUri}`);
		} else {
			// Existing profile didn't validate enough to construct a typed
			// shape; leave it alone and emit a warning.
			log.warn?.(
				`Existing profile at ${profileUri} doesn't match the lexicon shape; lastUpdated not bumped.`,
			);
		}
	}

	writes.push({
		op: releaseOverwritten ? "update" : "create",
		collection: NSID.packageRelease,
		rkey: releaseRkey,
		record: releaseRecord,
	});

	// 5. Validate every record locally against its lexicon BEFORE round-
	// tripping. We can't rely on the PDS to validate because the experimental
	// registry NSIDs aren't shipped with most PDSes -- a real Bluesky PDS
	// rejects a `validate: true` write of an unknown lexicon. So we own the
	// validation and pass `skipValidation: true` to applyWrites.
	for (const op of writes) {
		validateLocally(op.collection, op.record);
	}

	// Also validate the embedded extension record. Lexicon-level $type
	// dispatch happens at the host parsing the release record's extensions
	// map; we want to fail-fast here so a malformed extension doesn't silently
	// reach the registry.
	validateLocally(NSID.packageReleaseExtension, releaseExtension as unknown);

	// 6. Apply atomically. `skipValidation: true` because we've already
	// validated locally and the PDS doesn't know our experimental lexicons.
	//
	// We do NOT pass `swapCommit` here. `swapCommit` provides optimistic-CAS
	// semantics by failing the write if the repo's current head CID differs
	// from a CID we observed earlier. The use case it protects against --
	// "another publisher concurrently updated the same record" -- doesn't
	// exist for our flow: each repo has exactly one publisher (the human
	// running the CLI under their own DID), and the read-then-write race is
	// against themselves. The cost of adding swapCommit (an extra
	// `getRepo`/`describeRepo` round-trip per publish to learn the head CID)
	// isn't worth it for a single-user repo. If we ever support multi-agent
	// publishing to a shared registry repo, revisit.
	const batch = await options.publisher.applyWrites({
		skipValidation: true,
		writes: writes as unknown as Parameters<typeof options.publisher.applyWrites>[0]["writes"],
	});

	// The release result is always the last in the input order.
	const releaseOpResult = batch.results.at(-1);
	if (!releaseOpResult || (releaseOpResult.op !== "create" && releaseOpResult.op !== "update")) {
		// Defensive: applyWrites should always echo a create/update result for a
		// create/update operation. If we get back a delete or nothing, something
		// is very wrong.
		throw new Error(
			"applyWrites returned no result for the release operation (expected create/update).",
		);
	}

	if (profileCreated) {
		log.success?.(`Created profile: ${profileUri}`);
	}

	return {
		profileUri,
		releaseUri: releaseOpResult.uri,
		releaseCid: releaseOpResult.cid,
		checksum: options.checksum,
		profileCreated,
		releaseOverwritten,
		slug,
		ignoredProfileFields,
	};
}

// ──────────────────────────────────────────────────────────────────────────
// Helpers
// ──────────────────────────────────────────────────────────────────────────

function atUri(did: Did, collection: string, rkey: string): string {
	return `at://${did}/${collection}/${rkey}`;
}

/**
 * Determine which capabilities in `normalizedCaps` have no representation
 * in the `declaredAccess` we just built. The mapping rules are derived
 * from what `buildDeclaredAccess` actually emits, so a future capability
 * added to plugin-types but not to that function will surface here.
 *
 * The check is: for each capability, derive its target declaredAccess
 * coordinate (category + operation). If that coordinate is missing,
 * the capability is unmapped.
 */
function findUnmappedCapabilities(
	normalizedCaps: string[],
	declaredAccess: DeclaredAccess,
): string[] {
	const unmapped: string[] = [];
	for (const cap of normalizedCaps) {
		if (capabilityIsRepresented(cap, declaredAccess)) continue;
		unmapped.push(cap);
	}
	return unmapped;
}

function capabilityIsRepresented(cap: string, declared: DeclaredAccess): boolean {
	switch (cap) {
		case "content:read":
			return declared.content?.read !== undefined;
		case "content:write":
			return declared.content?.write !== undefined;
		case "media:read":
			return declared.media?.read !== undefined;
		case "media:write":
			return declared.media?.write !== undefined;
		case "network:request":
		case "network:request:unrestricted":
			return declared.network?.request !== undefined;
		case "email:send":
			return declared.email?.send !== undefined;
		default:
			// Anything else (users:*, hooks.*:register, future capabilities)
			// is unmapped. The lexicon doesn't have a category for it yet.
			return false;
	}
}

/**
 * Translate `manifest.capabilities` + `manifest.allowedHosts` into the
 * `declaredAccess` shape required by the EmDash release extension.
 *
 * Only the canonical capability names are inspected here; the manifest's
 * `capabilities` is normalized at publish-time entry, and deprecated names
 * are hard-failed before we get here.
 */
function buildDeclaredAccess(manifest: PluginManifest): DeclaredAccess {
	// Normalize so legacy aliases don't slip through (defence in depth -- the
	// manifest should have been normalized at definePlugin time).
	const caps = new Set(manifest.capabilities.map((c) => normalizeCapability(c)));
	const declared: DeclaredAccess = {};

	// The lexicon documents that `content.write` IMPLIES `content.read`
	// (releaseExtension.json line 53-56) and same for `media.write`.
	// Canonicalise here so the published trust contract matches the
	// documented semantics: any capability that implies read also surfaces
	// `read: {}` in declaredAccess. Aggregators and sandbox runtimes can
	// then gate on `declaredAccess.content.read` without also having to
	// know the implication rules.
	if (caps.has("content:read") || caps.has("content:write")) {
		declared.content = { read: {} };
		if (caps.has("content:write")) declared.content.write = {};
	}
	if (caps.has("media:read") || caps.has("media:write")) {
		declared.media = { read: {} };
		if (caps.has("media:write")) declared.media.write = {};
	}
	if (caps.has("network:request") || caps.has("network:request:unrestricted")) {
		declared.network = {};
		// The lexicon's `networkRequestConstraints.allowedHosts` is "absent =
		// no host restriction; empty array MUST NOT appear". So we only set
		// the key when the manifest declares hosts and the unrestricted
		// capability is NOT present.
		const constraint: { allowedHosts?: string[] } = {};
		if (!caps.has("network:request:unrestricted") && manifest.allowedHosts.length > 0) {
			constraint.allowedHosts = [...manifest.allowedHosts];
		}
		declared.network.request = constraint;
	}
	if (caps.has("email:send")) {
		declared.email = { send: {} };
	}

	return declared;
}

/**
 * Validate `value` against the lexicon for `collection`. Throws
 * `PublishError("LEXICON_VALIDATION_FAILED")` on failure. Skips validation
 * for collections we don't own a schema for (caller's responsibility).
 *
 * We validate locally rather than trusting the PDS because experimental
 * registry NSIDs aren't shipped with most PDSes -- a real Bluesky PDS would
 * reject a write of `com.emdashcms.experimental.*` records when
 * `validate: true`.
 *
 * CAVEAT: atcute's `v.object` accepts unknown keys silently (it copies the
 * declared shape and ignores extras). The lexicon prose for declaredAccess
 * mandates "clients MUST reject release records that include unrecognised
 * top-level fields", but this validator does not enforce that rule -- we
 * rely on the fact that we construct the records ourselves and never
 * inject unknown keys. Aggregators MUST do their own strict validation;
 * don't treat `validateLocally` returning ok as proof the record is
 * spec-compliant.
 */
function validateLocally(collection: string, value: unknown): void {
	const schemas: Record<string, { mainSchema: Parameters<typeof safeParse>[0] } | undefined> = {
		[NSID.packageProfile]: PackageProfile,
		[NSID.packageRelease]: PackageRelease,
		[NSID.packageReleaseExtension]: PackageReleaseExtension,
	};
	const ns = schemas[collection];
	if (!ns) return;
	const result = safeParse(ns.mainSchema, value);
	if (result.ok) return;
	throw new PublishError(
		"LEXICON_VALIDATION_FAILED",
		`Record for ${collection} did not match the lexicon. Issues: ${formatValidationIssues(result)}`,
		{ collection, issues: result },
	);
}

function formatValidationIssues(err: unknown): string {
	// JSON-serialise whatever the validator handed us (typically a result
	// object with an `issues` array). Falls back to a JSON-stringification
	// of the whole value if the expected fields aren't there. We never call
	// `String(err)` on an unknown object because that produces the
	// useless `[object Object]`.
	try {
		if (err && typeof err === "object") {
			const obj = err as { issues?: unknown; message?: unknown };
			if (obj.issues !== undefined) return JSON.stringify(obj.issues);
			if (typeof obj.message === "string") return obj.message;
			return JSON.stringify(err);
		}
		if (typeof err === "string") return err;
		return JSON.stringify(err);
	} catch {
		// Circular structure or similar; fall back to the type-tag.
		return Object.prototype.toString.call(err);
	}
}

/**
 * Fetch a record, returning `null` if the PDS reports it as missing.
 *
 * Returns the full `{ uri, cid, value }` shape (rather than the value alone)
 * so callers that need the existing CID for `swapRecord` semantics can get
 * it. The publish flow distinguishes "no record" from "record with falsy
 * value" via the `null` sentinel; checking truthiness of the value would
 * misfire on a legitimate-but-falsy stored value.
 */
async function getRecordOrNull(
	publisher: PublishingClient,
	collection: Nsid,
	rkey: string,
): Promise<FetchedRecord | null> {
	try {
		const record = await publisher.getRecord({ collection, rkey });
		return { uri: record.uri, cid: record.cid, value: record.value };
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "RecordNotFound") {
			return null;
		}
		throw error;
	}
}

/**
 * Return a copy of the existing profile record value with `lastUpdated`
 * bumped to now. Returns `null` if the existing record doesn't have the
 * fields we need to round-trip safely (in which case the caller skips the
 * update rather than overwriting an invalid record with a slightly-different
 * invalid record).
 *
 * Unknown / extra fields on the existing record are intentionally preserved
 * verbatim via the spread. If they violate the lexicon, the local
 * `validateLocally` pass before `applyWrites` will reject the candidate
 * with a `LEXICON_VALIDATION_FAILED` error rather than letting an invalid
 * record propagate to the registry.
 */
function stampLastUpdated(existingValue: unknown): PackageProfileRecordShape | null {
	if (!existingValue || typeof existingValue !== "object") return null;
	const v = existingValue as Record<string, unknown>;
	if (typeof v.id !== "string") return null;
	if (typeof v.type !== "string") return null;
	if (typeof v.license !== "string") return null;
	if (!Array.isArray(v.authors)) return null;
	if (!Array.isArray(v.security)) return null;
	if (typeof v.slug !== "string") return null;
	// Re-emit only schema-known fields. A spread over `v` would carry
	// across unknown keys (e.g. fields from a since-removed earlier
	// experimental shape), which `validateLocally` accepts silently
	// (atcute's v.object ignores extras, see its caveat doc) but
	// strict-validating aggregators reject. Whitelisting here is the
	// canonicalising step.
	const candidate: Record<string, unknown> = {
		$type: NSID.packageProfile,
		id: v.id,
		type: v.type,
		license: v.license,
		authors: v.authors,
		security: v.security,
		slug: v.slug,
		lastUpdated: new Date().toISOString(),
	};
	// Optional fields only if present and well-typed -- otherwise drop.
	if (typeof v.name === "string") candidate.name = v.name;
	if (typeof v.description === "string") candidate.description = v.description;
	if (Array.isArray(v.keywords)) candidate.keywords = v.keywords;
	if (v.sections && typeof v.sections === "object") candidate.sections = v.sections;
	return candidate as unknown as PackageProfileRecordShape;
}

function buildProfileRecord(input: {
	slug: string;
	profileUri: string;
	profile: ProfileBootstrap | undefined;
}): PackageProfileRecordShape {
	const profile = input.profile ?? {};
	if (!profile.license) {
		throw new PublishError(
			"PROFILE_BOOTSTRAP_MISSING_FIELD",
			"license is required on first publish (e.g. MIT). The lexicon requires a SPDX license expression for every package.",
			{ field: "license" },
		);
	}
	if (!profile.securityEmail && !profile.securityUrl) {
		throw new PublishError(
			"PROFILE_BOOTSTRAP_MISSING_FIELD",
			"securityEmail or securityUrl is required on first publish. Clients refuse to install packages without a security contact.",
			{ field: "security" },
		);
	}

	const author: { name: string; url?: string; email?: string } = {
		name: profile.authorName ?? "unknown",
	};
	if (profile.authorUrl) author.url = profile.authorUrl;
	if (profile.authorEmail) author.email = profile.authorEmail;

	const securityContact: { url?: string; email?: string } = {};
	if (profile.securityEmail) securityContact.email = profile.securityEmail;
	if (profile.securityUrl) securityContact.url = profile.securityUrl;

	return {
		$type: NSID.packageProfile,
		id: input.profileUri,
		type: "emdash-plugin",
		license: profile.license,
		authors: [author],
		security: [securityContact],
		slug: input.slug,
		lastUpdated: new Date().toISOString(),
	};
}

/**
 * Returns the names of any profile-bootstrap fields the caller supplied. Used
 * to report fields that were ignored because the profile already existed.
 *
 * Iterates the keys of `ProfileBootstrap` explicitly so that future numeric /
 * boolean / non-string fields don't silently disappear from the warning.
 */
function listProvidedProfileFields(profile: ProfileBootstrap | undefined): string[] {
	if (!profile) return [];
	const fields: Array<keyof ProfileBootstrap> = [
		"license",
		"authorName",
		"authorUrl",
		"authorEmail",
		"securityEmail",
		"securityUrl",
	];
	return fields.filter((name) => profile[name] !== undefined);
}
