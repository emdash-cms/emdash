/**
 * Row → lexicon-view mappers for the Read API.
 *
 * The `packages` and `releases` tables are normalised projections of the
 * signed records (with the raw CAR bytes also kept verbatim in
 * `record_blob` for the `sync.getRecord` passthrough). The Read API needs
 * to return a JSON shape that mirrors what the publisher signed — for
 * display on the wire, with `cid` carried alongside so clients can re-verify
 * against `sync.getRecord` if they want byte-identical bytes.
 *
 * These mappers are the single source of truth for that round-trip. Adding
 * a new column to the schema means updating both the writer (in
 * `records-consumer.ts`) and the relevant mapper here, in lock-step.
 *
 * Mirrors and labels: the lexicon allows them on both views; v1 always
 * returns empty arrays. Mirror integration ships in Slice 3; label
 * hydration ships in Slice 2. The contract is in place so adding either
 * later doesn't change the response shape.
 */

import { type AggregatorDefs, NSID } from "@emdash-cms/registry-lexicons";

import { isPlainObject, parseSignatureMetadataCid } from "../../utils.js";
import { LABELS_MAX_LENGTH, labelTruncationPriority, type LabelView } from "./label-enforcement.js";

/** Subset of columns from `packages` we read for `packageView`. Selecting
 * exactly these columns keeps the SQL query auditable and cheap. */
export interface PackageRow {
	did: string;
	slug: string;
	type: string;
	name: string | null;
	description: string | null;
	license: string;
	authors: string; // JSON array
	security: string; // JSON array
	keywords: string | null; // JSON array
	sections: string | null; // JSON map
	last_updated: string | null;
	latest_version: string | null;
	signature_metadata: string | null;
	verified_at: string;
	indexed_at: string | null;
}

/** Subset of columns from `publishers` we read for `publisherView`. */
export interface PublisherRow {
	did: string;
	display_name: string;
	description: string | null;
	url: string | null;
	contact: string | null; // JSON array of { kind, url?, email? }
	updated_at: string | null;
	signature_metadata: string | null;
	verified_at: string;
	indexed_at: string | null;
}

/** Subset of columns from `releases` we read for `releaseView`. */
export interface ReleaseRow {
	did: string;
	package: string;
	version: string;
	rkey: string;
	artifacts: string; // JSON
	requires: string | null; // JSON
	suggests: string | null; // JSON
	emdash_extension: string; // JSON of validated releaseExtension contents
	repo_url: string | null;
	signature_metadata: string | null;
	verified_at: string;
	indexed_at: string | null;
}

/** Column list backing `PackageRow`. Single source of truth so a column
 * added to the schema needs writer + reader updates in one grep target. */
const PACKAGE_VIEW_COLUMN_NAMES = [
	"did",
	"slug",
	"type",
	"name",
	"description",
	"license",
	"authors",
	"security",
	"keywords",
	"sections",
	"last_updated",
	"latest_version",
	"signature_metadata",
	"verified_at",
	"indexed_at",
] as const;

/** Column list backing `PublisherRow`. */
const PUBLISHER_VIEW_COLUMN_NAMES = [
	"did",
	"display_name",
	"description",
	"url",
	"contact",
	"updated_at",
	"signature_metadata",
	"verified_at",
	"indexed_at",
] as const;

/** Column list backing `ReleaseRow`. */
const RELEASE_VIEW_COLUMN_NAMES = [
	"did",
	"package",
	"version",
	"rkey",
	"artifacts",
	"requires",
	"suggests",
	"emdash_extension",
	"repo_url",
	"signature_metadata",
	"verified_at",
	"indexed_at",
] as const;

/** SELECT-clause string for `PackageRow`. Pass an alias prefix (with the
 * trailing dot) for use in JOINs: `packageColumns("p.")` →
 * `"p.did, p.slug, ..."`. No prefix is unambiguous when only one table is
 * in scope. */
export function packageColumns(prefix = ""): string {
	return PACKAGE_VIEW_COLUMN_NAMES.map((c) => `${prefix}${c}`).join(", ");
}

/** SELECT-clause string for `ReleaseRow`, optionally prefixed for JOINs. */
export function releaseColumns(prefix = ""): string {
	return RELEASE_VIEW_COLUMN_NAMES.map((c) => `${prefix}${c}`).join(", ");
}

/** SELECT-clause string for `PublisherRow`, optionally prefixed for JOINs. */
export function publisherColumns(prefix = ""): string {
	return PUBLISHER_VIEW_COLUMN_NAMES.map((c) => `${prefix}${c}`).join(", ");
}

