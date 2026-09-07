import { NSID } from "@emdash-cms/registry-lexicons";
import {
	evaluateHydratedReleaseWithdrawal,
	evaluateHydratedListingVisibility,
	LEGACY_RELEASE_WITHDRAWAL_LABEL,
	RELEASE_WITHDRAWAL_LABEL,
	type ListingLabelEvent,
	type ListingModerationPolicy,
} from "@emdash-cms/registry-moderation";

import {
	isPackageAllowlisted,
	packageProfileUri,
	type ListingPolicyConfig,
} from "./listing-policy.js";
import { isPlainObject, parseSignatureMetadataCid } from "./utils.js";

interface ProfileRevisionRow {
	page_rowid: number;
	did: string;
	slug: string;
	cid: string;
	type: string;
	name: string | null;
	description: string | null;
	license: string;
	authors: string;
	security: string;
	keywords: string | null;
	sections: string | null;
	last_updated: string | null;
	record_blob: ArrayBuffer | Uint8Array;
	signature_metadata: string | null;
	observed_at: string;
	last_verified_at: string;
	current_cid: string | null;
}

interface ReleaseProjectionSourceRow {
	page_rowid: number;
	did: string;
	package: string;
	version: string;
	rkey: string;
	version_sort: string;
	artifacts: string;
	requires: string | null;
	suggests: string | null;
	emdash_extension: string;
	repo_url: string | null;
	cts: string;
	record_blob: ArrayBuffer | Uint8Array;
	signature_metadata: string | null;
	verified_at: string;
	indexed_at: string | null;
}

interface LabelStateRow {
	src: string;
	uri: string;
	val: string;
	cid: string | null;
	neg: number;
	cts: string;
	exp: string | null;
}

export interface RebuildPublicProjectionOptions {
	listingPolicy: ListingPolicyConfig;
	moderationPolicy?: ListingModerationPolicy;
	evaluatedAt: Date | string;
	generation?: string;
	beforeActivate?: () => Promise<void>;
}

export interface RebuildPublicProjectionResult {
	generation: string;
	packages: number;
	releases: number;
}

interface ProjectionLease {
	source_epoch: number;
	rebuild_sequence: number;
}

export class StaleProjectionRebuildError extends Error {
	override readonly name = "StaleProjectionRebuildError";
}

const MAX_BATCH_STATEMENTS = 100;
const REBUILD_READ_PAGE_SIZE = 500;

