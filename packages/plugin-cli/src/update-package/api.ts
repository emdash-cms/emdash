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
 * `authors`, `security`, `name`, `description`, `keywords`. Identity fields
 * (`$type`, `id`, `slug`, `type`) are preserved verbatim from the existing
 * record. `lastUpdated` is auto-set to now whenever there are changes to
 * apply. Unknown fields (e.g. `sections` from a future lexicon revision)
 * pass through unchanged so a CLI from an older revision doesn't silently
 * drop forward-compatible data on a write-back.
 *
 * Failure modes:
 *
 *   - `PACKAGE_NOT_FOUND`: no package record exists at the manifest's slug.
 *     The user must run `publish` first to bootstrap.
 *   - `PACKAGE_INVALID`: the existing record doesn't validate against the
 *     package profile lexicon. We refuse to write rather than overwrite an
 *     unknown shape with our canonical one.
 *   - `SLUG_MISMATCH`: defensive guard against the existing record's `slug`
 *     field differing from the manifest's slug. Aggregators reject records
 *     where slug doesn't match the rkey, but if a publisher hand-edited the
 *     record we want a clear refusal before we make it worse.
 *   - `POSSIBLE_RENAME`: no record at the manifest's slug, but the publisher
 *     already has a package at a different slug. Refused so a manifest
 *     rename doesn't orphan releases under the old slug.
 *   - `INVALID_INPUT`: programmatic-caller input fails the lexicon's
 *     structural rules (e.g. empty `authors`).
 */

import { ClientResponseError } from "@atcute/client";
import { safeParse } from "@atcute/lexicons/validations";
import type { Did, PublishingClient } from "@emdash-cms/registry-client";
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
	/** Authenticated client against the publisher's PDS. */
	publisher: PublishingClient;
	/** Publisher DID. Used to construct AT URIs for display/output. */
	did: Did;
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
	const profileUri = `at://${options.did}/${NSID.packageProfile}/${options.slug}`;

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
		// profile at a different slug; running `publish` would create a
		// second profile and orphan every release under the old slug).
		const sibling = await findSiblingProfileSlug(options.publisher, options.slug);
		if (sibling !== null) {
			throw new UpdatePackageError(
				"POSSIBLE_RENAME",
				`No profile at ${profileUri}, but the publisher already has a profile at slug "${sibling}". If you renamed the plugin in your manifest, that would orphan every release under "${sibling}" — revert the slug to "${sibling}" in emdash-plugin.jsonc, or publish the rename under the new slug as a fresh package (releases under "${sibling}" stay where they are).`,
				{ slug: options.slug, existingSlug: sibling, did: options.did },
			);
		}
		throw new UpdatePackageError(
			"PACKAGE_NOT_FOUND",
			`No profile record at ${profileUri}. Run \`emdash-plugin publish\` to create one before editing.`,
			{ slug: options.slug, did: options.did },
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
	// `validateInput` already gates the obvious caller-side mistakes, so a
	// failure here genuinely indicates a record-shape regression in
	// update-package or in the lexicon itself.
	const candidateValidation = safeParse(PackageProfile.mainSchema, candidate);
	if (!candidateValidation.ok) {
		throw new UpdatePackageError(
			"LEXICON_VALIDATION_FAILED",
			`Candidate profile record did not match the lexicon after merge.`,
			{ slug: options.slug, issues: candidateValidation },
		);
	}

	const put = await options.publisher.unsafePutRecord({
		collection: NSID.packageProfile,
		rkey: options.slug,
		record: candidate,
		skipValidation: true,
	});

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
 * Build the candidate profile record body and diff it against the
 * existing record. Identity fields (`$type`, `id`, `slug`, `type`) and
 * any unknown fields on the existing record are carried over verbatim.
 * Editable fields are taken from `input`. `lastUpdated` is set to `now`
 * iff there are diffs; an unchanged record keeps the existing timestamp
 * so a no-op update doesn't churn the aggregator's lastUpdated ordering.
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
			// User cleared the field. Drop it from the candidate if it was
			// present before.
			if (before !== undefined) {
				delete candidate[field];
				diffs.push({ field, before, after: undefined });
			}
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
 * Drops `keywords` when empty so "no keywords" maps to "field absent" the
 * way the lexicon stores it. `authors` and `security` arrays are passed
 * through verbatim — `validateInput` already rejected empty arrays.
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

/**
 * When no profile is found at the requested slug, scan the publisher's
 * packageProfile collection for any other profile so we can warn that a
 * manifest rename would orphan it. Returns the first sibling slug found,
 * or `null` when the collection is empty.
 *
 * The scan caps at one page (the OAuth permission, not the publisher's
 * profile count, is the natural limit here): a publisher with hundreds of
 * plugins is theoretically possible, but the diagnostic only needs ONE
 * example to make its point.
 */
async function findSiblingProfileSlug(
	publisher: PublishingClient,
	missingSlug: string,
): Promise<string | null> {
	try {
		const page = await publisher.listRecords({ collection: NSID.packageProfile, limit: 100 });
		for (const record of page.records) {
			const rkey = atUriRkey(record.uri);
			if (rkey && rkey !== missingSlug) return rkey;
		}
		return null;
	} catch {
		// Best-effort diagnostic: fall through to the plain PACKAGE_NOT_FOUND
		// if the listRecords call fails (network, permission). The bug we're
		// trying to catch is a publisher renaming their plugin; a real
		// publisher with that situation will still get the message on retry.
		return null;
	}
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
