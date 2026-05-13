/**
 * Plugin identifier helpers for the experimental decentralized plugin
 * registry.
 *
 * Registry plugins are addressed by `(publisher_did, slug)`, but the
 * EmDash runtime threads a single `pluginId: string` through every
 * install primitive (R2 storage keys, `PluginStateRepository`,
 * `syncMarketplacePlugins`, sandbox cache keys). Rather than refactor
 * everything to carry a composite identifier, we normalize the registry
 * tuple to an opaque content-addressed id that satisfies the existing
 * `validatePluginIdentifier` shape (`/^[a-z][a-z0-9_-]*$/`).
 *
 * The normalized id is:
 *
 *   `r_` + base32-encoded SHA-256(publisher_did + "\n" + slug), truncated.
 *
 * Properties:
 *
 *   - Deterministic. The same `(publisher, slug)` always produces the
 *     same id, so re-resolving an installed plugin's metadata against
 *     the aggregator is a straightforward lookup keyed by the columns
 *     stored alongside `plugin_id` in `plugin_states`.
 *   - Collision-resistant. 80 bits of truncated hash; a 50% birthday
 *     collision happens around 2^40 distinct plugins, well beyond what
 *     this registry will ever index.
 *   - R2-safe. Lowercase alphanumerics + underscore (no hyphens), no
 *     `:` or `/`. Existing sandbox cache keys (`${pluginId}:${version}`)
 *     keep working because the id contains no `:`.
 *   - Syntactically distinct from typical marketplace plugin ids: the
 *     `r_` prefix plus exactly 16 base32 characters is unlikely to be
 *     chosen as a marketplace id. Not formally guaranteed by the
 *     validator -- marketplace ids may begin with `r_` and contain
 *     hyphens -- so the install handler also performs an explicit
 *     pre-existing-row check at the derived id and rejects any cross-
 *     source collision (`PLUGIN_ID_COLLISION`).
 *
 * Reverse lookup (id → publisher + slug) requires the `plugin_states`
 * row -- the hash is one-way. That's intentional: any code path that
 * needs the human-meaningful pair already has the state row in hand.
 */

/** Length (in base32 characters) of the truncated hash portion of the id. */
const HASH_LENGTH = 16;

/** Total expected length of a registry plugin id. */
export const REGISTRY_PLUGIN_ID_LENGTH = 2 /* "r_" */ + HASH_LENGTH;

/**
 * Regex matching a well-formed registry plugin id. Used by call sites
 * that need to distinguish registry installs from marketplace installs
 * without consulting the `source` column on `plugin_states`.
 *
 * The base32 alphabet here uses RFC 4648 lowercase without padding,
 * matching {@link base32Encode}'s output.
 */
export const REGISTRY_PLUGIN_ID_PATTERN = /^r_[a-z2-7]{16}$/;

const BASE32_ALPHABET = "abcdefghijklmnopqrstuvwxyz234567";

/**
 * RFC 4648 base32 encoding without padding, lowercase. Implemented inline
 * rather than depending on a multibase library because (a) we only need
 * lowercase base32 here, (b) we need it to run identically in workerd,
 * Node, and the browser, and (c) the implementation is fewer lines than
 * the import statement would be.
 */
function base32Encode(bytes: Uint8Array): string {
	let bits = 0;
	let value = 0;
	let out = "";
	for (const byte of bytes) {
		value = (value << 8) | byte;
		bits += 8;
		while (bits >= 5) {
			bits -= 5;
			out += BASE32_ALPHABET[(value >>> bits) & 0x1f];
		}
	}
	if (bits > 0) {
		out += BASE32_ALPHABET[(value << (5 - bits)) & 0x1f];
	}
	return out;
}

/**
 * Derive the normalized plugin id for a registry-published plugin.
 *
 * Throws if either input is empty or whitespace-only -- a missing DID
 * or slug is always a programming error in the install path, not a
 * recoverable runtime condition.
 */
export async function makeRegistryPluginId(publisherDid: string, slug: string): Promise<string> {
	const did = publisherDid.trim();
	const s = slug.trim();
	if (!did) throw new Error("makeRegistryPluginId: publisherDid is required");
	if (!s) throw new Error("makeRegistryPluginId: slug is required");

	// `\n` separator avoids ambiguity: no canonical did:plc / did:web form
	// contains a literal newline, so `("a", "b\nc")` cannot hash to the
	// same bytes as `("a\nb", "c")`.
	const input = `${did}\n${s}`;
	const hashBuffer = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input));
	const encoded = base32Encode(new Uint8Array(hashBuffer));
	return `r_${encoded.slice(0, HASH_LENGTH)}`;
}

/**
 * Return whether `pluginId` is a well-formed registry plugin id.
 *
 * This is a syntactic check, not a database lookup -- it answers
 * "could this id have come from `makeRegistryPluginId`?", not "is this
 * plugin installed?".
 */
export function isRegistryPluginId(pluginId: string): boolean {
	return REGISTRY_PLUGIN_ID_PATTERN.test(pluginId);
}
