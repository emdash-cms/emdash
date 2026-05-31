/**
 * Translate a validated manifest into the existing publish-input shape.
 *
 * The single-author / single-security-contact convenience forms are
 * normalised here: by the time this returns, the caller sees only the
 * array shapes the lexicon uses.
 */

import type { PluginCapability, PluginStorageConfig } from "@emdash-cms/plugin-types";

import type { ProfileBootstrap, ProfileInput } from "../publish/api.js";
import type {
	Manifest,
	ManifestArtifacts,
	ManifestAuthor,
	ManifestSecurityContact,
} from "./schema.js";

/**
 * Normalised "after the schema's single/multi convenience has been
 * collapsed" view of a manifest. The CLI passes this to the publish
 * pipeline rather than the raw `Manifest` so the rest of the code
 * never has to think about `author` vs `authors`.
 */
/**
 * Admin surface, mirroring the structure the runtime expects. Pulled
 * out as a type alias so the bundle layer can pass it through to the
 * bundled `manifest.json` without re-asserting the shape.
 */
export interface NormalisedAdmin {
	pages: Array<{ path: string; label: string; icon?: string }>;
	widgets: Array<{ id: string; title?: string; size?: "full" | "half" | "third" }>;
}

export interface NormalisedManifest {
	// Identity. All three are guaranteed present in the normalised
	// form: `slug` and `publisher` are required at authoring time,
	// and `version` is resolved during normalisation from the manifest
	// or `package.json#version` (with a mismatch / missing check).
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

	/**
	 * Release-level environment constraints (`release.requires`). Map of
	 * `env:*`/DID keys to semver ranges. Release-level, not profile-level —
	 * passed to `publishRelease` separately, never via `manifestToProfileInput`.
	 */
	requires: Record<string, string> | undefined;

	/**
	 * Release media artifacts (icon / screenshot / banner). File refs only —
	 * the publish command resolves, measures, and uploads them. `undefined`
	 * when the manifest declared none.
	 */
	artifacts: ManifestArtifacts | undefined;

	// Trust contract (defaults applied by the schema; always present here).
	capabilities: PluginCapability[];
	allowedHosts: string[];
	storage: PluginStorageConfig;

	/**
	 * Admin surface. Always present in the normalised form (with
	 * empty arrays when the manifest didn't declare anything) so the
	 * bundle layer can pass it through without conditional handling.
	 */
	admin: NormalisedAdmin;
}

/**
 * Thrown when the source manifest and the package's `package.json` carry
 * different versions, or when neither carries one. Callers convert this
 * into their own error code (BuildError, BundleError, ManifestError).
 */
export class VersionMismatchError extends Error {
	override readonly name = "VersionMismatchError";
	readonly code: "VERSION_MISMATCH" | "VERSION_MISSING";
	readonly manifestVersion: string | undefined;
	readonly packageVersion: string | undefined;

	constructor(
		code: "VERSION_MISMATCH" | "VERSION_MISSING",
		message: string,
		manifestVersion: string | undefined,
		packageVersion: string | undefined,
	) {
		super(message);
		this.code = code;
		this.manifestVersion = manifestVersion;
		this.packageVersion = packageVersion;
	}
}

/**
 * Reconcile the manifest's `version` with the package's `version`.
 *
 *  - Both present and equal → returns that string.
 *  - Both present and different → throws `VERSION_MISMATCH`.
 *  - Only one present → returns it.
 *  - Neither present → throws `VERSION_MISSING`.
 *
 * Surrounding whitespace on either input is rejected with a dedicated
 * error so a visually-identical-but-not-equal pair like `"1.0.0 "`
 * vs `"1.0.0"` doesn't print a confusing mismatch message.
 */