/** AT URI of a package's profile record — the `packageView.uri` and the
 * hydration subject handlers hydrate labels for before calling
 * `packageView`. Single source of truth so the two never drift. No return
 * type annotation, and `as const` on the template literal: together these
 * keep the inferred type as a template-literal pattern rather than
 * widening to plain `string`, which `packageView.uri`'s `ResourceUri`
 * type needs. */
export function packageUri(row: Pick<PackageRow, "did" | "slug">) {
	return `at://${row.did}/${NSID.packageProfile}/${row.slug}` as const;
}

/** AT URI of a release record — the `releaseView.uri` and the hydration
 * subject handlers hydrate labels for before calling `releaseView`. */
export function releaseUri(row: Pick<ReleaseRow, "did" | "rkey">) {
	return `at://${row.did}/${NSID.packageRelease}/${row.rkey}` as const;
}

/** AT URI of a publisher's profile record — the `publisherView.uri` and a
 * label-hydration subject. The rkey is always `self` (enforced at ingest). */
export function publisherUri(row: Pick<PublisherRow, "did">) {
	return `at://${row.did}/${NSID.publisherProfile}/self` as const;
}

/** Caps a combined labels array at the lexicon's maxLength. A view's
 * labels are the union of multiple hydrated subjects (e.g. a release's own
 * URI plus its parent package and publisher DID). Hydration returns
 * untruncated per-subject sets so redaction decisions see every label;
 * this boundary cap trims only the final view array.
 *
 * The trim is enforcement-preserving: a plain slice can drop the only hard
 * block when a subject carries more than `LABELS_MAX_LENGTH` labels, and a
 * client evaluating the truncated view would then treat the release as
 * installable. Labels are ordered by `labelTruncationPriority` (blocks, then
 * assessment states, then informational) before slicing, so blocks survive.
 * Hydrated labels never carry negations (`hydrateLabels` returns only
 * `neg = 0` rows), so ordering can't split a label from its negation. In the
 * pathological case of more than `LABELS_MAX_LENGTH` hard blocks the kept
 * slice is still all blocks — the release stays blocked, only the exact set
 * is lossy — and we log an error. */
function capLabels(labels: LabelView[], uri: string): LabelView[] {
	if (labels.length <= LABELS_MAX_LENGTH) return labels;
	const ordered = labels.toSorted(
		(left, right) => labelTruncationPriority(left.val) - labelTruncationPriority(right.val),
	);
	const kept = ordered.slice(0, LABELS_MAX_LENGTH);
	const droppedBlocks = ordered
		.slice(LABELS_MAX_LENGTH)
		.filter((label) => labelTruncationPriority(label.val) === 0).length;
	if (droppedBlocks > 0) {
		console.error("[aggregator] view label cap dropped hard-block labels", {
			uri,
			count: labels.length,
			cap: LABELS_MAX_LENGTH,
			droppedBlocks,
		});
	} else {
		console.warn("[aggregator] view labels truncated to maxLength", {
			uri,
			count: labels.length,
			cap: LABELS_MAX_LENGTH,
		});
	}
	return kept;
}

/** `LabelView.src` is `string`; the lexicon's `Label.src` is a branded DID
 * template type. Safe to assert — `src` is a labeler DID validated at
 * ingest time, same trust boundary as the `did` cast below. */
function toLexiconLabels(labels: LabelView[]): AggregatorDefs.PackageView["labels"] {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion
	return labels as AggregatorDefs.PackageView["labels"];
}

/**
 * Map a `packages` row to the lexicon's `packageView`. The synthesized
 * `profile` field reconstructs the package.profile record JSON from the
 * normalised columns — same field values the publisher signed. For
 * byte-identical bytes, clients call `sync.getRecord` and re-verify.
 *
 * `indexedAt` falls back to `verified_at` for any historical row that
 * predates migration 0002 (`indexed_at` is nullable at the schema level —
 * see migration comment).
 *
 * `labels` are hydrated by the caller (package URI + publisher DID
 * subjects) and passed in; defaulting to `[]` covers the accepted-policy-
 * empty case where there's nothing to hydrate.
 */
