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

/**
 * Map a `packages` row to the lexicon's `packageView`. The synthesized
 * `profile` field reconstructs the package.profile record JSON from the
 * normalised columns — same field values the publisher signed. For
 * byte-identical bytes, clients call `sync.getRecord` and re-verify.
 *
 * `indexedAt` falls back to `verified_at` for any historical row that
 * predates migration 0002 (`indexed_at` is nullable at the schema level —
 * see migration comment).
 */
export function packageView(row: PackageRow): AggregatorDefs.PackageView {
	const uri = `at://${row.did}/${NSID.packageProfile}/${row.slug}` as const;
	const cid = parseSignatureMetadataCid(row.signature_metadata) ?? "";
	// `mirrors` is on releaseView, not packageView — packages aren't
	// mirrored, releases are. Don't add it here even though they share the
	// "envelope" idiom in plan-doc shorthand.
	const view: AggregatorDefs.PackageView = {
		uri,
		cid,
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- `did` is consumer-validated at write time
		did: row.did as `did:${string}:${string}`,
		slug: row.slug,
		profile: synthesizePackageProfile(row, uri),
		indexedAt: row.indexed_at ?? row.verified_at,
		labels: [],
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
 */
export function releaseView(row: ReleaseRow): AggregatorDefs.ReleaseView {
	const uri = `at://${row.did}/${NSID.packageRelease}/${row.rkey}` as const;
	const cid = parseSignatureMetadataCid(row.signature_metadata) ?? "";
	return {
		uri,
		cid,
		// eslint-disable-next-line typescript-eslint(no-unsafe-type-assertion) -- `did` is consumer-validated at write time
		did: row.did as `did:${string}:${string}`,
		package: row.package,
		version: row.version,
		release: synthesizePackageRelease(row),
		mirrors: [],
		indexedAt: row.indexed_at ?? row.verified_at,
		labels: [],
	};
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
