import type { IssuedLabel } from "../api/types.js";
import {
	ASSESSMENT_ALPHA_INITIAL,
	ASSESSMENT_ALPHA_RERUN,
	ASSESSMENT_BETA,
	ASSESSMENT_GAMMA,
} from "./assessments.js";

/** Positive label ops keyed by assessment id, matching `getLabelsForAssessment`. */
export const FIXTURE_LABELS_BY_ASSESSMENT: Readonly<Record<string, readonly IssuedLabel[]>> = {
	[ASSESSMENT_ALPHA_INITIAL.id]: [
		{
			val: "assessment-passed",
			cts: "2026-07-08T09:13:40.000Z",
			exp: null,
			neg: false,
			sequence: 1,
		},
	],
	[ASSESSMENT_ALPHA_RERUN.id]: [
		{
			val: "assessment-passed",
			cts: "2026-07-11T16:41:55.000Z",
			exp: null,
			neg: false,
			sequence: 2,
		},
	],
	[ASSESSMENT_BETA.id]: [
		{ val: "low-quality", cts: "2026-07-12T08:07:05.000Z", exp: null, neg: false, sequence: 3 },
		{
			val: "assessment-passed",
			cts: "2026-07-12T08:07:05.000Z",
			exp: null,
			neg: false,
			sequence: 4,
		},
	],
	[ASSESSMENT_GAMMA.id]: [
		{ val: "malware", cts: "2026-07-12T11:32:50.000Z", exp: null, neg: false, sequence: 5 },
		{
			val: "obfuscated-code",
			cts: "2026-07-12T11:32:50.000Z",
			exp: null,
			neg: false,
			sequence: 6,
		},
	],
};
