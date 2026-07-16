/**
 * Publisher-history context stage (plan W8.4, slices 1 + 3). Produces
 * `source: "history"` normalized findings from the labeler's OWN D1 — prior
 * releases from the publishing DID, the same artifact checksum submitted under
 * other DIDs, and existing active manual labels on the subject — plus, when a
 * read-only aggregator binding is supplied, the publisher's verification state
 * (slice 3).
 *
 * These findings are bounded, factual context an operator reads through the
 * assessment projection. They are structurally never turned into labels: the
 * resolver drops every `source: "history"` finding before any category→label
 * mapping (`policy-resolver.ts`), and `validateFinding` holds them to the
 * dedicated `HISTORY_FINDING_CATEGORIES` set (`findings.ts`), disjoint from the
 * policy's label vocabulary.
 *
 * Slice 3's second deferred input — recent handle/profile *changes* — has no
 * read here: the aggregator ingests only current profile state (`publishers` is
 * upserted, keeping no prior values) and does not subscribe to the atproto
 * identity events that carry handle changes, so a change history does not exist
 * to expose. It is blocked on that ingestion work, not on a read path.
 */

import type { AggregatorGetPublisherVerification } from "@emdash-cms/registry-lexicons";

import {
	getActiveLabelState,
	getCurrentSubjectByUri,
	getPriorReleaseUrisForDid,
	getPublishersSharingChecksum,
	type Assessment,
} from "./assessment-store.js";
import type { NormalizedFinding } from "./findings.js";

const HISTORY_TOOL = "publisher-history";
const HISTORY_TOOL_VERSION = "1";

const DEFAULT_PRIOR_RELEASE_LIMIT = 20;
const DEFAULT_SHARED_PUBLISHER_LIMIT = 20;
/** How many URIs/DIDs to name in a finding's private detail. */
const SAMPLE_SIZE = 5;

/**
 * Read-only aggregator surface `analyzeHistory` needs for slice 3. Narrowed to
 * the one method so tests inject a plain object and the stage doesn't depend on
 * the whole `AggregatorClient`. `AggregatorClient` satisfies it structurally.
 */
export interface PublisherVerificationReader {
	getPublisherVerification(did: string): Promise<AggregatorGetPublisherVerification.$output | null>;
}

export interface HistoryContextOptions {
	/** The labeler's own DID (`src`) — the stream whose active manual labels
	 * count as context. */
	src: string;
	priorReleaseLimit?: number;
	sharedPublisherLimit?: number;
	now?: Date;
	/** Read-only aggregator binding for the publisher's verification state
	 * (slice 3). When omitted, the verification input is skipped and only the
	 * own-D1 findings are produced. */
	aggregator?: PublisherVerificationReader;
}

/**
 * DB-bound stage adapter matching the orchestrator's stage contract: returns
 * `NormalizedFinding[]`, one per input that has something to report. History is
 * operator-only context that never becomes a label, so a failure to gather it
 * must never fail the assessment run — that would discard the decision-relevant
 * findings from every other stage. The stage is best-effort: on any error it
 * logs and returns no findings rather than throwing, so it can never gate the
 * run regardless of its position in `STAGE_ORDER`.
 */
export async function analyzeHistory(
	db: D1Database,
	assessment: Assessment,
	opts: HistoryContextOptions,
): Promise<NormalizedFinding[]> {
	const priorReleaseLimit = opts.priorReleaseLimit ?? DEFAULT_PRIOR_RELEASE_LIMIT;
	const sharedPublisherLimit = opts.sharedPublisherLimit ?? DEFAULT_SHARED_PUBLISHER_LIMIT;

	try {
		const findings: NormalizedFinding[] = [];
		const subject = await getCurrentSubjectByUri(db, assessment.uri);

		if (subject) {
			const priorUris = await getPriorReleaseUrisForDid(db, {
				did: subject.did,
				excludeUri: assessment.uri,
				limit: priorReleaseLimit,
			});
			if (priorUris.length > 0)
				findings.push(priorReleasesFinding(subject.did, priorUris, priorReleaseLimit));

			if (assessment.artifactChecksum) {
				const otherDids = await getPublishersSharingChecksum(db, {
					checksum: assessment.artifactChecksum,
					excludeDid: subject.did,
					limit: sharedPublisherLimit,
				});
				if (otherDids.length > 0)
					findings.push(
						sharedArtifactFinding(assessment.artifactChecksum, otherDids, sharedPublisherLimit),
					);
			}
		}

		const labelState = await getActiveLabelState(db, {
			src: opts.src,
			uri: assessment.uri,
			cid: assessment.cid,
			...(opts.now !== undefined ? { now: opts.now } : {}),
		});
		const activeManualLabels = [...labelState.values()]
			.filter((winner) => !winner.automated && winner.active)
			.map((winner) => winner.val);
		if (activeManualLabels.length > 0) findings.push(activeManualLabelFinding(activeManualLabels));

		// Slice-3 aggregator read. Its own try/catch so an aggregator failure
		// skips only the verification context and never discards the own-D1
		// findings already gathered above — a verification read that threw into
		// the outer catch would return `[]` and lose the decision-adjacent
		// context the operator relies on.
		if (opts.aggregator && subject) {
			try {
				const state = await opts.aggregator.getPublisherVerification(subject.did);
				const finding = verificationStateFinding(subject.did, state, opts.now ?? new Date());
				if (finding) findings.push(finding);
			} catch (err) {
				console.error(
					`[history-context] verification-state lookup failed, skipping verification context: ${err instanceof Error ? err.message : String(err)}`,
				);
			}
		}

		return findings;
	} catch (err) {
		console.error(
			`[history-context] lookup failed, skipping context for this run: ${err instanceof Error ? err.message : String(err)}`,
		);
		return [];
	}
}

