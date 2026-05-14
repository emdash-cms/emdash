/**
 * Translate a validated manifest into the existing publish-input shape.
 *
 * The single-author / single-security-contact convenience forms are
 * normalised here: by the time this returns, the caller sees only the
 * array shapes the lexicon uses.
 */

import type { PluginCapability, PluginStorageConfig } from "@emdash-cms/plugin-types";

import type { ProfileBootstrap } from "../publish/api.js";
import type { Manifest, ManifestAuthor, ManifestSecurityContact } from "./schema.js";

/**
 * Normalised "after the schema's single/multi convenience has been
 * collapsed" view of a manifest. The CLI passes this to the publish
 * pipeline rather than the raw `Manifest` so the rest of the code
 * never has to think about `author` vs `authors`.
 */
export interface NormalisedManifest {
	// Identity (required).
	slug: string;
	version: string;
	publisher: string;

	// Profile.
	license: string;
	authors: ManifestAuthor[];
	securityContacts: ManifestSecurityContact[];
	name: string | undefined;
	description: string | undefined;
	keywords: string[] | undefined;
	repo: string | undefined;

	// Trust contract (defaults applied by the schema; always present here).
	capabilities: PluginCapability[];
	allowedHosts: string[];
	storage: PluginStorageConfig;
}

/**
 * Collapse the convenience forms (`author`, `security`) into the array
 * forms (`authors`, `securityContacts`).
 *
 * The manifest schema's `.refine()` rules already guarantee that exactly
 * one of each pair is set, so the runtime checks here are defensive — a
 * caller that bypassed validation would still produce a coherent result.
 */
export function normaliseManifest(manifest: Manifest): NormalisedManifest {
	const authors = manifest.authors ?? (manifest.author ? [manifest.author] : []);
	const securityContacts =
		manifest.securityContacts ?? (manifest.security ? [manifest.security] : []);
	return {
		slug: manifest.slug,
		version: manifest.version,
		publisher: manifest.publisher,
		license: manifest.license,
		authors,
		securityContacts,
		name: manifest.name,
		description: manifest.description,
		keywords: manifest.keywords,
		repo: manifest.repo,
		// Schema validation already gates capability strings to the
		// current vocabulary via a runtime check, so by the time we get
		// here the strings are guaranteed members of PluginCapability.
		// Zod's inferred type is `string[]` (it can't see the runtime
		// narrowing), and the cast bridges that gap.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema-enforced narrowing
		capabilities: manifest.capabilities as PluginCapability[],
		allowedHosts: manifest.allowedHosts,
		// Same story for storage: Zod returns Record<string, {...}>,
		// PluginStorageConfig is the same shape with a tighter key
		// constraint.
		// eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- schema-enforced narrowing
		storage: manifest.storage as PluginStorageConfig,
	};
}

/**
 * Convert a normalised manifest into the `ProfileBootstrap` shape that
 * `publishRelease` consumes. For multi-author manifests, the first
 * author wins (the publish lexicon supports an array, but
 * `ProfileBootstrap` doesn't model that yet).
 *
 * `name`, `description`, `keywords`, and `repo` are accepted by the
 * manifest schema but not wired through here. They land in publish in a
 * follow-up issue alongside the broader profile-fields work. The fields
 * are not silently lost — the manifest is the source of truth and we'll
 * read them again when the publish API accepts them.
 */
export function manifestToProfileBootstrap(manifest: NormalisedManifest): ProfileBootstrap {
	const author = manifest.authors[0];
	const security = manifest.securityContacts[0];

	const profile: ProfileBootstrap = { license: manifest.license };
	if (author?.name !== undefined) profile.authorName = author.name;
	if (author?.url !== undefined) profile.authorUrl = author.url;
	if (author?.email !== undefined) profile.authorEmail = author.email;
	if (security?.email !== undefined) profile.securityEmail = security.email;
	if (security?.url !== undefined) profile.securityUrl = security.url;
	return profile;
}
