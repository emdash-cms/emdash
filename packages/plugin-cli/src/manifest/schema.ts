/**
 * Zod schema for `emdash-plugin.jsonc` — the publisher-authored manifest that
 * sits next to a plugin's source and feeds the registry CLI's `publish`,
 * `validate`, and `init` commands.
 *
 * Relationship to the lexicon
 * ---------------------------
 *
 * This schema is NOT the lexicon. The lexicon
 * (`com.emdashcms.experimental.package.profile`) is the on-wire atproto
 * record format, optimised for content-addressed storage and aggregator
 * indexing. This schema is the authoring format, optimised for a human
 * editing a file in VS Code with `$schema`-powered IDE completion.
 *
 * Fields that exist in BOTH places use the lexicon's field names verbatim
 * (`license`, `keywords`, `repo`, `name`, `description`). Fields that the
 * publisher cannot reasonably write by hand are derived at publish time and
 * do not appear here: `id` (full AT URI requires the publisher's DID),
 * `type` (always `"emdash-plugin"` from this CLI), `slug` (derived from the
 * bundled `manifest.json`'s `id`), `lastUpdated` (set at publish time),
 * `artifacts.package` (filled in from the fetched tarball), `extensions`
 * (computed from the bundled manifest's capabilities + allowedHosts).
 *
 * The translation step lives in `./translate.ts`.
 *
 * Single-vs-multi-author convenience
 * ----------------------------------
 *
 * The lexicon stores `authors` and `security` as arrays. The overwhelmingly
 * common case is one author and one security contact, so the manifest
 * accepts both shapes:
 *
 *     // single-author
 *     { "author": { "name": "Jane Doe" }, "security": { "email": "..." } }
 *
 *     // multi-author
 *     { "authors": [{ "name": "..." }, { "name": "..." }],
 *       "securityContacts": [{ "email": "..." }] }
 *
 * `loadManifest` normalises both forms to the array shape before passing to
 * publish. You can't mix forms for the same field (e.g. `author` AND
 * `authors`); the schema rejects that.
 *
 * Strict mode
 * -----------
 *
 * Unknown keys are rejected with `.strict()`. This catches typos like
 * `"licens": "MIT"` rather than letting them silently fall through. The
 * tradeoff is that adding a field requires a CLI release; we accept that
 * cost for v1 and may revisit after one cycle of field-add (issue #1029).
 */

import { isDid, isHandle } from "@atcute/lexicons/syntax";
import {
	CAPABILITY_RENAMES,
	isDeprecatedCapability,
	normalizeCapability,
	PLUGIN_SLUG_MAX_LENGTH,
	PLUGIN_SLUG_RE,
	PLUGIN_VERSION_MAX_LENGTH,
	PLUGIN_VERSION_RE,
} from "@emdash-cms/plugin-types";
import { isValidVersionRange } from "@emdash-cms/registry-client/env";
import { z } from "zod";

// ──────────────────────────────────────────────────────────────────────────
// Field-level schemas — exported so tests can target individual rules.
//
// Each field uses `.meta({ description })` so the descriptions flow into
// the generated JSON Schema and surface as inline hover hints in editors
// that support `$schema`-driven completion (VS Code, IntelliJ).
// ──────────────────────────────────────────────────────────────────────────

/**
 * SPDX license expression. The lexicon caps this at 256 chars. We don't
 * validate the SPDX grammar here — the registry aggregator does that and
 * gives clearer errors. We DO refuse the empty string and obvious garbage
 * (whitespace-only) so the publish command can surface a useful message
 * before any network round-trip.
 */
export const LicenseSchema = z
	.string()
	.min(1, 'license must be a non-empty SPDX expression (e.g. "MIT")')
	.max(256, "license must be <= 256 characters (SPDX expressions are short)")
	.refine((v) => v.trim().length > 0, "license cannot be whitespace-only")
	.meta({
		title: "License",
		description:
			'SPDX license expression (e.g. "MIT", "Apache-2.0", "MIT OR Apache-2.0"). Required on first publish; ignored on subsequent publishes (the existing profile wins).',
		examples: ["MIT", "Apache-2.0", "MIT OR Apache-2.0"],
	});

/**
 * One author. Mirrors `profile.json#author`. The lexicon says authors
 * "SHOULD specify at least one of url or email"; we don't enforce that
 * here because anonymous-but-named authors are a legitimate (if
 * discouraged) shape. The publish command surfaces it as a warning.
 */
