/**
 * Programmatic package-update API.
 *
 * Reads the publisher's existing `com.emdashcms.experimental.package.profile`
 * record (the per-package metadata record in the registry lexicon — distinct
 * from the publisher's atproto profile at `app.bsky.actor.profile`), diffs
 * the lexicon-controlled fields against a manifest-derived candidate, and
 * (when applied) writes the new record via `com.atproto.repo.putRecord`.
 *
 * Splits cleanly from the CLI command so tests can run it against a mock
 * `PublishingClient` without going through OAuth or the filesystem.
 *
 * Scope
 * -----
 *
 * Only fields the manifest controls are eligible for update: `license`,
 * `authors`, `security`, `name`, `description`, `keywords`. Required fields
 * are diffed and written; optional fields (`name`, `description`,
 * `keywords`) follow a "manifest absent = no change" policy so removing a
 * manifest key doesn't silently wipe a published value. Identity fields
 * (`$type`, `id`, `slug`, `type`) are preserved verbatim. `lastUpdated` is
 * auto-set to now whenever there are changes to apply. Unknown fields
 * (e.g. `sections` from a future lexicon revision) pass through unchanged
 * so a CLI from an older revision doesn't silently drop forward-compatible
 * data on a write-back.
 *
 * Concurrency: the read-then-write uses atproto's `swapRecord` CID-based
 * CAS precondition. Concurrent writes between read and write surface as
 * `STALE_RECORD` rather than silently overwriting the other writer.
 *
 * Failure modes:
 *
 *   - `PACKAGE_NOT_FOUND`: no package record exists at the manifest's slug
 *     and the publisher has no other packages either. The user must run
 *     `publish` first to bootstrap.
 *   - `POSSIBLE_RENAME`: no record at the manifest's slug, but the publisher
 *     already has one or more packages at other slugs. Refused so a manifest
 *     rename doesn't orphan releases under the old slug.
 *   - `PACKAGE_INVALID`: the existing record doesn't validate against the
 *     package profile lexicon. We refuse to write rather than overwrite an
 *     unknown shape with our canonical one.
 *   - `SLUG_MISMATCH`: defensive guard against the existing record's `slug`
 *     field differing from the manifest's slug. Aggregators reject records
 *     where slug doesn't match the rkey, but if a publisher hand-edited the
 *     record we want a clear refusal before we make it worse.
 *   - `INVALID_INPUT`: caller input fails the structural checks
 *     `validateInput` enforces (empty arrays, missing contact details).
 *   - `STALE_RECORD`: the record was modified between our read and write.
 *     The caller should re-run to recompute the diff against latest state.
 *   - `LEXICON_VALIDATION_FAILED`: the merged candidate failed the lexicon
 *     check (usually because the caller exceeded a length/grapheme cap not
 *     covered by `validateInput`).
 */

import { ClientResponseError } from "@atcute/client";
import { safeParse } from "@atcute/lexicons/validations";
import type { PublishingClient } from "@emdash-cms/registry-client";
import { NSID, PackageProfile } from "@emdash-cms/registry-lexicons";

// ──────────────────────────────────────────────────────────────────────────
// Public types
// ──────────────────────────────────────────────────────────────────────────

export type UpdatePackageErrorCode =
	| "PACKAGE_NOT_FOUND"
	| "PACKAGE_INVALID"
	| "SLUG_MISMATCH"
	| "POSSIBLE_RENAME"
	| "INVALID_INPUT"
	| "STALE_RECORD"
	| "LEXICON_VALIDATION_FAILED";

export class UpdatePackageError extends Error {
	override readonly name = "UpdatePackageError";
	readonly code: UpdatePackageErrorCode;
	readonly detail: Record<string, unknown> | undefined;

	constructor(code: UpdatePackageErrorCode, message: string, detail?: Record<string, unknown>) {
		super(message);
		this.code = code;
		this.detail = detail;
	}
}

/**
 * Package metadata fields the manifest controls. Mirrors the subset of
 * `ProfileInput` (from `../publish/api.js`) that update-package actually
 * touches. We don't re-import `ProfileInput` directly because that type
 * also covers first-publish-only fields and the contract here is "fields
 * the manifest can edit after publish".
 */
export interface PackageUpdateInput {
	license: string;
	authors: Array<{ name: string; url?: string; email?: string }>;
	security: Array<{ url?: string; email?: string }>;
	name?: string;
	description?: string;
	keywords?: string[];
}

