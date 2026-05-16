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

		// Required on first publish, ignored on subsequent publishes (the
		// existing profile wins). Same precedence rules as today's
		// --license flag.
		license: LicenseSchema,

		// Optional publisher pin. Omitted on first publish, the CLI
		// writes the active session's DID back here automatically.
		publisher: PublisherSchema.optional(),

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

		// Optional release fields.
		repo: RepoSchema.optional(),
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