export const AuthorSchema = z
	.object({
		name: z
			.string()
			.min(1, "author.name cannot be empty")
			.max(256, "author.name must be <= 256 characters")
			.meta({ description: "Display name." }),
		url: z
			.string()
			.url("author.url must be a valid URL")
			.max(1024, "author.url must be <= 1024 characters")
			.meta({
				description: "Author's homepage or profile URL. Either this or `email` is recommended.",
			})
			.optional(),
		email: z
			.string()
			.email("author.email must be a valid email")
			.max(256, "author.email must be <= 256 characters")
			.meta({ description: "Author's contact email. Either this or `url` is recommended." })
			.optional(),
	})
	.strict()
	.meta({
		title: "Author",
		description: "A single author entry. Mirrors the lexicon's author shape.",
	});

/**
 * One security contact. Mirrors `profile.json#contact`. The lexicon
 * mandates "at least one of url or email MUST be present"; Lexicon JSON
 * can't express "required one-of", so we enforce it here. Without this
 * check a publisher could write `{ "security": {} }` and the publish
 * record would carry an empty contact (which aggregators reject anyway,
 * but failing here is a better user experience).
 */
export const SecurityContactSchema = z
	.object({
		url: z
			.string()
			.url("security.url must be a valid URL")
			.max(1024, "security.url must be <= 1024 characters")
			.meta({
				description:
					"Security disclosure URL (e.g. a security.txt or vulnerability-reporting page). Either this or `email` is required.",
			})
			.optional(),
		email: z
			.string()
			.email("security.email must be a valid email")
			.max(256, "security.email must be <= 256 characters")
			.meta({
				description: "Security contact email. Either this or `url` is required.",
			})
			.optional(),
	})
	.strict()
	.refine(
		(v) => v.url !== undefined || v.email !== undefined,
		"security contact must have at least one of `url` or `email`",
	)
	.meta({
		title: "Security contact",
		description: "A single security contact. At least one of `url` or `email` must be present.",
	});

/**
 * Publisher identity, used to verify the active session matches the
 * manifest's pinned publisher at publish time. Accepts a DID or a handle.
 *
 * Recommended form: DID (`did:plc:...`). DIDs are durable — they survive
 * handle changes. Handles are friendlier to read but mutable: if the
 * publisher's handle changes, the manifest needs an update.
 *
 * Omitted on first publish, the CLI writes the active session's DID
 * back into the manifest automatically. Subsequent publishes verify
 * against the pinned value.
 *
 * Validation is structural only here: DID syntax (`did:method:id`) or
 * handle syntax (`name.tld`). The actual resolve-to-DID step happens at
 * publish time via `@atcute/identity-resolver`.
 */
export const PublisherSchema = z
	.string()
	.refine(
		(v) => isDid(v) || isHandle(v),
		'publisher must be an atproto DID (e.g. "did:plc:abc123") or handle (e.g. "example.com")',
	)
	.meta({
		title: "Publisher",
		description:
			"Atproto DID or handle of the publishing identity. Pinned on first publish to prevent accidental publishes from a different account. DIDs are recommended (durable); handles work but are mutable.",
		examples: ["did:plc:abc123def456", "example.com"],
	});

/** Optional human-readable display name. Mirrors `profile.json#name`. */
export const NameSchema = z
	.string()
	.min(1, "name cannot be empty when set")
	.max(1024, "name must be <= 1024 characters")
	.meta({
		title: "Display name",
		description:
			"Human-readable name shown in directory listings. Defaults to the plugin's `id` when omitted.",
	});

/** Short description. Mirrors `profile.json#description`. */
export const DescriptionSchema = z
	.string()
	.min(1, "description cannot be empty when set")
	.max(1024, "description must be <= 1024 characters")
	.meta({
		title: "Description",
		description:
			"Short description (<= 140 graphemes by FAIR convention). Aggregators may truncate longer values when displaying in compact lists.",
	});

/** Search keywords. Mirrors `profile.json#keywords`. */
export const KeywordsSchema = z
	.array(
		z.string().min(1, "keyword cannot be empty").max(128, "each keyword must be <= 128 characters"),
	)
	.max(5, "keywords array must have <= 5 entries (FAIR convention)")
	.meta({
		title: "Keywords",
		description: "Search keywords (<= 5 entries, FAIR convention).",
	});

/**
 * Source repository URL. Mirrors `release.json#repo`. The lexicon accepts
 * either an HTTPS URL or an AT URI; v1 of the CLI accepts HTTPS only.
 * AT-URI source repos can be added in a later issue without changing the
 * field name.
 *
 * We use a regex `pattern` rather than `.refine` for the https-only rule
 * so the constraint flows through to the generated JSON Schema. Editors
 * doing client-side validation against the schema then surface the same
 * error the CLI does.
 */