/**
 * One field's worth of diff information. `before` and `after` are the
 * field's raw JSON values (or `undefined` if the field is absent on that
 * side). Used for both human display and dry-run JSON output.
 */
export interface PackageFieldDiff {
	field: keyof PackageUpdateInput;
	before: unknown;
	after: unknown;
}

export interface UpdatePackageOptions {
	/**
	 * Authenticated client against the publisher's PDS. The publisher DID
	 * (used to construct AT URIs for display/output) is read from
	 * `publisher.did`; we don't accept it as a separate field to avoid the
	 * disagree-with-publisher footgun.
	 */
	publisher: PublishingClient;
	/** The plugin's slug (rkey of the profile record). */
	slug: string;
	/** Manifest-derived fields the user wants to apply. */
	input: PackageUpdateInput;
	/**
	 * When `false` (the default), compute the diff but DO NOT write. When
	 * `true`, apply the diff via `putRecord` and bump `lastUpdated`.
	 */
	apply?: boolean;
	/**
	 * Override the current time used for `lastUpdated`. Defaults to
	 * `new Date()`. Exposed for tests.
	 */
	now?: () => Date;
}

export interface UpdatePackageResult {
	/** AT URI of the profile record. */
	profileUri: string;
	/** Per-field diffs. Empty when the manifest matches the existing record. */
	diffs: PackageFieldDiff[];
	/**
	 * The candidate record body that would be (or was) written. Only the
	 * publisher-editable fields here are sourced from the manifest; identity
	 * and unknown fields are carried over from the existing record.
	 */
	candidate: Record<string, unknown>;
	/**
	 * True when `apply: true` was passed AND there were diffs. False on dry
	 * runs and on no-op applies. Use in CLI output to decide between
	 * "would update" vs "updated".
	 */
	written: boolean;
	/** CID of the written record. Only populated when `written` is true. */
	cid?: string;
}

// ──────────────────────────────────────────────────────────────────────────
// Implementation
// ──────────────────────────────────────────────────────────────────────────

/**
 * Order in which fields are presented in diffs. Keeps human output stable
 * across runs and matches the lexicon's reading order (identity → contacts
 * → display).
 */
const FIELD_ORDER: ReadonlyArray<keyof PackageUpdateInput> = [
	"license",
	"name",
	"description",
	"keywords",
	"authors",
	"security",
];