export async function rebuildPublicProjection(
	db: D1Database,
	options: RebuildPublicProjectionOptions,
): Promise<RebuildPublicProjectionResult> {
	const moderationPolicy = options.moderationPolicy ?? options.listingPolicy.moderationPolicy;
	if (options.listingPolicy.mode === "projection") {
		if (!moderationPolicy || !options.listingPolicy.moderationPolicy) {
			throw new TypeError("projection rebuild requires a configured moderation policy");
		}
		if (
			JSON.stringify(moderationPolicy) !== JSON.stringify(options.listingPolicy.moderationPolicy)
		) {
			throw new TypeError("projection rebuild policy does not match the configured policy");
		}
	}
	const evaluatedAt =
		options.evaluatedAt instanceof Date ? options.evaluatedAt.toISOString() : options.evaluatedAt;
	const generation = options.generation ?? crypto.randomUUID();
	const lease = await db
		.prepare(
			`UPDATE listing_projection_control
			 SET latest_rebuild_sequence = latest_rebuild_sequence + 1
			 WHERE id = 1
			 RETURNING source_epoch, latest_rebuild_sequence AS rebuild_sequence`,
		)
		.first<ProjectionLease>();
	if (!lease) throw new Error("listing projection control row is missing");

	const [profileResult, releaseResult, labelResult] = await Promise.all([
		readProfileRevisions(db),
		readReleaseRevisions(db),
		readWinningLabelCandidates(db),
	]);

	const profiles = profileResult;
	const releases = releaseResult;
	const labelsByUri = groupLabels(labelResult);
	const selectedProfiles = selectProfiles(profiles, labelsByUri, options, evaluatedAt);
	const selectedReleases = selectReleases(
		releases,
		selectedProfiles,
		labelsByUri,
		options,
		evaluatedAt,
	);
	const releasesByPackage = groupReleases(selectedReleases);

	if (options.listingPolicy.mode === "projection") {
		for (const key of selectedProfiles.keys()) {
			if ((releasesByPackage.get(key)?.length ?? 0) === 0) selectedProfiles.delete(key);
		}
	}
	if (!(await projectionLeaseIsCurrent(db, lease))) {
		throw new StaleProjectionRebuildError("projection inputs changed while reading the snapshot");
	}

	await db
		.prepare(
			`INSERT INTO public_projection_generations
			   (generation, policy_mode, policy_version, policy_hash,
			    required_positive_sources, accepted_state_sources, redaction_sources,
			    source_epoch, rebuild_sequence, created_at, completed_at)
			 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
		)
		.bind(
			generation,
			options.listingPolicy.mode,
			options.listingPolicy.moderationPolicyVersion,
			options.listingPolicy.moderationPolicyHash,
			JSON.stringify(moderationPolicy?.requiredPositiveSources ?? []),
			JSON.stringify(moderationPolicy?.acceptedStateSources ?? []),
			JSON.stringify(moderationPolicy?.redactionSources ?? []),
			lease.source_epoch,
			lease.rebuild_sequence,
			evaluatedAt,
		)
		.run();

	const releaseStatements: D1PreparedStatement[] = [];
	for (const [key, packageReleases] of releasesByPackage) {
		if (!selectedProfiles.has(key)) continue;
		for (const release of packageReleases) {
			const cid = parseSignatureMetadataCid(release.signature_metadata);
			if (!cid) continue;
			releaseStatements.push(
				db
					.prepare(
						`INSERT INTO public_releases
						   (generation, did, package, version, release_cid, rkey, version_sort,
						    artifacts, requires, suggests, emdash_extension, repo_url, cts,
						    record_blob, signature_metadata, verified_at, indexed_at, labels_json,
						    projected_at)
						 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
					)
					.bind(
						generation,
						release.did,
						release.package,
						release.version,
						cid,
						release.rkey,
						release.version_sort,
						release.artifacts,
						release.requires,
						release.suggests,
						release.emdash_extension,
						release.repo_url,
						release.cts,
						release.record_blob,
						release.signature_metadata,
						release.verified_at,
						release.indexed_at ?? release.verified_at,
						JSON.stringify(
							publicReleaseLabels(
								labelsByUri,
								`at://${release.did}/${NSID.packageRelease}/${release.rkey}`,
								options.listingPolicy.redactionSources,
							),
						),
						evaluatedAt,
					),
			);
		}
	}
	await runBatches(db, releaseStatements);

	const packageStatements: D1PreparedStatement[] = [];
	for (const [key, profile] of selectedProfiles) {
		const latest = releasesByPackage.get(key)?.[0];
		packageStatements.push(
			db
				.prepare(
					`INSERT INTO public_packages
					   (generation, did, slug, profile_cid, type, name, description, license,
					    authors, security, keywords, sections, last_updated, latest_version,
				    capabilities, record_blob, signature_metadata, verified_at, indexed_at,
				    labels_json, projected_at)
				 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				)
				.bind(
					generation,
					profile.did,
					profile.slug,
					profile.cid,
					profile.type,
					profile.name,
					profile.description,
					profile.license,
					profile.authors,
					profile.security,
					profile.keywords,
					profile.sections,
					profile.last_updated,
					latest?.version ?? null,
					latest ? capabilitiesFromRelease(latest) : null,
					profile.record_blob,
					profile.signature_metadata,
					profile.last_verified_at,
					profile.observed_at,
					JSON.stringify(labelsFor(labelsByUri, packageProfileUri(profile.did, profile.slug))),
					evaluatedAt,
				),
		);
	}
	await runBatches(db, packageStatements);

	await options.beforeActivate?.();
	await db
		.prepare(
			`UPDATE public_projection_generations
			 SET completed_at = ?
			 WHERE generation = ?`,
		)
		.bind(evaluatedAt, generation)
		.run();
	const activation = await db
		.prepare(
			`UPDATE public_projection_state
			 SET active_generation = ?, updated_at = ?
			 WHERE id = 1
			   AND EXISTS (
			     SELECT 1 FROM listing_projection_control control
			     WHERE control.id = 1
			       AND control.source_epoch = ?
			       AND control.latest_rebuild_sequence = ?
			   )
			   AND EXISTS (
			     SELECT 1 FROM public_projection_generations generation
			     WHERE generation.generation = ?
			       AND generation.source_epoch = ?
			       AND generation.rebuild_sequence = ?
			       AND generation.completed_at IS NOT NULL
			   )`,
		)
		.bind(
			generation,
			evaluatedAt,
			lease.source_epoch,
			lease.rebuild_sequence,
			generation,
			lease.source_epoch,
			lease.rebuild_sequence,
		)
		.run();
	if (activation.meta.changes !== 1) {
		await db
			.prepare(
				`DELETE FROM public_projection_generations
				 WHERE generation = ?
				   AND NOT EXISTS (
				     SELECT 1 FROM public_projection_state WHERE active_generation = ?
				   )`,
			)
			.bind(generation, generation)
			.run();
		throw new StaleProjectionRebuildError(
			"projection inputs changed or a newer rebuild started before activation",
		);
	}

	await db
		.prepare(
			`DELETE FROM public_projection_generations
			 WHERE generation <> ? AND rebuild_sequence < ?`,
		)
		.bind(generation, lease.rebuild_sequence)
		.run();

	return {
		generation,
		packages: selectedProfiles.size,
		releases: [...releasesByPackage.entries()].reduce(
			(count, [key, rows]) => count + (selectedProfiles.has(key) ? rows.length : 0),
			0,
		),
	};
}

async function readProfileRevisions(db: D1Database): Promise<ProfileRevisionRow[]> {
	const rows: ProfileRevisionRow[] = [];
	let cursor = 0;
	for (;;) {
		const page = await db
			.prepare(
				`SELECT r.rowid AS page_rowid, r.did, r.slug, r.cid, r.type, r.name,
				        r.description, r.license, r.authors, r.security, r.keywords,
				        r.sections, r.last_updated, r.record_blob, r.signature_metadata,
				        r.observed_at, r.last_verified_at, h.current_cid
				 FROM package_profile_revisions r
				 JOIN package_profile_heads h ON h.did = r.did AND h.slug = r.slug
				 WHERE h.deleted_at IS NULL AND r.rowid > ?
				 ORDER BY r.rowid ASC LIMIT ?`,
			)
			.bind(cursor, REBUILD_READ_PAGE_SIZE)
			.all<ProfileRevisionRow>();
		const results = page.results ?? [];
		rows.push(...results);
		const last = results.at(-1);
		if (!last || results.length < REBUILD_READ_PAGE_SIZE) return rows;
		cursor = last.page_rowid;
	}
}

async function readReleaseRevisions(db: D1Database): Promise<ReleaseProjectionSourceRow[]> {
	const rows: ReleaseProjectionSourceRow[] = [];
	let cursor = 0;
	for (;;) {
		const page = await db
			.prepare(
				`SELECT r.rowid AS page_rowid, r.did, r.package, r.version, r.rkey,
				        r.version_sort, r.artifacts, r.requires, r.suggests,
				        r.emdash_extension, r.repo_url, r.cts, r.record_blob,
				        r.signature_metadata, r.verified_at, r.indexed_at
				 FROM releases r
				 JOIN package_profile_heads h ON h.did = r.did AND h.slug = r.package
				 WHERE h.deleted_at IS NULL AND r.tombstoned_at IS NULL AND r.rowid > ?
				 ORDER BY r.rowid ASC LIMIT ?`,
			)
			.bind(cursor, REBUILD_READ_PAGE_SIZE)
			.all<ReleaseProjectionSourceRow>();
		const results = page.results ?? [];
		rows.push(...results);
		const last = results.at(-1);
		if (!last || results.length < REBUILD_READ_PAGE_SIZE) return rows;
		cursor = last.page_rowid;
	}
}

interface PagedLabelStateRow extends LabelStateRow {
	page_rowid: number;
}

export async function readWinningLabelCandidates(db: D1Database): Promise<LabelStateRow[]> {
	const rows: LabelStateRow[] = [];
	let cursor = 0;
	for (;;) {
		const page = await db
			.prepare(
				`WITH ranked AS (
				   SELECT history.rowid AS page_rowid, history.src, history.uri,
				          history.val, history.cid, history.neg, history.cts, history.exp,
				          DENSE_RANK() OVER (
				            PARTITION BY history.src, history.uri, history.val
				            ORDER BY history.cts_epoch DESC, history.cts_fraction DESC
				          ) AS time_rank
				   FROM listing_labels history
				   JOIN labellers source ON source.did = history.src
				   WHERE source.active = 1 AND source.trusted = 1
				 )
				 SELECT page_rowid, src, uri, val, cid, neg, cts, exp
				 FROM ranked
				 WHERE time_rank = 1 AND page_rowid > ?
				 ORDER BY page_rowid ASC LIMIT ?`,
			)
			.bind(cursor, REBUILD_READ_PAGE_SIZE)
			.all<PagedLabelStateRow>();
		const results = page.results ?? [];
		rows.push(...results);
		const last = results.at(-1);
		if (!last || results.length < REBUILD_READ_PAGE_SIZE) break;
		cursor = last.page_rowid;
	}
	const fallback = await db
		.prepare(
			`SELECT state.src, state.uri, state.val, state.cid,
			        state.neg, state.cts, state.exp
			 FROM label_state state
			 WHERE state.trusted = 1
			   AND NOT EXISTS (
			     SELECT 1 FROM listing_labels history
			     WHERE history.src = state.src
			       AND history.uri = state.uri
			       AND history.val = state.val
			   )`,
		)
		.all<LabelStateRow>();
	rows.push(...(fallback.results ?? []));
	return rows;
}

async function projectionLeaseIsCurrent(db: D1Database, lease: ProjectionLease): Promise<boolean> {
	const current = await db
		.prepare(
			`SELECT 1 AS current
			 FROM listing_projection_control
			 WHERE id = 1 AND source_epoch = ? AND latest_rebuild_sequence = ?`,
		)
		.bind(lease.source_epoch, lease.rebuild_sequence)
		.first<{ current: number }>();
	return current !== null;
}

function selectProfiles(
	profiles: readonly ProfileRevisionRow[],
	labelsByUri: ReadonlyMap<string, readonly ListingLabelEvent[]>,
	options: RebuildPublicProjectionOptions,
	evaluatedAt: string,
): Map<string, ProfileRevisionRow> {
	const grouped = new Map<string, ProfileRevisionRow[]>();
	for (const profile of profiles) {
		const key = packageKey(profile.did, profile.slug);
		const rows = grouped.get(key);
		if (rows) rows.push(profile);
		else grouped.set(key, [profile]);
	}

	const selected = new Map<string, ProfileRevisionRow>();
	for (const [key, rows] of grouped) {
		const orderedRows = rows.toSorted(
			(left, right) =>
				Number(right.cid === right.current_cid) - Number(left.cid === left.current_cid) ||
				right.observed_at.localeCompare(left.observed_at) ||
				right.cid.localeCompare(left.cid),
		);
		const newest = orderedRows[0];
		if (!newest) continue;
		if (options.listingPolicy.mode === "open") {
			selected.set(key, newest);
			continue;
		}
		if (options.listingPolicy.mode === "allowlist") {
			if (isPackageAllowlisted(options.listingPolicy, newest.did, newest.slug)) {
				selected.set(key, newest);
			}
			continue;
		}

		const policy = options.moderationPolicy ?? options.listingPolicy.moderationPolicy;
		if (!policy) continue;
		for (const profile of orderedRows) {
			const uri = packageProfileUri(profile.did, profile.slug);
			const visibility = evaluateHydratedListingVisibility({
				subject: {
					uri,
					cid: profile.cid,
					kind: "profile",
					publisherDid: profile.did,
				},
				policy,
				labels: labelsFor(labelsByUri, uri, profile.did),
				evaluatedAt,
			});
			if (visibility.visible) {
				selected.set(key, profile);
				break;
			}
		}
	}
	return selected;
}

function selectReleases(
	releases: readonly ReleaseProjectionSourceRow[],
	profiles: ReadonlyMap<string, ProfileRevisionRow>,
	labelsByUri: ReadonlyMap<string, readonly ListingLabelEvent[]>,
	options: RebuildPublicProjectionOptions,
	evaluatedAt: string,
): ReleaseProjectionSourceRow[] {
	const selected: ReleaseProjectionSourceRow[] = [];
	for (const release of releases) {
		const key = packageKey(release.did, release.package);
		if (!profiles.has(key)) continue;
		const cid = parseSignatureMetadataCid(release.signature_metadata);
		if (!cid) continue;
		const uri = `at://${release.did}/${NSID.packageRelease}/${release.rkey}`;
		const releaseLabels = labelsFor(labelsByUri, uri);
		if (
			evaluateHydratedReleaseWithdrawal({
				uri,
				cid,
				labels: releaseLabels,
				evaluatedAt,
				acceptedSources: options.listingPolicy.redactionSources,
			}).withdrawn
		) {
			continue;
		}
		if (options.listingPolicy.mode === "open" || options.listingPolicy.mode === "allowlist") {
			selected.push(release);
			continue;
		}
		const policy = options.moderationPolicy ?? options.listingPolicy.moderationPolicy;
		if (!policy || !cid) continue;
		const profileUri = packageProfileUri(release.did, release.package);
		const visibility = evaluateHydratedListingVisibility({
			subject: {
				uri,
				cid,
				kind: "release",
				publisherDid: release.did,
				profileUri,
			},
			policy,
			labels: labelsFor(labelsByUri, uri, profileUri, release.did),
			evaluatedAt,
		});
		if (visibility.visible) selected.push(release);
	}
	return selected;
}

function groupLabels(rows: readonly LabelStateRow[]): Map<string, ListingLabelEvent[]> {
	const grouped = new Map<string, ListingLabelEvent[]>();
	for (const row of rows) {
		const label: ListingLabelEvent = {
			ver: 1,
			src: row.src,
			uri: row.uri,
			val: row.val,
			cts: row.cts,
			...(row.cid === null ? {} : { cid: row.cid }),
			...(row.neg === 0 ? {} : { neg: true }),
			...(row.exp === null ? {} : { exp: row.exp }),
		};
		const labels = grouped.get(row.uri);
		if (labels) labels.push(label);
		else grouped.set(row.uri, [label]);
	}
	return grouped;
}

function labelsFor(
	grouped: ReadonlyMap<string, readonly ListingLabelEvent[]>,
	...uris: readonly string[]
): ListingLabelEvent[] {
	return uris.flatMap((uri) => grouped.get(uri) ?? []);
}

function publicReleaseLabels(
	grouped: ReadonlyMap<string, readonly ListingLabelEvent[]>,
	uri: string,
	redactionSources: readonly string[],
): ListingLabelEvent[] {
	return labelsFor(grouped, uri).filter(
		(label) =>
			(label.val !== LEGACY_RELEASE_WITHDRAWAL_LABEL && label.val !== RELEASE_WITHDRAWAL_LABEL) ||
			redactionSources.includes(label.src),
	);
}

function groupReleases(
	releases: readonly ReleaseProjectionSourceRow[],
): Map<string, ReleaseProjectionSourceRow[]> {
	const grouped = new Map<string, ReleaseProjectionSourceRow[]>();
	for (const release of releases) {
		const key = packageKey(release.did, release.package);
		const rows = grouped.get(key);
		if (rows) rows.push(release);
		else grouped.set(key, [release]);
	}
	for (const [key, rows] of grouped) {
		grouped.set(
			key,
			rows.toSorted(
				(left, right) =>
					right.version_sort.localeCompare(left.version_sort) ||
					right.version.localeCompare(left.version) ||
					right.rkey.localeCompare(left.rkey),
			),
		);
	}
	return grouped;
}

function capabilitiesFromRelease(release: ReleaseProjectionSourceRow): string | null {
	try {
		const extension: unknown = JSON.parse(release.emdash_extension);
		if (!isPlainObject(extension) || !isPlainObject(extension["declaredAccess"])) return null;
		return JSON.stringify(Object.keys(extension["declaredAccess"]).toSorted());
	} catch {
		return null;
	}
}

async function runBatches(
	db: D1Database,
	statements: readonly D1PreparedStatement[],
): Promise<void> {
	for (let offset = 0; offset < statements.length; offset += MAX_BATCH_STATEMENTS) {
		await db.batch(statements.slice(offset, offset + MAX_BATCH_STATEMENTS));
	}
}

function packageKey(did: string, slug: string): string {
	return `${did}\u0000${slug}`;
}