export const RepoSchema = z
	.string()
	.regex(/^https:\/\//, "repo must be an https:// URL (AT-URI source repos aren't supported yet)")
	.url("repo must be a valid URL")
	.max(1024, "repo must be <= 1024 characters")
	.meta({
		title: "Source repository",
		description: "HTTPS URL of the plugin's source repository. Surfaced in registry listings.",
		examples: ["https://github.com/emdash-cms/plugin-gallery"],
	});

/** `env:<name>` requirement keys (one or more non-colon characters). */
const REQUIRES_ENV_KEY_RE = /^env:[^:]+$/;

/**
 * Release-level environment constraints. Mirrors `release.json#requires`: a
 * map of `env:*` keys (host environment requirements) or package DIDs to
 * semver-range constraint strings. EmDash uses `env:emdash` and `env:astro`.
 *
 * Keys are validated structurally (`env:<name>` or `did:<method>:<id>`) and
 * values against the shared range grammar in `@emdash-cms/registry-client/env`,
 * the same evaluator the install gate and the admin compatibility warning use,
 * so a publisher can't ship a constraint that no consumer can evaluate.
 */
export const RequiresSchema = z
	.record(
		z
			.string()
			.refine(
				(k) => REQUIRES_ENV_KEY_RE.test(k) || isDid(k),
				'requires key must be an `env:*` requirement (e.g. "env:astro") or a package DID',
			),
		z
			.string()
			.min(1, "requires range must be a non-empty semver range")
			.refine(
				isValidVersionRange,
				'requires range must be a valid semver range (e.g. ">=4.16", "^4.0.0", ">=4.16.0 <5.0.0")',
			),
	)
	.meta({
		title: "Environment requirements",
		description:
			'Host environment constraints for this release, keyed by `env:*` (e.g. "env:astro", "env:emdash") with semver-range values. EmDash refuses to install a release whose constraints the host does not satisfy.',
		examples: [{ "env:emdash": ">=1.0.0", "env:astro": ">=4.16" }],
	});

// ──────────────────────────────────────────────────────────────────────────
// Identity (slug + version)
// ──────────────────────────────────────────────────────────────────────────

/**
 * The plugin's slug. ASCII letter then letters/digits/hyphens/underscores,
 * max 64 chars. Same constraints as the registry lexicon's `rkey`-portion
 * of a release record, validated via the shared `PLUGIN_SLUG_RE` in
 * `@emdash-cms/plugin-types`.
 *
 * Slug + publisher together form the package identity. The runtime derives
 * the AT URI from them; the author never writes the URI directly.
 */
export const SlugSchema = z
	.string()
	.min(1, "slug must be a non-empty string")
	.max(PLUGIN_SLUG_MAX_LENGTH, `slug must be <= ${PLUGIN_SLUG_MAX_LENGTH} characters`)
	.regex(
		PLUGIN_SLUG_RE,
		'slug must start with a lowercase letter, then lowercase letters / digits / "-" / "_" (e.g. "gallery", "my-plugin")',
	)
	.meta({
		title: "Slug",
		description:
			"URL-safe plugin identifier within the publisher's namespace. ASCII letter then letters/digits/hyphens/underscores, max 64 characters. Combined with the publisher DID, this is the registry's primary key.",
		examples: ["gallery", "image-resizer", "my-plugin"],
	});

/**
 * The plugin's version. Subset of semver 2.0; build-metadata (`+...`) is
 * disallowed because atproto record keys can't contain `+`. Validated via
 * `PLUGIN_VERSION_RE` from `@emdash-cms/plugin-types`.
 */
export const VersionSchema = z
	.string()
	.min(1, "version must be a non-empty string")
	.max(PLUGIN_VERSION_MAX_LENGTH, `version must be <= ${PLUGIN_VERSION_MAX_LENGTH} characters`)
	.regex(
		PLUGIN_VERSION_RE,
		'version must follow semver 2.0 without build-metadata (e.g. "0.1.0", "1.2.3-rc.1")',
	)
	.meta({
		title: "Version",
		description:
			"Plugin version. Semver 2.0 subset; build-metadata `+...` is disallowed (the atproto record-key alphabet has no `+`). Bumped on every release.",
		examples: ["0.1.0", "1.2.3", "1.0.0-rc.1"],
	});

// ──────────────────────────────────────────────────────────────────────────
// Trust contract (capabilities + allowedHosts + storage)
// ──────────────────────────────────────────────────────────────────────────

/**
 * The set of currently-valid (non-deprecated) capability names.
 *
 * Mirrors the `CurrentPluginCapability` union from `@emdash-cms/plugin-types`.
 * TS unions don't survive erasure into a runtime Set, so we maintain the
 * list here and the schema's tests catch drift against the type definition.
 */
const CURRENT_CAPABILITIES = new Set<string>([
	"network:request",
	"network:request:unrestricted",
	"content:read",
	"content:write",
	"media:read",
	"media:write",
	"users:read",
	"email:send",
	"hooks.email-transport:register",
	"hooks.email-events:register",
	"hooks.page-fragments:register",
]);

/**
 * A single capability declaration. Plain string, validated for membership
 * in the current vocabulary AND for being non-deprecated. Deprecated names
 * are hard-rejected with a hint pointing at the replacement — the deprecation
 * window is for already-published plugins, not for new authoring.
 *
 * Uses a single `superRefine` so we can produce an issue-specific message
 * that names the offending capability string. The shape mirrors Zod 4's
 * recommended pattern for "value-dependent error messages".
 */
export const CapabilitySchema = z
	.string()
	.min(1, "capability must be a non-empty string")
	.superRefine((cap, ctx) => {
		if (isDeprecatedCapability(cap)) {
			const replacement = CAPABILITY_RENAMES[cap];
			ctx.addIssue({
				code: "custom",
				message: `capability "${cap}" is deprecated. Use "${replacement}" instead.`,
			});
			return;
		}
		const normalised = normalizeCapability(cap);
		if (!CURRENT_CAPABILITIES.has(normalised)) {
			ctx.addIssue({
				code: "custom",
				message: `capability "${cap}" is not a recognised name. See the docs for the available capabilities.`,
			});
		}
	});

/**
 * Capabilities array. The plugin's declared trust contract. Empty array
 * (or omitted field, defaulting to empty) means the plugin asks for no
 * privileges beyond the built-in surface (logging, kv, routes/hooks
 * registration).
 *
 * Cross-field rule (in `ManifestSchema`'s `.refine()`): if `capabilities`
 * includes `network:request` (and NOT `network:request:unrestricted`),
 * then `allowedHosts` must be a non-empty array. This matches the
 * `releaseExtension` lexicon's `networkRequestConstraints.allowedHosts`
 * "absent OR non-empty" rule.
 */
export const CapabilitiesSchema = z
	.array(CapabilitySchema)
	.max(32, "capabilities[] must have <= 32 entries")
	.meta({
		title: "Capabilities",
		description:
			"Trust contract: what runtime APIs the plugin is allowed to use. Changing this between releases requires a version bump because installed users have consented to the old contract.",
	});

/**
 * Slash or whitespace in a hostname pattern is a sign the user pasted a
 * URL or path instead of a bare host. Hoisted out of `.refine()` so the
 * regex is compiled once.
 */
const HOST_PATTERN_INVALID_CHARS = /[/\s]/;

/**
 * Allowed-hosts list for `network:request`. Each entry is a hostname
 * pattern with no scheme/path/whitespace; a leading `*.` permits
 * subdomains. (Ports are accepted by this loose check; the publish-time
 * lexicon validator is the strict authority on the exact grammar.)
 */
export const AllowedHostsSchema = z
	.array(
		z
			.string()
			.min(1, "host pattern must be non-empty")
			.max(256, "host pattern must be <= 256 characters")
			.refine(
				(h) => !HOST_PATTERN_INVALID_CHARS.test(h) && !h.includes("://"),
				'host pattern must be a hostname only (no scheme, path, or whitespace; "*." for subdomain wildcard is allowed)',
			),
	)
	.max(64, "allowedHosts[] must have <= 64 entries")
	.meta({
		title: "Allowed hosts",
		description:
			"Allow-list of outbound host patterns when `network:request` is declared. Subdomain wildcards use a leading `*.`. Required (non-empty) when `network:request` is declared without `network:request:unrestricted`.",
		examples: [["api.example.com", "*.cdn.example.com"]],
	});

/**
 * Storage collection config. Mirrors `StorageCollectionConfig` from
 * `@emdash-cms/plugin-types`. Indexes are field names (or composite
 * arrays). Unique indexes are queryable too — don't duplicate them in
 * `indexes`.
 */
export const StorageCollectionSchema = z
	.object({
		indexes: z.array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)])),
		uniqueIndexes: z
			.array(z.union([z.string().min(1), z.array(z.string().min(1)).min(1)]))
			.optional(),
	})
	.strict()
	.meta({
		title: "Storage collection",
		description:
			"Index configuration for a single storage collection. Indexes are either single field names or composite (array of field names).",
	});

