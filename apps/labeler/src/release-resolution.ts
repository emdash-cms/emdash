/**
 * Release resolution for artifact acquisition (Slice-B design 2026-07-17). Maps
 * an assessment to the `AcquisitionTarget` the acquire stage fetches, reading
 * the signed release over the `AGGREGATOR` service binding (the ratified W8.4
 * slice-3 read-path pattern) — the declared artifact URL is not stored
 * labeler-side, only the pinned `artifact_id`/`artifact_checksum`.
 *
 * The release view is addressed by `(did, package)`, both derived from the
 * assessment's release URI: the DID is the URI authority and the package slug
 * is the rkey prefix (a release rkey is `<package>:<version>`). `getLatestRelease`
 * is the fast path; when its CID differs from the assessment's pinned CID (a
 * newer release now leads the package) a `listReleases` scan finds the exact
 * pinned release, since the aggregator exposes no by-CID release endpoint.
 *
 * A release the aggregator has not indexed (or not yet re-indexed for this CID)
 * throws `StageTransientError`: that is aggregator lag, the existing transient
 * acquisition failure — never a permanent finding, since absence is not
 * evidence the plugin is bad, and reconciliation owns true deletions. The
 * declared-vs-pinned checksum/id drift check is NOT done here — the target
 * carries both the declared coordinates and the pinned ones so acquisition's
 * `crossCheckCoordinates` raises the ratified integrity finding on drift.
 */

import type { AggregatorDefs, AggregatorListReleases } from "@emdash-cms/registry-lexicons";

import type { AcquisitionTarget } from "./artifact-acquisition.js";
import { StageTransientError } from "./assessment-orchestrator.js";
import type { Assessment } from "./assessment-store.js";
import { parseAtUri, RecordVerificationError } from "./record-verification.js";

/** Bounds the `listReleases` scan for the pinned CID. Newest-first paging means
 * the pinned release is normally on an early page; a not-found within this many
 * pages classifies as aggregator lag (transient), same as an absent release. */
const MAX_RELEASE_SCAN_PAGES = 20;

/** Cap on the publisher-supplied release description threaded into the AI
 * stages' metadata. The description is best-effort context, but it is
 * publisher-controlled and reaches both models' fixed prompt overhead; an
 * uncapped padded description could exceed `MAX_MODEL_INPUT_CHARS` and make the
 * adapter throw a non-transient error that stalls the run — a block-suppression
 * vector. Truncating at ingestion (far under the model budget) closes it. */
export const MAX_RELEASE_DESCRIPTION_CHARS = 4096;

/** The aggregator reads this resolver needs, narrowed so tests inject a plain
 * object. `AggregatorClient` satisfies it structurally. */
export interface ReleaseReader {
	getLatestRelease(did: string, pkg: string): Promise<AggregatorDefs.ReleaseView | null>;
	listReleases(
		did: string,
		pkg: string,
		cursor?: string,
	): Promise<AggregatorListReleases.$output | null>;
	getPackage(did: string, slug: string): Promise<AggregatorDefs.PackageView | null>;
}

export type ReleaseTargetResolver = (assessment: Assessment) => Promise<AcquisitionTarget>;

export function createReleaseResolver(aggregator: ReleaseReader): ReleaseTargetResolver {
	return async (assessment) => {
		const { did, pkg } = parseReleaseCoordinates(assessment.uri);
		const view = await resolveReleaseView(aggregator, did, pkg, assessment.cid);
		const artifact = extractPackageArtifact(view.release);
		if (!artifact) {
			throw new StageTransientError(
				`release ${assessment.uri} is missing a package artifact declaration in the aggregator view`,
			);
		}
		const description = await resolveDescription(aggregator, did, view.package);
		return {
			url: artifact.url,
			checksum: artifact.checksum,
			slug: view.package,
			version: view.version,
			...(artifact.artifactId !== undefined ? { artifactId: artifact.artifactId } : {}),
			pinnedChecksum: assessment.artifactChecksum,
			pinnedArtifactId: assessment.artifactId,
			...(description !== undefined ? { description } : {}),
		};
	};
}

interface ReleaseCoordinates {
	readonly did: string;
	readonly pkg: string;
}

function parseReleaseCoordinates(uri: string): ReleaseCoordinates {
	let parsed;
	try {
		parsed = parseAtUri(uri);
	} catch (err) {
		if (err instanceof RecordVerificationError) throw new StageTransientError(err.message);
		throw err;
	}
	const separator = parsed.rkey.indexOf(":");
	const pkg = separator === -1 ? "" : parsed.rkey.slice(0, separator);
	if (pkg.length === 0) {
		throw new StageTransientError(`release URI ${uri} has no package slug in its record key`);
	}
	return { did: parsed.did, pkg };
}

/** The latest release when it is the pinned CID, otherwise the pinned CID found
 * by scanning `listReleases`. A miss on either path is aggregator lag. */
async function resolveReleaseView(
	aggregator: ReleaseReader,
	did: string,
	pkg: string,
	cid: string,
): Promise<AggregatorDefs.ReleaseView> {
	const latest = await aggregator.getLatestRelease(did, pkg);
	if (latest && latest.cid === cid) return latest;

	let cursor: string | undefined;
	for (let page = 0; page < MAX_RELEASE_SCAN_PAGES; page += 1) {
		const result = await aggregator.listReleases(did, pkg, cursor);
		if (!result) break;
		const match = result.releases.find((release) => release.cid === cid);
		if (match) return match;
		if (!result.cursor) break;
		cursor = result.cursor;
	}

	throw new StageTransientError(
		`release ${did}/${pkg}@${cid} is not indexed by the aggregator yet`,
	);
}

/** Best-effort human description from the package profile, for the code/image
 * stages' stated-purpose analysis. A profile-fetch failure or an unindexed
 * profile leaves it absent — the description is analysis context, never an
 * integrity input, so it must not fail acquisition of a verified artifact. */
async function resolveDescription(
	aggregator: ReleaseReader,
	did: string,
	slug: string,
): Promise<string | undefined> {
	try {
		const view = await aggregator.getPackage(did, slug);
		if (!view) return undefined;
		return extractProfileDescription(view.profile);
	} catch {
		return undefined;
	}
}

interface PackageArtifact {
	readonly url: string;
	readonly checksum: string;
	readonly artifactId?: string;
}

/** Reads `artifacts.package.{ url, checksum, id }` from the verbatim signed
 * release record without lexicon re-validation (the aggregator already
 * validated it; the fetched bytes are re-verified against `checksum`
 * downstream). Returns `null` when the required fields are absent. */
function extractPackageArtifact(release: unknown): PackageArtifact | null {
	if (!isRecord(release)) return null;
	const artifacts = release.artifacts;
	if (!isRecord(artifacts)) return null;
	const pkg = artifacts.package;
	if (!isRecord(pkg)) return null;
	if (typeof pkg.url !== "string" || typeof pkg.checksum !== "string") return null;
	return {
		url: pkg.url,
		checksum: pkg.checksum,
		...(typeof pkg.id === "string" ? { artifactId: pkg.id } : {}),
	};
}

function extractProfileDescription(profile: unknown): string | undefined {
	if (!isRecord(profile)) return undefined;
	if (typeof profile.description !== "string") return undefined;
	const description = profile.description;
	if (description.length <= MAX_RELEASE_DESCRIPTION_CHARS) return description;
	return `${description.slice(0, MAX_RELEASE_DESCRIPTION_CHARS - 1)}…`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