export function packageView(row: PackageRow, labels: LabelView[] = []): AggregatorDefs.PackageView {
	const uri = packageUri(row);
	const cid = parseSignatureMetadataCid(row.signature_metadata) ?? "";
	// `mirrors` is on releaseView, not packageView — packages aren't
	// mirrored, releases are. Don't add it here even though they share the
	// "envelope" idiom in plan-doc shorthand.
	const view: AggregatorDefs.PackageView = {
		uri,
		cid,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- `did` is consumer-validated at write time
		did: row.did as `did:${string}:${string}`,
		slug: row.slug,
		profile: synthesizePackageProfile(row, uri),
		indexedAt: row.indexed_at ?? row.verified_at,
		labels: toLexiconLabels(capLabels(labels, uri)),
	};
	if (row.latest_version !== null) {
		view.latestVersion = row.latest_version;
	}
	return view;
}

/**
 * Map a `releases` row to the lexicon's `releaseView`. The synthesized
 * `release` field reconstructs the package.release record JSON from the
 * normalised columns. `mirrors: []` is intentional — the artifact mirror
 * worker (Slice 3) is what populates real mirror URLs; until then the
 * field is the empty contract.
 *
 * `labels` are hydrated by the caller (release URI + package URI +
 * publisher DID subjects, carrying cascade context) and passed in.
 */
export function releaseView(row: ReleaseRow, labels: LabelView[] = []): AggregatorDefs.ReleaseView {
	const uri = releaseUri(row);
	const cid = parseSignatureMetadataCid(row.signature_metadata) ?? "";
	return {
		uri,
		cid,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- `did` is consumer-validated at write time
		did: row.did as `did:${string}:${string}`,
		package: row.package,
		version: row.version,
		release: synthesizePackageRelease(row),
		mirrors: [],
		indexedAt: row.indexed_at ?? row.verified_at,
		labels: toLexiconLabels(capLabels(labels, uri)),
	};
}

/**
 * Map a `publishers` row to the lexicon's `publisherView`. The synthesized
 * `profile` field reconstructs the publisher.profile record JSON from the
 * normalised columns — same field values the publisher signed. For
 * byte-identical bytes, clients call `sync.getRecord` and re-verify.
 *
 * `labels` are hydrated by the caller (profile URI + publisher DID subjects)
 * and passed in; defaulting to `[]` covers the accepted-policy-empty case.
 */
export function publisherView(
	row: PublisherRow,
	labels: LabelView[] = [],
): AggregatorDefs.PublisherView {
	const uri = publisherUri(row);
	const cid = parseSignatureMetadataCid(row.signature_metadata) ?? "";
	return {
		uri,
		cid,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- `did` is consumer-validated at write time
		did: row.did as `did:${string}:${string}`,
		profile: synthesizePublisherProfile(row),
		indexedAt: row.indexed_at ?? row.verified_at,
		labels: toLexiconLabels(capLabels(labels, uri)),
	};
}

/** Reconstruct the `com.emdashcms.experimental.publisher.profile` record
 * JSON from the row's columns. Optional fields are omitted (rather than
 * emitted as null) so the JSON shape matches what a publisher would have
 * written. Same passthrough-shape caveat as `synthesizePackageProfile`:
 * typed as `Record<string, unknown>` because clients re-validate against
 * the published lexicon. */
function synthesizePublisherProfile(row: PublisherRow): Record<string, unknown> {
	const profile: Record<string, unknown> = {
		$type: NSID.publisherProfile,
		displayName: row.display_name,
	};
	if (row.description !== null) profile["description"] = row.description;
	if (row.url !== null) profile["url"] = row.url;
	if (row.contact !== null) profile["contact"] = parseJsonArray(row.contact);
	if (row.updated_at !== null) profile["updatedAt"] = row.updated_at;
	return profile;
}

/** Reconstruct the `com.emdashcms.experimental.package.profile` record
 * JSON from the row's columns. Field set matches what the consumer's
 * `ingestPackageProfile` writer accepts; optional fields are omitted
 * (rather than emitted as null) so the JSON shape matches what a
 * publisher would have written.
 *
 * Returned as `Record<string, unknown>` rather than typed to the lexicon
 * Main schema — the columns hold writer-validated JSON but TypeScript
 * can't narrow `JSON.parse` output to the lexicon's structural types
 * without re-validating, and the lexicon explicitly types `packageView.profile`
 * as `unknown` for exactly this reason: the value is a passthrough on
 * the wire and clients re-validate against the published lexicon. */
function synthesizePackageProfile(row: PackageRow, uri: string): Record<string, unknown> {
	const profile: Record<string, unknown> = {
		$type: NSID.packageProfile,
		id: uri,
		type: row.type,
		license: row.license,
		authors: parseJsonArray(row.authors),
		security: parseJsonArray(row.security),
	};
	if (row.name !== null) profile["name"] = row.name;
	if (row.description !== null) profile["description"] = row.description;
	if (row.keywords !== null) profile["keywords"] = parseJsonArray(row.keywords);
	if (row.sections !== null) {
		const sections = parseJsonObject(row.sections);
		if (sections) profile["sections"] = sections;
	}
	if (row.last_updated !== null) profile["lastUpdated"] = row.last_updated;
	// `slug` in the record is optional but, when present, must equal the
	// rkey. We always have it as the PK of the row, so always emit.
	profile["slug"] = row.slug;
	return profile;
}