/**
 * Storage declaration. Map of collection name to its index config.
 * Collection names follow the same slug-like rules as plugin slugs:
 * lowercase letters, digits, hyphens, underscores. The runtime uses the
 * collection name verbatim as the SQL table-suffix, so the grammar must
 * be safe.
 */
export const StorageSchema = z
	.record(
		z
			.string()
			.min(1, "storage collection name must be non-empty")
			.regex(
				/^[a-z][a-z0-9_]*$/,
				'storage collection name must start with a lowercase letter, then lowercase letters / digits / "_"',
			),
		StorageCollectionSchema,
	)
	.meta({
		title: "Storage",
		description:
			"Storage collections the plugin uses. Each collection is namespaced to this plugin at runtime.",
	});

// ──────────────────────────────────────────────────────────────────────────
// Admin surface (pages + dashboard widgets)
// ──────────────────────────────────────────────────────────────────────────

/**
 * An admin page declaration. Sandboxed plugins render admin pages
 * through Block Kit via their `admin` route handler — the manifest
 * just declares where the page lives in the navigation, what it's
 * called, and what icon goes next to it.
 *
 * Path is restricted to a leading slash + URL-safe characters so the
 * admin router has a sensible space of values to dispatch on.
 */
export const AdminPageSchema = z
	.object({
		path: z
			.string()
			.min(2, "admin page path must be at least 2 characters (leading slash + name)")
			.max(128, "admin page path must be <= 128 characters")
			.regex(
				/^\/[a-z0-9][a-z0-9/_-]*$/i,
				'admin page path must start with "/" and contain only letters, digits, "-", "_", "/"',
			),
		label: z
			.string()
			.min(1, "admin page label cannot be empty")
			.max(128, "admin page label must be <= 128 characters"),
		icon: z.string().min(1).max(64).optional(),
	})
	.strict()
	.meta({
		title: "Admin page",
		description:
			"A single admin page declaration. The plugin's `admin` route handler is responsible for rendering Block Kit content for this path.",
	});