export function resolvePluginVersion(
	manifestVersion: string | undefined,
	packageVersion: string | undefined,
): string {
	if (manifestVersion !== undefined && manifestVersion.trim() !== manifestVersion) {
		throw new VersionMismatchError(
			"VERSION_MISMATCH",
			`Plugin version in emdash-plugin.jsonc has leading or trailing whitespace (${JSON.stringify(manifestVersion)}). Trim it.`,
			manifestVersion,
			packageVersion,
		);
	}
	if (packageVersion !== undefined && packageVersion.trim() !== packageVersion) {
		throw new VersionMismatchError(
			"VERSION_MISMATCH",
			`Plugin version in package.json has leading or trailing whitespace (${JSON.stringify(packageVersion)}). Trim it.`,
			manifestVersion,
			packageVersion,
		);
	}
	if (manifestVersion !== undefined && packageVersion !== undefined) {
		if (manifestVersion !== packageVersion) {
			throw new VersionMismatchError(
				"VERSION_MISMATCH",
				`Plugin version disagrees between emdash-plugin.jsonc (${manifestVersion}) and package.json (${packageVersion}). Remove "version" from emdash-plugin.jsonc to let package.json drive it, or align both values.`,
				manifestVersion,
				packageVersion,
			);
		}
		return manifestVersion;
	}
	if (manifestVersion !== undefined) return manifestVersion;
	if (packageVersion !== undefined) return packageVersion;
	throw new VersionMismatchError(
		"VERSION_MISSING",
		'Plugin version not set. Add "version" to package.json (npm-distributed plugins) or to emdash-plugin.jsonc (registry-only plugins).',
		manifestVersion,
		packageVersion,
	);
}

/**
 * Collapse the convenience forms (`author`, `security`) into the array
 * forms (`authors`, `securityContacts`), and reconcile the manifest's
 * optional `version` against the package's `version` so callers see a
 * single resolved string.
 *
 * The manifest schema's `.refine()` rules already guarantee that exactly
 * one of each name/contact pair is set, so the runtime checks here are
 * defensive — a caller that bypassed validation would still produce a
 * coherent result.
 *
 * Pass `packageVersion: undefined` for registry-only plugins with no
 * `package.json` — in that case the manifest's `version` is used
 * directly (and is required, by the same `resolvePluginVersion` rules).
 */
export function normaliseManifest(manifest: Manifest, packageVersion?: string): NormalisedManifest {
	const authors = manifest.authors ?? (manifest.author ? [manifest.author] : []);
	const securityContacts =
		manifest.securityContacts ?? (manifest.security ? [manifest.security] : []);
	const version = resolvePluginVersion(manifest.version, packageVersion);
	return {
		slug: manifest.slug,
		version,
		publisher: manifest.publisher,
		license: manifest.license,
		authors,
		securityContacts,
		name: manifest.name,
		description: manifest.description,
		keywords: manifest.keywords,
		repo: manifest.repo,
		requires: manifest.release?.requires,
		artifacts: manifest.release?.artifacts,
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
		admin: {
			pages: manifest.admin?.pages ?? [],
			widgets: manifest.admin?.widgets ?? [],
		},
	};
}

/**
 * Convert a normalised manifest into the structured `ProfileInput` that
 * `publishRelease` consumes. Carries the full lexicon profile block:
 * multi-author, multi-security, name, description, keywords. `repo` is a
 * release-level field and is passed separately (see `NormalisedManifest.repo`).
 */
export function manifestToProfileInput(manifest: NormalisedManifest): ProfileInput {
	const input: ProfileInput = {
		license: manifest.license,
		authors: manifest.authors.map((a) => ({
			name: a.name,
			...(a.url !== undefined ? { url: a.url } : {}),
			...(a.email !== undefined ? { email: a.email } : {}),
		})),
		security: manifest.securityContacts.map((c) => ({
			...(c.url !== undefined ? { url: c.url } : {}),
			...(c.email !== undefined ? { email: c.email } : {}),
		})),
	};
	if (manifest.name !== undefined) input.name = manifest.name;
	if (manifest.description !== undefined) input.description = manifest.description;
	if (manifest.keywords !== undefined) input.keywords = manifest.keywords;
	return input;
}

/**
 * Convert a normalised manifest into the deprecated flat `ProfileBootstrap`
 * shape. For multi-author manifests, the first author wins (the flat shape
 * models only one author and one security contact).
 *
 * @deprecated Use {@link manifestToProfileInput}. Retained for callers still
 * on the flat publish path.
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