/** Reconstruct the `com.emdashcms.experimental.package.release` record
 * JSON from the row's columns. The `extensions` map is rebuilt from the
 * stored `emdash_extension` payload (which the writer validates against
 * the `releaseExtension` lexicon at ingest time). Same passthrough-shape
 * caveat as `synthesizePackageProfile`. */
function synthesizePackageRelease(row: ReleaseRow): Record<string, unknown> {
	const release: Record<string, unknown> = {
		$type: NSID.packageRelease,
		package: row.package,
		version: row.version,
		artifacts: parseJsonObject(row.artifacts) ?? {},
	};
	if (row.requires !== null) {
		const requires = parseJsonObject(row.requires);
		if (requires) release["requires"] = requires;
	}
	if (row.suggests !== null) {
		const suggests = parseJsonObject(row.suggests);
		if (suggests) release["suggests"] = suggests;
	}
	if (row.repo_url !== null) release["repo"] = row.repo_url;
	const ext = parseJsonObject(row.emdash_extension);
	if (ext) {
		release["extensions"] = {
			[NSID.packageReleaseExtension]: { ...ext, $type: NSID.packageReleaseExtension },
		};
	}
	return release;
}

/** Subset of columns from `publisher_verifications` we read for
 * `verificationClaimView`. */
export interface PublisherVerificationRow {
	issuer_did: string;
	subject_handle: string;
	subject_display_name: string;
	created_at: string;
	expires_at: string | null;
	indexed_at: string | null;
	verified_at: string;
}

const PUBLISHER_VERIFICATION_VIEW_COLUMN_NAMES = [
	"issuer_did",
	"subject_handle",
	"subject_display_name",
	"created_at",
	"expires_at",
	"indexed_at",
	"verified_at",
] as const;

/** SELECT-clause string for `PublisherVerificationRow`, optionally prefixed
 * for JOINs. */
export function publisherVerificationColumns(prefix = ""): string {
	return PUBLISHER_VERIFICATION_VIEW_COLUMN_NAMES.map((c) => `${prefix}${c}`).join(", ");
}

/**
 * Map the `publisher_verifications` rows naming `did` as subject to the
 * lexicon's `publisherVerificationView`. `labels` are hydrated by the caller
 * (the publisher DID subject) and passed in; an empty `rows` is a valid view
 * (an unverified publisher), distinct from the caller throwing NotFound for a
 * redacted DID.
 */
export function publisherVerificationView(
	did: string,
	rows: PublisherVerificationRow[],
	labels: LabelView[] = [],
): AggregatorDefs.PublisherVerificationView {
	return {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- `did` is the route param, validated as a DID by the lexicon
		did: did as `did:${string}:${string}`,
		verifications: rows.map(verificationClaimView),
		labels: toLexiconVerificationLabels(capLabels(labels, did)),
	};
}

function verificationClaimView(
	row: PublisherVerificationRow,
): AggregatorDefs.VerificationClaimView {
	const claim: AggregatorDefs.VerificationClaimView = {
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- issuer_did is consumer-validated at ingest time
		issuer: row.issuer_did as `did:${string}:${string}`,
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- subject_handle is consumer-validated at ingest time
		handle: row.subject_handle as AggregatorDefs.VerificationClaimView["handle"],
		displayName: row.subject_display_name,
		createdAt: row.created_at,
		indexedAt: row.indexed_at ?? row.verified_at,
	};
	if (row.expires_at !== null) claim.expiresAt = row.expires_at;
	return claim;
}

function toLexiconVerificationLabels(
	labels: LabelView[],
): AggregatorDefs.PublisherVerificationView["labels"] {
	// eslint-disable-next-line typescript/no-unsafe-type-assertion
	return labels as AggregatorDefs.PublisherVerificationView["labels"];
}

function parseJsonArray(json: string): unknown[] {
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? parsed : [];
	} catch {
		return [];
	}
}

function parseJsonObject(json: string): Record<string, unknown> | null {
	try {
		const parsed: unknown = JSON.parse(json);
		return isPlainObject(parsed) ? parsed : null;
	} catch {
		return null;
	}
}