/**
 * A dashboard widget declaration. Same surface contract as admin
 * pages — the plugin's `admin` route handler renders the widget's
 * Block Kit content, scoped by widget id.
 */
export const AdminWidgetSchema = z
	.object({
		id: z
			.string()
			.min(1, "admin widget id cannot be empty")
			.max(64, "admin widget id must be <= 64 characters")
			.regex(
				/^[a-z][a-z0-9_-]*$/,
				'admin widget id must start with a lowercase letter, then lowercase letters / digits / "-" / "_"',
			),
		title: z.string().min(1).max(128).optional(),
		size: z.enum(["full", "half", "third"]).optional(),
	})
	.strict()
	.meta({
		title: "Admin widget",
		description: "A single dashboard widget declaration.",
	});

/**
 * Admin surface block in the manifest. Both fields are optional;
 * plugins that don't expose admin UI at all simply omit the `admin`
 * key entirely.
 */
export const AdminSchema = z
	.object({
		pages: z.array(AdminPageSchema).max(32, "admin.pages[] must have <= 32 entries").optional(),
		widgets: z
			.array(AdminWidgetSchema)
			.max(32, "admin.widgets[] must have <= 32 entries")
			.optional(),
	})
	.strict()
	.meta({
		title: "Admin surface",
		description:
			"Pages and widgets the plugin exposes in the admin UI. The plugin's `admin` route handler renders Block Kit content for each path / widget id at runtime.",
	});

// ──────────────────────────────────────────────────────────────────────────
// Long-form profile sections (description / installation / faq / changelog /
// security)
// ──────────────────────────────────────────────────────────────────────────

/** Per-section size caps, mirroring `profile.json#sections`. */
export const SECTION_MAX_BYTES = 20000;
export const SECTION_MAX_GRAPHEMES = 2000;

/** The five FAIR-recognised section keys the lexicon enumerates. */
export const SECTION_KEYS = [
	"description",
	"installation",
	"faq",
	"changelog",
	"security",
] as const;

export type SectionKey = (typeof SECTION_KEYS)[number];

const sectionGraphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

/** Grapheme count via `Intl.Segmenter` — the codebase's grapheme-aware measure. */
export function countGraphemes(value: string): number {
	let count = 0;
	for (const _ of sectionGraphemeSegmenter.segment(value)) count++;
	return count;
}

/**
 * Enforce the per-section size caps on a resolved markdown string. Returns
 * an error message when over a cap, or `null` when within both. Shared by the
 * inline-string schema check and the load-time file-ref check so an inline
 * section and a `{ file }` section fail with the same message.
 */
