/**
 * Translate a validated manifest into the existing publish-input shape.
 *
 * For v1 (issue #1028), publish consumes only the six `ProfileBootstrap`
 * fields the original flag-based UX exposed. The manifest carries those
 * plus a small handful of additional fields (`name`, `description`,
 * `keywords`, `repo`) that aren't wired through publish yet — those land
 * in issues #1029-#1033.
 *
 * The single-author / single-security-contact convenience forms are
 * normalised here: by the time this returns, the caller sees only the
 * array shapes the lexicon uses.
 */

import type { ProfileBootstrap } from "../publish/api.js";
import type { Manifest, ManifestAuthor, ManifestSecurityContact } from "./schema.js";

/**
 * Normalised "after the schema's single/multi convenience has been
 * collapsed" view of a manifest. The CLI passes this to the publish
 * pipeline rather than the raw `Manifest` so the rest of the code
 * never has to think about `author` vs `authors`.
 *
 * Fields not yet consumed by publish (name, description, keywords, repo)
 * are passed through unchanged so issues #1029-#1033 can wire them up
 * without revisiting this translation step.
 */
export interface NormalisedManifest {
	license: string;
	/**
	 * Pinned publisher (DID or handle). Undefined when the manifest
	 * doesn't pin a publisher; the CLI writes the active session's DID
	 * back after first publish so this is undefined only on first
	 * publish or in CI flows where the user opted out via `--no-manifest`.
	 */
	publisher: string | undefined;
	authors: ManifestAuthor[];
	securityContacts: ManifestSecurityContact[];
	name: string | undefined;
	description: string | undefined;
	keywords: string[] | undefined;
	repo: string | undefined;
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
		license: manifest.license,
		publisher: manifest.publisher,
		authors,
		securityContacts,
		name: manifest.name,
		description: manifest.description,
		keywords: manifest.keywords,
		repo: manifest.repo,
	};
}

/**
 * Convert a normalised manifest into the legacy `ProfileBootstrap` shape
 * that `publishRelease` already understands. This is a TEMPORARY bridge
 * for v1 — it discards everything but the six fields publish reads today.
 *
 * Once issue #1029 lands and `publishRelease` accepts the richer profile
 * shape directly, this function goes away and we pass the
 * `NormalisedManifest` straight through.
 *
 * Behaviour for multi-author plugins: the first author wins. The publish
 * lexicon supports an array, but `ProfileBootstrap` doesn't model that
 * today. Issues #1029 fixes this; until then, multi-author manifests
 * publish their first author and we emit a warning at the CLI layer.
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

/**
 * True if the manifest carries fields that v1 publish can't yet consume.
 * The CLI uses this to warn the user that those fields are accepted (so
 * `validate` passes) but won't appear in the published record until the
 * relevant follow-up issue lands.
 *
 * Centralised here so each follow-up issue has one place to remove its
 * field from the warning list when it wires through.
 */
export function findUnwiredManifestFields(
	manifest: NormalisedManifest,
): Array<{ field: string; issue: string }> {
	const unwired: Array<{ field: string; issue: string }> = [];
	if (manifest.name !== undefined) unwired.push({ field: "name", issue: "#1029" });
	if (manifest.description !== undefined) {
		unwired.push({ field: "description", issue: "#1029" });
	}
	if (manifest.keywords !== undefined) {
		unwired.push({ field: "keywords", issue: "#1029" });
	}
	if (manifest.repo !== undefined) unwired.push({ field: "repo", issue: "#1029" });
	// Multi-author warning is separate: publish accepts the field but only
	// publishes the first entry until #1029 lands.
	if (manifest.authors.length > 1) {
		unwired.push({ field: "authors[1..]", issue: "#1029" });
	}
	if (manifest.securityContacts.length > 1) {
		unwired.push({ field: "securityContacts[1..]", issue: "#1029" });
	}
	return unwired;
}