export async function updatePackage(options: UpdatePackageOptions): Promise<UpdatePackageResult> {
	const did = options.publisher.did;
	const profileUri = `at://${did}/${NSID.packageProfile}/${options.slug}`;

	// Validate the caller's input against the lexicon's structural rules
	// before any network access. The CLI's manifest schema is the primary
	// enforcement layer, but the api is exported and programmatic callers
	// can submit empty arrays (which the lexicon rejects). Surfacing
	// `INVALID_INPUT` here gives them a useful message instead of a later
	// `LEXICON_VALIDATION_FAILED` whose default text blames update-package.
	const inputError = validateInput(options.input);
	if (inputError) {
		throw new UpdatePackageError("INVALID_INPUT", inputError, { slug: options.slug });
	}

	const existing = await fetchExistingProfile(options.publisher, options.slug);
	if (existing === null) {
		// Distinguish a fresh slug (publisher should run `publish` to
		// bootstrap) from a likely rename (the publisher already has a
		// package at a different slug; running `publish` would create a
		// second package and orphan every release under the old slug).
		// We list every sibling rather than singling one out — a publisher
		// with several plugins shouldn't see a misleading "you might have
		// renamed plugin X" pointer at an unrelated package.
		const siblings = await findSiblingPackageSlugs(options.publisher, options.slug);
		if (siblings.length > 0) {
			const list = siblings.map((s) => `"${s}"`).join(", ");
			throw new UpdatePackageError(
				"POSSIBLE_RENAME",
				`No package at ${profileUri}. The publisher already has package(s) at: ${list}. If you renamed the plugin in your manifest, publishing under the new slug would orphan every release under the old one — revert the slug in emdash-plugin.jsonc, or accept that a rename starts a fresh package and the old releases stay where they are.`,
				{ slug: options.slug, existingSlugs: siblings, did },
			);
		}
		throw new UpdatePackageError(
			"PACKAGE_NOT_FOUND",
			`No package record at ${profileUri}. Run \`emdash-plugin publish\` to create one before editing.`,
			{ slug: options.slug, did },
		);
	}

	const existingValue = existing.value;
	if (!isPlainObject(existingValue)) {
		throw new UpdatePackageError(
			"PACKAGE_INVALID",
			`Existing profile at ${profileUri} is not a JSON object. Refusing to overwrite an unknown shape.`,
			{ slug: options.slug },
		);
	}

	const validation = safeParse(PackageProfile.mainSchema, existingValue);
	if (!validation.ok) {
		throw new UpdatePackageError(
			"PACKAGE_INVALID",
			`Existing profile at ${profileUri} does not match the package profile lexicon. Refusing to overwrite. Fix the record directly via your PDS or contact the EmDash team.`,
			{ slug: options.slug, issues: validation },
		);
	}

	const existingSlug = typeof existingValue.slug === "string" ? existingValue.slug : options.slug;
	if (existingSlug !== options.slug) {
		throw new UpdatePackageError(
			"SLUG_MISMATCH",
			`Existing profile at ${profileUri} has slug "${existingSlug}" but the manifest's slug is "${options.slug}". The slug is the record key and cannot change after publish (it would orphan every release tied to the old slug). To rename a plugin, publish under the new slug as a fresh package.`,
			{ existingSlug, manifestSlug: options.slug },
		);
	}

	const now = (options.now ?? defaultNow)();
	const { candidate, diffs } = buildPackageCandidate({
		existing: existingValue,
		input: options.input,
		now,
	});

	if (options.apply !== true || diffs.length === 0) {
		return {
			profileUri,
			diffs,
			candidate,
			written: false,
		};
	}

	// Local validation before the round-trip. The PDS will reject malformed
	// records via `validate: true`, but it doesn't know the experimental
	// registry lexicon — so we own the validation and skip server-side.
	// `validateInput` covers the empty-arrays / missing-required cases, but
	// the lexicon also caps maxLength / maxGraphemes on most fields; a
	// programmatic caller exceeding those lands here. The error message
	// names both possible causes so the failure isn't auto-attributed to
	// update-package's own bookkeeping.
	const candidateValidation = safeParse(PackageProfile.mainSchema, candidate);
	if (!candidateValidation.ok) {
		throw new UpdatePackageError(
			"LEXICON_VALIDATION_FAILED",
			`Candidate package record did not pass lexicon validation. This is usually caller-supplied input exceeding a lexicon limit (e.g. license max 256 chars, description max 140 graphemes, keywords max 5 entries, author/contact url max 1024 chars). If the input shape is well within those limits, this may indicate a lexicon regression in update-package — please report it. See \`detail.issues\` for the failed checks.`,
			{ slug: options.slug, issues: candidateValidation },
		);
	}

	// swapRecord is atproto's CID-based CAS precondition: the write fails
	// if the record on the PDS no longer matches the bytes we read at the
	// top of this function. Without it, a concurrent edit (another
	// update-package invocation, a manual PDS write) between our read and
	// our write would silently lose its changes. With it, we surface
	// `STALE_RECORD` and the user can re-run.
	let put: { uri: string; cid: string };
	try {
		put = await options.publisher.unsafePutRecord({
			collection: NSID.packageProfile,
			rkey: options.slug,
			record: candidate,
			skipValidation: true,
			swapRecord: existing.cid,
		});
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "InvalidSwap") {
			throw new UpdatePackageError(
				"STALE_RECORD",
				`The package record at ${profileUri} was modified by another writer between read and write. Re-run \`emdash-plugin update-package\` to recompute the diff against the latest state and try again.`,
				{ slug: options.slug, expectedCid: existing.cid },
			);
		}
		throw error;
	}

	return {
		profileUri,
		diffs,
		candidate,
		written: true,
		cid: put.cid,
	};
}

// ──────────────────────────────────────────────────────────────────────────
// Pure helpers (exported for tests)
// ──────────────────────────────────────────────────────────────────────────