export function sectionCapError(value: string): string | null {
	const bytes = Buffer.byteLength(value, "utf8");
	if (bytes > SECTION_MAX_BYTES) {
		return `content is ${bytes} bytes, exceeding the ${SECTION_MAX_BYTES}-byte cap`;
	}
	const graphemes = countGraphemes(value);
	if (graphemes > SECTION_MAX_GRAPHEMES) {
		return `content is ${graphemes} graphemes, exceeding the ${SECTION_MAX_GRAPHEMES}-grapheme cap`;
	}
	return null;
}

/**
 * A single section file reference. The `file` path is resolved relative to the
 * manifest at LOAD time; the CLI reads the file's content directly into the
 * section string (sections are inlined into the profile record, unlike media
 * artifacts whose bytes are uploaded). Only the authoring input lives here.
 */
export const SectionFileSchema = z
	.object({
		file: z
			.string()
			.min(1, "section `file` path cannot be empty")
			.max(1024, "section `file` path must be <= 1024 characters")
			.meta({
				description:
					"Path to a CommonMark Markdown file, relative to the manifest. Its content is read inline into the section at publish time.",
			}),
	})
	.strict()
	.meta({
		title: "Section file reference",
		description:
			"Loads the section's Markdown from a sibling file instead of inlining it in the manifest.",
	});

/**
 * A single section value: either an inline CommonMark string or a `{ file }`
 * reference. Inline strings are capped here (20000 bytes / 2000 graphemes); a
 * file ref's content is capped at load time once the file is read, because the
 * bytes aren't known until then.
 */
export const SectionValueSchema = z
	.union([
		z
			.string()
			.superRefine((value, ctx) => {
				const error = sectionCapError(value);
				if (error) ctx.addIssue({ code: "custom", message: error });
			})
			.meta({
				description:
					"Inline CommonMark Markdown for this section. Capped at 20000 bytes / 2000 graphemes.",
			}),
		SectionFileSchema,
	])
	.meta({
		title: "Section value",
		description:
			"Either inline CommonMark Markdown or a `{ file }` reference to a sibling Markdown file.",
	});

/**
 * Long-form profile sections. Profile-level (not per-release): the same map of
 * human-readable Markdown carries across every release of a package. Keys are
 * the five FAIR-recognised section names; `.strict()` rejects any other key so
 * a typo (`instalation`) fails locally rather than producing an unrecognised
 * section in the published profile.
 */
export const SectionsSchema = z
	.object({
		description: SectionValueSchema.optional(),
		installation: SectionValueSchema.optional(),
		faq: SectionValueSchema.optional(),
		changelog: SectionValueSchema.optional(),
		security: SectionValueSchema.optional(),
	})
	.strict()
	.meta({
		title: "Profile sections",
		description:
			"Long-form package documentation (description / installation / faq / changelog / security). Each value is CommonMark Markdown (inline or a `{ file }` ref) capped at 20000 bytes / 2000 graphemes. Rendered on the package's registry page.",
	});

// ──────────────────────────────────────────────────────────────────────────
// Media artifacts (icon / screenshot / banner)
// ──────────────────────────────────────────────────────────────────────────

/**
 * BCP 47 language tag for a localised artifact. Mirrors `release.json#artifact.lang`.
 * Structural check only — the registry aggregator owns the strict grammar.
 */
const ArtifactLangSchema = z
	.string()
	.min(2, 'lang must be a BCP 47 language tag (e.g. "en", "pt-BR")')
	.max(64, "lang must be <= 64 characters")
	.meta({
		description: 'BCP 47 language tag for a localised artifact (e.g. "en", "pt-BR").',
		examples: ["en", "pt-BR"],
	});

/**
 * A single media-artifact file reference. The `file` path is resolved relative
 * to the manifest at publish time; the CLI reads the bytes, computes the
 * checksum and pixel dimensions, uploads them to the publisher's artifact
 * hosting, and writes a `#artifact` record (url, checksum, contentType, width,
 * height, lang?) into the release. Only the authoring inputs live here — the
 * derived fields never appear in the manifest.
 */
export const ArtifactFileSchema = z
	.object({
		file: z
			.string()
			.min(1, "artifact `file` path cannot be empty")
			.max(1024, "artifact `file` path must be <= 1024 characters")
			.meta({
				description:
					"Path to the image file, relative to the manifest. Resolved, hashed, measured, and uploaded at publish time.",
			}),
		lang: ArtifactLangSchema.optional(),
	})
	.strict()
	.meta({
		title: "Artifact file reference",
		description:
			"A media file (PNG / JPEG / WebP / GIF / AVIF) bundled into a release as an icon, screenshot, or banner.",
	});

/**
 * Release media artifacts. `icon` and `banner` are single files; `screenshots`
 * is an array (a plugin can ship a gallery). Mirrors `release.json#artifacts`
 * minus the `package` entry, which the CLI derives from the tarball.
 */
