import type { PublisherHistory, SubjectHistoryView } from "../api/types.js";
import { FIXTURE_ASSESSMENTS } from "./assessments.js";
import { FIXTURE_SUBJECTS, SUBJECT_ALPHA } from "./subjects.js";

/** Publisher-history context keyed by URI, mirroring the server's read-time
 * assembly (`serializePublisherHistory`). Alpha carries prior releases and an
 * active manual label; the rest default to an empty block. */
const PUBLISHER_HISTORY_BY_URI: Readonly<Record<string, PublisherHistory>> = {
	[SUBJECT_ALPHA.uri]: {
		did: SUBJECT_ALPHA.did,
		priorReleaseCount: 3,
		priorReleaseCapped: false,
		priorReleaseSample: [
			"at://did:plc:z7x3g4k9m2q8w1r5t6y0u3i7/com.emdashcms.experimental.package.release/3lduzalpha0000",
			"at://did:plc:z7x3g4k9m2q8w1r5t6y0u3i7/com.emdashcms.experimental.package.release/3lduzalphaprev1",
			"at://did:plc:z7x3g4k9m2q8w1r5t6y0u3i7/com.emdashcms.experimental.package.release/3lduzalphaprev2",
		],
		activeManualLabels: [{ val: "disputed" }, { val: "security-yanked", cid: SUBJECT_ALPHA.cid }],
	},
};

function publisherHistoryFor(uri: string, did: string): PublisherHistory {
	return (
		PUBLISHER_HISTORY_BY_URI[uri] ?? {
			did,
			priorReleaseCount: 0,
			priorReleaseCapped: false,
			priorReleaseSample: [],
			activeManualLabels: [],
		}
	);
}

/** Subject history keyed by URI, matching `listNonTerminalAssessmentsForUri` +
 * `getAssessmentsPage`'s per-uri grouping, newest run first. */
export const FIXTURE_SUBJECT_HISTORY: Readonly<Record<string, SubjectHistoryView>> =
	Object.fromEntries(
		FIXTURE_SUBJECTS.map((subject) => [
			subject.uri,
			{
				subject,
				assessments: FIXTURE_ASSESSMENTS.filter((a) => a.uri === subject.uri),
				publisherHistory: publisherHistoryFor(subject.uri, subject.did),
			},
		]),
	);
