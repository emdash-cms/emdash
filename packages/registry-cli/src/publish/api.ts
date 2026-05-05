/**
 * Programmatic publish API.
 *
 * Pure-ish core of the publish pipeline: given an already-fetched tarball,
 * an extracted manifest, an authenticated `PublishingClient`, and the URL
 * the bytes are hosted at, this writes the profile (if missing) and release
 * records to the publisher's atproto repo.
 *
 * Splits cleanly from the CLI command so tests can run it against a mock
 * `PublishingClient` without going through OAuth, the filesystem credentials
 * store, or an HTTP fetch for the tarball.
 *
 * Failure modes:
 *
 *   - `DEPRECATED_CAPABILITY`: the manifest declares one of the deprecated
 *     capability names. Bundle warns; publish refuses, per the deprecation
 *     policy. The caller should rename and rebuild before retrying.
 *   - `PROFILE_BOOTSTRAP_MISSING_FIELD`: first publish without the required
 *     `license` and `securityEmail`/`securityUrl`. The lexicon enforces
 *     these; we surface the error here so the user gets actionable feedback
 *     before the network round-trip.
 *   - `RELEASE_ALREADY_PUBLISHED`: the release record at `<slug>:<version>`
 *     already exists in the repo. FAIR specifies version-record immutability,
 *     so publish refuses by default; callers can opt in to overwriting via
 *     `allowOverwrite: true` at their own risk (aggregators may flag the
 *     change as a takedown).
 */

import { ClientResponseError } from "@atcute/client";
import type { Nsid } from "@atcute/lexicons";
import type { Did, PublishingClient } from "@emdash-cms/registry-client";
import type { PluginManifest } from "@emdash-cms/plugin-types";
import { isDeprecatedCapability } from "@emdash-cms/plugin-types";
import { NSID } from "@emdash-cms/registry-lexicons";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type PublishErrorCode =
	| "DEPRECATED_CAPABILITY"
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

interface PackageProfileRecord {
	$type: string;
	id: string;
	type: string;
	license: string;
	authors: Array<{ name: string; url?: string; email?: string }>;
	security: Array<{ url?: string; email?: string }>;
	slug?: string;
	lastUpdated?: string;
}

interface PackageReleaseRecord {
	$type: string;
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

const SLASH_RE = /\//g;
const LEADING_AT_RE = /^@/;

export async function publishRelease(options: PublishOptions): Promise<PublishResult> {
	const log = options.logger ?? {};

	// 1. Hard-fail on deprecated capabilities.
	const deprecated = options.manifest.capabilities.filter(isDeprecatedCapability);
	if (deprecated.length > 0) {
		throw new PublishError(
			"DEPRECATED_CAPABILITY",
			`Plugin uses deprecated capability names: ${deprecated.join(", ")}. Rename them before publishing.`,
			{ deprecated },
		);
	}

	const slug = sanitiseSlug(options.manifest.id);
	const profileUri = atUri(options.did, NSID.packageProfile, slug);
	const releaseRkey = `${slug}:${options.manifest.version}`;
	const ignoredProfileFields: string[] = [];

	// 2. Bootstrap or reuse the profile.
	const existingProfile = await getRecordOrNull(
		options.publisher,
		NSID.packageProfile,
		slug,
	);
	let profileCreated = false;

	if (existingProfile) {
		ignoredProfileFields.push(...listProvidedProfileFields(options.profile));
		log.info?.(`Reusing existing profile: ${profileUri}`);
	} else {
		const profileRecord = buildProfileRecord({
			slug,
			profileUri,
			profile: options.profile,
		});
		await options.publisher.putRecord({
			collection: NSID.packageProfile,
			rkey: slug,
			record: profileRecord as unknown as Record<string, unknown>,
		});
		profileCreated = true;
		log.success?.(`Created profile: ${profileUri}`);
	}

	// 3. Refuse to overwrite an existing release unless asked.
	const existingRelease = await getRecordOrNull(
		options.publisher,
		NSID.packageRelease,
		releaseRkey,
	);
	if (existingRelease && !options.allowOverwrite) {
		throw new PublishError(
			"RELEASE_ALREADY_PUBLISHED",
			`Release ${slug}@${options.manifest.version} is already published. ` +
				"FAIR specifies that version records are immutable; aggregators and " +
				"labellers may treat any change as a takedown event. " +
				"Pass allowOverwrite: true to overwrite anyway.",
			{ slug, version: options.manifest.version },
		);
	}
	const releaseOverwritten = Boolean(existingRelease);
	if (releaseOverwritten) {
		log.warn?.(
			`Overwriting existing release ${slug}@${options.manifest.version}. ` +
				"Consumers who already installed this version will keep the old bytes; " +
				"aggregators may flag the change.",
		);
	}

	// 4. Put the release record.
	const releaseRecord: PackageReleaseRecord = {
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
	const releaseResult = await options.publisher.putRecord({
		collection: NSID.packageRelease,
		rkey: releaseRkey,
		record: releaseRecord as unknown as Record<string, unknown>,
	});

	return {
		profileUri,
		releaseUri: releaseResult.uri,
		releaseCid: releaseResult.cid,
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

/**
 * Convert a plugin id (which may be a scoped npm name like
 * `@emdash-cms/sandboxed-test`) into a slug suitable for an atproto rkey.
 * Strips the leading `@` and replaces `/` with `-`. The lexicon validates
 * `^[a-z][a-z0-9_-]*$` and 64-char limit; we don't enforce that here -- the
 * PDS will reject if it doesn't match.
 */
export function sanitiseSlug(id: string): string {
	return id.replace(LEADING_AT_RE, "").replace(SLASH_RE, "-");
}

function atUri(did: Did, collection: string, rkey: string): string {
	return `at://${did}/${collection}/${rkey}`;
}

async function getRecordOrNull(
	publisher: PublishingClient,
	collection: Nsid,
	rkey: string,
): Promise<unknown> {
	try {
		const record = await publisher.getRecord({ collection, rkey });
		return record.value;
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "RecordNotFound") {
			return null;
		}
		throw error;
	}
}

function buildProfileRecord(input: {
	slug: string;
	profileUri: string;
	profile: ProfileBootstrap | undefined;
}): PackageProfileRecord {
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
 */
function listProvidedProfileFields(profile: ProfileBootstrap | undefined): string[] {
	if (!profile) return [];
	const provided: string[] = [];
	for (const [key, value] of Object.entries(profile)) {
		if (typeof value === "string" && value.length > 0) {
			provided.push(key);
		}
	}
	return provided;
}