export const ArtifactsSchema = z
	.object({
		icon: ArtifactFileSchema.optional(),
		banner: ArtifactFileSchema.optional(),
		screenshots: z
			.array(ArtifactFileSchema)
			.min(1, "screenshots[] must have at least one entry when set")
			.max(8, "screenshots[] must have <= 8 entries")
			.meta({
				title: "Screenshots",
				description: "Screenshot gallery for the plugin's detail page (<= 8 entries).",
			})
			.optional(),
	})
	.strict()
	.meta({
		title: "Artifacts",
		description:
			"Release media artifacts. `icon` and `banner` are single images; `screenshots` is a gallery array.",
	});

/**
 * Release-level block. Holds fields scoped to a single version rather than the
 * package profile. Today that's media `artifacts`; the source `repo` stays at
 * the top level for backwards compatibility.
 */
export const ReleaseSchema = z
	.object({
		requires: RequiresSchema.optional(),
		artifacts: ArtifactsSchema.optional(),
	})
	.strict()
	.meta({
		title: "Release",
		description:
			"Per-release fields: environment constraints (`requires`) and media artifacts (icon / screenshot / banner).",
	});

// ──────────────────────────────────────────────────────────────────────────
// Top-level manifest
// ──────────────────────────────────────────────────────────────────────────

/**
 * The full v1 manifest. Unknown keys are rejected by `.strict()` so a
 * typo'd field name produces an immediate error rather than passing
 * through silently. The cost is that every later issue (#1029, #1030, ...)
 * has to extend this schema, which is intentional: the manifest is a
 * contract with users and we want changes to be deliberate.
 *
 * `$schema` is allowed because editors write it automatically for IDE
 * completion. It is stripped before validation passes the value to the
 * publish translation.
 */