/**
 * Build the candidate package record body and diff it against the
 * existing record. Identity fields (`$type`, `id`, `slug`, `type`) and
 * any unknown fields on the existing record are carried over verbatim.
 *
 * Field-update semantics, mirroring `publish` so users get one mental
 * model across both commands:
 *
 *   - Required-in-manifest fields (`license`, `authors`, `security`):
 *     always written from `input`; diffed against existing.
 *   - Optional-in-manifest fields (`name`, `description`, `keywords`):
 *     when the manifest sets them, diff and apply. When the manifest
 *     omits them, the existing value is preserved verbatim — a missing
 *     manifest key is NOT a request to delete. Removing a manifest key
 *     by accident shouldn't wipe a value the publisher put there
 *     deliberately. Clearing a value needs a dedicated mechanism (not
 *     yet implemented).
 *
 * `lastUpdated` is set to `now` iff there are diffs; an unchanged record
 * keeps the existing timestamp so a no-op update doesn't churn the
 * aggregator's lastUpdated ordering.
 */
export function buildPackageCandidate(input: {
	existing: Record<string, unknown>;
	input: PackageUpdateInput;
	now: Date;
}): { candidate: Record<string, unknown>; diffs: PackageFieldDiff[] } {
	const next = normaliseInput(input.input);
	const diffs: PackageFieldDiff[] = [];

	const candidate: Record<string, unknown> = { ...input.existing };

	for (const field of FIELD_ORDER) {
		const before = input.existing[field];
		const after = next[field];
		if (after === undefined) {
			// Manifest didn't supply this field. Preserve the existing
			// value verbatim — see the docstring's "no missing-equals-
			// delete" rule.
			continue;
		}
		if (!deepEqual(before, after)) {
			candidate[field] = after;
			diffs.push({ field, before, after });
		}
	}

	// lastUpdated is auto-managed: bumped only when something changed.
	if (diffs.length > 0) {
		candidate.lastUpdated = input.now.toISOString();
	}

	return { candidate, diffs };
}

/**
 * Normalise the manifest-derived input so the diff sees the same canonical
 * shape we'd write. Strips `undefined` keys from author/contact entries so
 * the structural equality check matches the cleaned PDS form (PDS reads
 * never return `undefined` values, but a programmatic caller's input may).
 * Optional fields (`name`, `description`, `keywords`) only land in the
 * output map when the caller actually supplied them; their absence is a
 * "leave the existing value alone" signal, not a "clear" signal.
 * `authors` and `security` are required and always present.
 */
function normaliseInput(
	input: PackageUpdateInput,
): Partial<Record<keyof PackageUpdateInput, unknown>> {
	const out: Partial<Record<keyof PackageUpdateInput, unknown>> = {};
	out.license = input.license;
	out.authors = input.authors.map((a) =>
		omitUndefined({ name: a.name, url: a.url, email: a.email }),
	);
	out.security = input.security.map((c) => omitUndefined({ url: c.url, email: c.email }));

	if (input.name !== undefined) out.name = input.name;
	if (input.description !== undefined) out.description = input.description;
	if (input.keywords !== undefined && input.keywords.length > 0) out.keywords = input.keywords;

	return out;
}

