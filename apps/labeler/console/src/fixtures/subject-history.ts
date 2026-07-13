import type { SubjectHistoryView } from "../api/types.js";
import { FIXTURE_ASSESSMENTS } from "./assessments.js";
import { FIXTURE_SUBJECTS } from "./subjects.js";

/** Subject history keyed by URI, matching `listNonTerminalAssessmentsForUri` +
 * `getAssessmentsPage`'s per-uri grouping, newest run first. */
export const FIXTURE_SUBJECT_HISTORY: Readonly<Record<string, SubjectHistoryView>> =
	Object.fromEntries(
		FIXTURE_SUBJECTS.map((subject) => [
			subject.uri,
			{
				subject,
				assessments: FIXTURE_ASSESSMENTS.filter((a) => a.uri === subject.uri),
			},
		]),
	);