export const ManifestSchema = z
	.object({
		// `$schema` is for editor IDE support and the JSON Schema tooling
		// chain. It carries no semantic meaning to publish; the loader
		// strips it before handing the value off.
		$schema: z
			.string()
			.meta({
				description:
					"Path or URL to the JSON Schema describing this file. Editors use this for completion and validation.",
			})
			.optional(),

		// Identity. Slug + publisher together form the package's identity;
		// the AT URI is derived at runtime, never authored.
		slug: SlugSchema,
		// Version is optional in the source manifest. `package.json#version`
		// is the canonical source for npm-distributed plugins (Changesets
		// bumps it on release), so duplicating it here causes drift. Two
		// authoring shapes are valid:
		//   - Omit `version` in the manifest, keep it only in `package.json`.
		//   - Set it in both, in which case the build step enforces they
		//     match and errors loudly on mismatch.
		// Registry-only plugins (no `package.json`) must set `version` here
		// — there's nowhere else for it to live.
		version: VersionSchema.optional(),

		// Required on first publish, ignored on subsequent publishes (the
		// existing profile wins). Same precedence rules as today's
		// --license flag.
		license: LicenseSchema,

		// Publisher pin. Required for the plugin to load — the runtime
		// can't compute the AT URI without it. Authors fill it in before
		// first run; on first publish, if the value matches the session,
		// it stays. If a publisher migrates the manifest's `publisher`
		// must be updated explicitly.
		publisher: PublisherSchema,

		// Trust contract. Static for a given version; changes require
		// a version bump because installed users have consented to the
		// old contract. Default-empty so the minimal manifest doesn't
		// need to spell out the absence of privileges.
		capabilities: CapabilitiesSchema.default([]),
		allowedHosts: AllowedHostsSchema.default([]),
		storage: StorageSchema.default({}),

		// Admin surface. Optional; plugins that don't expose any admin
		// UI omit the key entirely. The runtime checks that any plugin
		// declaring admin.pages or admin.widgets also serves an `admin`
		// route — the schema can't enforce that here because route
		// names are probed from src/plugin.ts, not the manifest.
		admin: AdminSchema.optional(),

		// Single-author form. Mutually exclusive with `authors`.
		author: AuthorSchema.optional(),
		// Multi-author form. Mutually exclusive with `author`. At least one
		// entry is required when this field is used.
		authors: z
			.array(AuthorSchema)
			.min(1, "authors[] must have at least one entry")
			.max(32, "authors[] must have <= 32 entries (lexicon constraint)")
			.meta({
				title: "Authors (multiple)",
				description:
					"Multi-author form. Mutually exclusive with `author`. Use the singular `author` if there is only one.",
			})
			.optional(),

		// Single-contact form. Mutually exclusive with `securityContacts`.
		security: SecurityContactSchema.optional(),
		// Multi-contact form. Mutually exclusive with `security`.
		securityContacts: z
			.array(SecurityContactSchema)
			.min(1, "securityContacts[] must have at least one entry")
			.max(8, "securityContacts[] must have <= 8 entries (lexicon constraint)")
			.meta({
				title: "Security contacts (multiple)",
				description:
					"Multi-contact form. Mutually exclusive with `security`. Use the singular `security` if there is only one.",
			})
			.optional(),

		// Optional profile fields.
		name: NameSchema.optional(),
		description: DescriptionSchema.optional(),
		keywords: KeywordsSchema.optional(),

		// Long-form profile sections (description / installation / faq /
		// changelog / security). Profile-level, like the fields above. File
		// refs are read inline at load time relative to the manifest.
		sections: SectionsSchema.optional(),

		// Optional release fields.
		repo: RepoSchema.optional(),

		// Per-release block: environment constraints (`requires`) and media
		// artifacts (icon / screenshot / banner). File refs are resolved
		// relative to the manifest at publish time.
		release: ReleaseSchema.optional(),
	})
	.strict()
	.refine((v) => !(v.author !== undefined && v.authors !== undefined), {
		message:
			"manifest has both `author` and `authors`. Use one form: `author: { ... }` for a single author, or `authors: [...]` for multiple.",
		path: ["authors"],
	})
	.refine((v) => !(v.security !== undefined && v.securityContacts !== undefined), {
		message:
			"manifest has both `security` and `securityContacts`. Use one form: `security: { ... }` for a single contact, or `securityContacts: [...]` for multiple.",
		path: ["securityContacts"],
	})
	.refine((v) => v.author !== undefined || v.authors !== undefined, {
		message: "manifest must specify either `author: { ... }` or `authors: [...]`",
		path: ["author"],
	})
	.refine((v) => v.security !== undefined || v.securityContacts !== undefined, {
		message: "manifest must specify either `security: { ... }` or `securityContacts: [...]`",
		path: ["security"],
	})
	.refine(
		(v) => {
			// network:request without :unrestricted requires a non-empty
			// allowedHosts. Without this guard, the lexicon's
			// networkRequestConstraints rule fires at publish time and
			// users see a confusing PDS error rather than a schema error.
			const caps = new Set((v.capabilities ?? []).map((c) => normalizeCapability(c)));
			if (caps.has("network:request") && !caps.has("network:request:unrestricted")) {
				return (v.allowedHosts ?? []).length > 0;
			}
			return true;
		},
		{
			message:
				'capability "network:request" requires a non-empty `allowedHosts` list. Either add hosts, or upgrade to "network:request:unrestricted" if the plugin really needs to call any host.',
			path: ["allowedHosts"],
		},
	)
	.refine(
		(v) => {
			// network:request:unrestricted with allowedHosts is contradictory
			// — the unrestricted capability says "any host", but the list
			// implies "only these". The lexicon's rule is "allowedHosts
			// MUST NOT appear when unrestricted"; same here.
			const caps = new Set((v.capabilities ?? []).map((c) => normalizeCapability(c)));
			if (caps.has("network:request:unrestricted")) {
				return (v.allowedHosts ?? []).length === 0;
			}
			return true;
		},
		{
			message:
				'`allowedHosts` must be empty when "network:request:unrestricted" is declared (the unrestricted capability already grants any host).',
			path: ["allowedHosts"],
		},
	)
	.meta({
		title: "EmDash plugin manifest",
		description:
			"Hand-authored manifest for publishing a plugin to the EmDash plugin registry. Lives next to the plugin's `package.json` as `emdash-plugin.jsonc`.",
	});

/**
 * Validated manifest shape. Note: this is the SHAPE AFTER the schema's
 * `.refine()` rules have run, not the on-disk shape. The single-form
 * convenience fields (`author`, `security`) are still present at this
 * stage; normalisation to the array forms happens in `./translate.ts`.
 */
export type Manifest = z.infer<typeof ManifestSchema>;

/** A single author entry, normalised. */
export type ManifestAuthor = z.infer<typeof AuthorSchema>;

/** A single security contact entry, normalised. */
export type ManifestSecurityContact = z.infer<typeof SecurityContactSchema>;

/** A single media-artifact file reference (icon / screenshot / banner). */
export type ManifestArtifactFile = z.infer<typeof ArtifactFileSchema>;

/** A single section file reference (`{ file }`). */
export type ManifestSectionFile = z.infer<typeof SectionFileSchema>;

/** The long-form sections block, as authored (inline strings or file refs). */
export type ManifestSections = z.infer<typeof SectionsSchema>;

/** The release media-artifacts block. */
export type ManifestArtifacts = z.infer<typeof ArtifactsSchema>;
