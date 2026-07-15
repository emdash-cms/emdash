/**
 * Publisher-history context stage (plan W8.4, slice 1). Produces
 * `source: "history"` normalized findings from the labeler's OWN D1 — prior
 * releases from the publishing DID, the same artifact checksum submitted under
 * other DIDs, and existing active manual labels on the subject.
 *
 * These findings are bounded, factual context an operator reads through the
 * assessment projection. They are structurally never turned into labels: the
 * resolver drops every `source: "history"` finding before any category→label
 * mapping (`policy-resolver.ts`), and `validateFinding` holds them to the
 * dedicated `HISTORY_FINDING_CATEGORIES` set (`findings.ts`), disjoint from the
 * policy's label vocabulary.
 *
 * The two deferred inputs — recent handle/profile changes and verification
 * state — live only in the aggregator's D1, which the labeler has no binding to
 * reach; they are gated on a ratified read path (plan W8.4 D1) and not built
 * here.
 */

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

export interface HistoryContextOptions {
	/** The labeler's own DID (`src`) — the stream whose active manual labels
	 * count as context. */
	src: string;
	priorReleaseLimit?: number;
	sharedPublisherLimit?: number;
	now?: Date;
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