function omitUndefined<T extends Record<string, unknown>>(value: T): Partial<T> {
	const out: Partial<T> = {};
	for (const [k, v] of Object.entries(value)) {
		if (v !== undefined) (out as Record<string, unknown>)[k] = v;
	}
	return out;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

function defaultNow(): Date {
	return new Date();
}

/**
 * Structural equality for JSON-shaped values. Matches the contract we
 * need for diffing: two values are equal iff their JSON serialisations
 * (with sorted keys) would be byte-identical. Sufficient for the small,
 * statically-typed values we diff here; not a general deep-equal.
 */
function deepEqual(a: unknown, b: unknown): boolean {
	if (a === b) return true;
	if (a === null || b === null) return false;
	if (typeof a !== typeof b) return false;
	if (Array.isArray(a)) {
		if (!Array.isArray(b) || a.length !== b.length) return false;
		for (let i = 0; i < a.length; i++) {
			if (!deepEqual(a[i], b[i])) return false;
		}
		return true;
	}
	if (isPlainObject(a)) {
		if (!isPlainObject(b)) return false;
		const ak = Object.keys(a);
		const bk = Object.keys(b);
		if (ak.length !== bk.length) return false;
		for (const k of ak) {
			if (!Object.hasOwn(b, k)) return false;
			if (!deepEqual(a[k], b[k])) return false;
		}
		return true;
	}
	return false;
}

async function fetchExistingProfile(
	publisher: PublishingClient,
	slug: string,
): Promise<{ uri: string; cid: string; value: unknown } | null> {
	try {
		return await publisher.getRecord({ collection: NSID.packageProfile, rkey: slug });
	} catch (error) {
		if (error instanceof ClientResponseError && error.error === "RecordNotFound") {
			return null;
		}
		throw error;
	}
}

/** Max number of sibling slugs to list in the POSSIBLE_RENAME diagnostic. */
const POSSIBLE_RENAME_MAX_SIBLINGS = 10;

/**
 * When no package is found at the requested slug, scan the publisher's
 * packageProfile collection for any other packages so we can warn that a
 * manifest rename would orphan them. Returns the slugs in document order,
 * capped at {@link POSSIBLE_RENAME_MAX_SIBLINGS}.
 *
 * Auth/permission failures are RE-THROWN so the user sees the real cause
 * (e.g. "re-login") rather than a misleading `PACKAGE_NOT_FOUND` that
 * never actually ran the rename check. Transient network errors are
 * swallowed — the rename diagnostic is best-effort and a retry will hit
 * the same path anyway.
 */
async function findSiblingPackageSlugs(
	publisher: PublishingClient,
	missingSlug: string,
): Promise<string[]> {
	let page: Awaited<ReturnType<PublishingClient["listRecords"]>>;
	try {
		page = await publisher.listRecords({ collection: NSID.packageProfile, limit: 100 });
	} catch (error) {
		if (error instanceof ClientResponseError && isAuthFailure(error.error)) {
			// Surface auth/permission errors so the caller sees the real
			// cause instead of a misleading PACKAGE_NOT_FOUND from the
			// rename-check having silently no-op'd.
			throw error;
		}
		// Transient network / PDS-down / unknown — degrade to "no
		// siblings" and let PACKAGE_NOT_FOUND fire. A retry will hit
		// the same path.
		return [];
	}
	const siblings: string[] = [];
	for (const record of page.records) {
		const rkey = atUriRkey(record.uri);
		if (rkey && rkey !== missingSlug) siblings.push(rkey);
		if (siblings.length >= POSSIBLE_RENAME_MAX_SIBLINGS) break;
	}
	return siblings;
}

/**
 * atproto error codes that indicate the session can't authenticate
 * against the PDS. Surfaced rather than swallowed so failure messages
 * point the user at re-login rather than the wrong diagnostic.
 */
function isAuthFailure(code: string): boolean {
	return (
		code === "AuthenticationRequired" ||
		code === "AuthRequired" ||
		code === "InvalidToken" ||
		code === "ExpiredToken" ||
		code === "AccountTakedown" ||
		code === "Forbidden"
	);
}

/** Extract the rkey from an `at://did/nsid/rkey` URI. Returns null on bad shape. */
function atUriRkey(uri: string): string | null {
	const trailing = uri.split("/").pop();
	return trailing && trailing.length > 0 ? trailing : null;
}

/**
 * Validate caller input against the lexicon's structural rules that the
 * manifest schema also enforces. The CLI never reaches here with invalid
 * input (the manifest schema is the first gate), but the api is exported
 * and programmatic callers can submit arrays that the lexicon rejects.
 * Returning a clear `INVALID_INPUT` is friendlier than letting the failure
 * cascade to `LEXICON_VALIDATION_FAILED` on the candidate.
 *
 * Returns an error message on failure, or `null` when the input is OK.
 */
function validateInput(input: PackageUpdateInput): string | null {
	if (typeof input.license !== "string" || input.license.length === 0) {
		return "license must be a non-empty SPDX expression.";
	}
	if (!Array.isArray(input.authors) || input.authors.length === 0) {
		return "authors must be a non-empty array (lexicon requires at least one author).";
	}
	for (const [i, author] of input.authors.entries()) {
		if (!author || typeof author.name !== "string" || author.name.length === 0) {
			return `authors[${i}].name must be a non-empty string.`;
		}
	}
	if (!Array.isArray(input.security) || input.security.length === 0) {
		return "security must be a non-empty array (lexicon requires at least one security contact).";
	}
	for (const [i, contact] of input.security.entries()) {
		if (!contact || (!contact.url && !contact.email)) {
			return `security[${i}] must have at least one of \`url\` or \`email\`.`;
		}
	}
	return null;
}