function toolMetadata() {
	return { kind: "tool", tool: HISTORY_TOOL, version: HISTORY_TOOL_VERSION } as const;
}

function countText(count: number, capped: boolean): string {
	return capped ? `at least ${count}` : `${count}`;
}

function pluralize(count: number, noun: string): string {
	return count === 1 ? noun : `${noun}s`;
}

function priorReleasesFinding(did: string, uris: string[], limit: number): NormalizedFinding {
	const capped = uris.length >= limit;
	const count = countText(uris.length, capped);
	return {
		source: "history",
		category: "publisher-history",
		severity: "info",
		title: `Publisher has ${count} prior ${pluralize(uris.length, "release")}`,
		publicSummary: `The publishing account has ${count} other ${pluralize(uris.length, "release")} known to the labeler.`,
		privateDetail: `Publisher ${did} has ${count} prior ${pluralize(uris.length, "release")}. Sample: ${uris.slice(0, SAMPLE_SIZE).join(", ")}.`,
		evidenceRefs: [],
		sourceMetadata: toolMetadata(),
	};
}

function sharedArtifactFinding(checksum: string, dids: string[], limit: number): NormalizedFinding {
	const capped = dids.length >= limit;
	const count = countText(dids.length, capped);
	// Cross-publisher artifact reuse is a correlation/deanonymization signal, so
	// the title and publicSummary stay non-revealing — the specifics live only in
	// privateDetail.
	return {
		source: "history",
		category: "shared-artifact",
		severity: "low",
		title: "Artifact provenance context",
		publicSummary: "Operator-only artifact-provenance context is recorded for this release.",
		privateDetail: `Artifact checksum ${checksum} also submitted by ${count} other ${pluralize(dids.length, "publisher")}: ${dids.slice(0, SAMPLE_SIZE).join(", ")}.`,
		evidenceRefs: [],
		sourceMetadata: toolMetadata(),
	};
}

function verificationStateFinding(
	did: string,
	state: AggregatorGetPublisherVerification.$output | null,
	now: Date,
): NormalizedFinding | null {
	// `null` means the aggregator has no view (a redacted publisher DID under
	// the default policy); an empty `verifications` array means an unverified
	// publisher. Neither is a finding — the console assembles the neutral
	// "unverified" display state at read time (plan W8.4 D5). Emit only when
	// there is verification state to record, mirroring the own-D1 findings.
	if (!state || state.verifications.length === 0) return null;

	const claims = state.verifications;
	const inForce = claims.filter((claim) => !isExpired(claim.expiresAt, now)).length;
	const issuers = [...new Set(claims.map((claim) => claim.issuer))];
	// Issuer identities and the subject's bound handle are indexed from public
	// records, but the finding keeps them out of the public-facing title and
	// summary and in privateDetail — consistent with the other history findings
	// and with history being an operator-only projection.
	return {
		source: "history",
		category: "publisher-verification",
		severity: "info",
		title: "Publisher verification context",
		publicSummary: "Operator-only publisher-verification context is recorded for this subject.",
		privateDetail: `Publisher ${did} has ${claims.length} indexed verification ${pluralize(claims.length, "claim")} (${inForce} currently in force) from ${issuers.length} ${pluralize(issuers.length, "issuer")}: ${issuers.slice(0, SAMPLE_SIZE).join(", ")}.`,
		evidenceRefs: [],
		sourceMetadata: toolMetadata(),
	};
}

function isExpired(expiresAt: string | undefined, now: Date): boolean {
	if (expiresAt === undefined) return false;
	const expiry = Date.parse(expiresAt);
	return !Number.isNaN(expiry) && expiry <= now.getTime();
}

function activeManualLabelFinding(vals: string[]): NormalizedFinding {
	// The existence and identity of manual labels (including redactions) must not
	// leak into a public projection, so the title and publicSummary reveal
	// nothing — the label values live only in privateDetail.
	return {
		source: "history",
		category: "active-manual-label",
		severity: "info",
		title: "Operator label context",
		publicSummary: "Operator-only label context is recorded for this subject.",
		privateDetail: `Active manual labels: ${vals.join(", ")}.`,
		evidenceRefs: [],
		sourceMetadata: toolMetadata(),
	};
}
