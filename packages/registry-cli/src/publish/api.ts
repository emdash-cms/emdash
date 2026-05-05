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
import {
	deriveSlugFromId,
	isDeprecatedCapability,
	isPluginSlug,
	isPluginVersion,
	type PluginManifest,
} from "@emdash-cms/plugin-types";
import type { Did, PublishingClient } from "@emdash-cms/registry-client";
import { NSID } from "@emdash-cms/registry-lexicons";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type PublishErrorCode =
	| "DEPRECATED_CAPABILITY"
	| "INVALID_SLUG"
	| "INVALID_VERSION"
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
			`Plugin version "${options.manifest.version}" doesn't match the lexicon constraint /^[a-zA-Z0-9.-]+$/ (max 64 chars; semver build-metadata "+..." disallowed).`,
			{ version: options.manifest.version },
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

	// 5. Apply atomically. `applyWrites` is typed against the lexicon's strict
	// `Main` types; we hand it our looser local shapes (validated up front +
	// PDS-validated server-side via validate: true) and cast at the boundary.
	const batch = await options.publisher.applyWrites({
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
	return {
		...(v as unknown as PackageProfileRecordShape),
		lastUpdated: new Date().toISOString(),
	};
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
