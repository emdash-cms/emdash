import type { OperatorFinding } from "../api/types.js";
import { ASSESSMENT_BETA, ASSESSMENT_GAMMA } from "./assessments.js";

export const FINDING_BETA_LOW_QUALITY: OperatorFinding = {
	id: "find_8VNBZKZ2XA5MVJ1GC4DBE3JHY1",
	assessmentId: ASSESSMENT_BETA.id,
	source: "model",
	category: "low-quality",
	severity: "medium",
	confidence: 0.72,
	title: "Packaging metadata inconsistent with declared entry point",
	publicSummary: "The release's declared entry point does not match the bundled files.",
	privateDetail:
		"Model flagged package.json main field '/dist/index.js' but the bundle only contains " +
		"/lib/index.cjs — likely a broken build step upstream rather than malicious intent.",
	evidenceRefs: ["evid_JVDZA75GM4G8JZPZTNQCBVVYZT"],
	createdAt: "2026-07-12T08:06:40.000Z",
};

export const FINDING_BETA_MISLEADING_METADATA: OperatorFinding = {
	id: "find_N5727F57820GD7NGTPNACG7SPK",
	assessmentId: ASSESSMENT_BETA.id,
	source: "deterministic",
	category: "misleading-metadata",
	severity: "low",
	title: "README references an unrelated repository",
	publicSummary: "The README links to a repository that does not match the declared package.",
	privateDetail:
		"README badge links to github.com/other-org/other-repo; no redirect or fork relationship " +
		"found via the identity resolver.",
	evidenceRefs: [],
	createdAt: "2026-07-12T08:06:55.000Z",
};

export const FINDING_GAMMA_MALWARE: OperatorFinding = {
	id: "find_T36FX53QSY7WP3NQ6Y8N7V39A8",
	assessmentId: ASSESSMENT_GAMMA.id,
	source: "deterministic",
	category: "malware",
	severity: "critical",
	title: "Known malware signature match",
	publicSummary: "This release matches a known malware signature.",
	privateDetail:
		"YARA rule 'stealer-generic-v3' matched the packed payload at dist/postinstall.js:1 — " +
		"matches 4 prior confirmed npm supply-chain incidents in the corpus.",
	evidenceRefs: ["evid_2JQKN2WMB5PHN6W3D59ACBNSMJ"],
	affectedFiles: ["dist/postinstall.js"],
	createdAt: "2026-07-12T11:31:20.000Z",
};

export const FINDING_GAMMA_OBFUSCATED_CODE: OperatorFinding = {
	id: "find_75AZDBSW7D1S62TZ8BE07XY5B1",
	assessmentId: ASSESSMENT_GAMMA.id,
	source: "capability",
	category: "obfuscated-code",
	severity: "high",
	confidence: 0.94,
	title: "Heavily obfuscated postinstall script",
	publicSummary:
		"A postinstall script uses obfuscation techniques inconsistent with normal minification.",
	privateDetail:
		"String-array rotation plus an eval-based deobfuscation loop detected via AST capability " +
		"scan; entropy score 7.91/8.",
	evidenceRefs: ["evid_2JQKN2WMB5PHN6W3D59ACBNSMJ"],
	affectedFiles: ["dist/postinstall.js"],
	createdAt: "2026-07-12T11:31:35.000Z",
};

/** Findings keyed by assessment id, matching `recordFinding`'s grouping. */
export const FIXTURE_FINDINGS_BY_ASSESSMENT: Readonly<Record<string, readonly OperatorFinding[]>> =
	{
		[ASSESSMENT_BETA.id]: [FINDING_BETA_LOW_QUALITY, FINDING_BETA_MISLEADING_METADATA],
		[ASSESSMENT_GAMMA.id]: [FINDING_GAMMA_MALWARE, FINDING_GAMMA_OBFUSCATED_CODE],
	};
