import type { AssessmentRun } from "../api/types.js";
import {
	SUBJECT_ALPHA,
	SUBJECT_BETA,
	SUBJECT_DELTA,
	SUBJECT_EPSILON,
	SUBJECT_GAMMA,
} from "./subjects.js";

const POLICY_VERSION = "2026-07-10.experimental.2";
const MODEL_ID = "@cf/meta/llama-3.1-70b-instruct";
const PROMPT_HASH = "sha256:2f1a9c7e0b4d6f8a1c3e5b7d9f0a2c4e6b8d0f2a4c6e8b0d2f4a6c8e0b2d4f6a";

/** Superseded run for pkg-alpha — a manual re-run later replaced this
 * decision (asmt_R79G below), so it's the row `isSuperseded` flags. */
export const ASSESSMENT_ALPHA_INITIAL: AssessmentRun = {
	id: "asmt_SQCP5CP1X1RBMM0V0TQP2WR9PD",
	runKey: "run-alpha-initial",
	uri: SUBJECT_ALPHA.uri,
	cid: SUBJECT_ALPHA.cid,
	artifactId: "artifact-alpha-0001",
	artifactChecksum: "sha256:9a1e3f5c7b9d1f3e5a7c9b1d3f5e7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e",
	state: "passed",
	publicState: "superseded",
	trigger: "initial",
	triggerId: "initial:bafyreirk3vaepohxuw5ujlpiwztlnr3xj3bdiuivzl7dkxvzqqqzyxbziy",
	policyVersion: POLICY_VERSION,
	modelId: MODEL_ID,
	promptHash: PROMPT_HASH,
	publicSummary: "No blocking findings for this release.",
	supersedesAssessmentId: null,
	startedAt: "2026-07-08T09:12:05.000Z",
	completedAt: "2026-07-08T09:13:40.000Z",
	createdAt: "2026-07-08T09:12:00.000Z",
	isSuperseded: true,
};

/** Current pointer for pkg-alpha — an operator-triggered re-run. */
export const ASSESSMENT_ALPHA_RERUN: AssessmentRun = {
	id: "asmt_R79G2W700J4F005EAG66HP66JR",
	runKey: "run-alpha-rerun",
	uri: SUBJECT_ALPHA.uri,
	cid: SUBJECT_ALPHA.cid,
	artifactId: "artifact-alpha-0001",
	artifactChecksum: "sha256:9a1e3f5c7b9d1f3e5a7c9b1d3f5e7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e",
	state: "passed",
	publicState: "passed",
	trigger: "operator",
	triggerId: "operator:act_7SPDHNJ1BHZEDZBBXC3RYX06WK",
	policyVersion: POLICY_VERSION,
	modelId: MODEL_ID,
	promptHash: PROMPT_HASH,
	publicSummary: "Re-run confirmed no blocking findings.",
	supersedesAssessmentId: ASSESSMENT_ALPHA_INITIAL.id,
	startedAt: "2026-07-11T16:40:10.000Z",
	completedAt: "2026-07-11T16:41:55.000Z",
	createdAt: "2026-07-11T16:40:00.000Z",
	isSuperseded: false,
};

export const ASSESSMENT_BETA: AssessmentRun = {
	id: "asmt_34XM75YB5AJ9Z84B9EJBWM0CV1",
	runKey: "run-beta-initial",
	uri: SUBJECT_BETA.uri,
	cid: SUBJECT_BETA.cid,
	artifactId: "artifact-beta-0002",
	artifactChecksum: "sha256:1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e3a5c7e9b1d3f5a7c9e1b3d5f7a9c1e3b",
	state: "warned",
	publicState: "warned",
	trigger: "initial",
	triggerId: "initial:bafyreidmvd2b5c2cjdwk34ymwydyy3eh6n7ce5p4dm37bltiaputjjvb6w",
	policyVersion: POLICY_VERSION,
	modelId: MODEL_ID,
	promptHash: PROMPT_HASH,
	publicSummary: "Passed with a low-quality packaging warning.",
	supersedesAssessmentId: null,
	startedAt: "2026-07-12T08:05:20.000Z",
	completedAt: "2026-07-12T08:07:05.000Z",
	createdAt: "2026-07-12T08:05:00.000Z",
	isSuperseded: false,
};

export const ASSESSMENT_GAMMA: AssessmentRun = {
	id: "asmt_RT0G62FEF7MAX2R6K0K0P3E3RN",
	runKey: "run-gamma-initial",
	uri: SUBJECT_GAMMA.uri,
	cid: SUBJECT_GAMMA.cid,
	artifactId: "artifact-gamma-0003",
	artifactChecksum: "sha256:5e7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e3a5c7e9b1d3f5a7c9e1b3d5f79",
	state: "blocked",
	publicState: "blocked",
	trigger: "initial",
	triggerId: "initial:bafyreirtyymrfqymf5zhtpyzzotvg3fy67qgmemz2ux6iheu6wvetl3ias",
	policyVersion: POLICY_VERSION,
	modelId: null,
	promptHash: null,
	publicSummary: "Blocked: malware and obfuscated code detected.",
	supersedesAssessmentId: null,
	startedAt: "2026-07-12T11:30:15.000Z",
	completedAt: "2026-07-12T11:32:50.000Z",
	createdAt: "2026-07-12T11:30:00.000Z",
	isSuperseded: false,
};

/** Still in flight — an internal `running` state, publicly reported as `pending`. */
export const ASSESSMENT_DELTA: AssessmentRun = {
	id: "asmt_BZ7JNKG1TYRMZMVP0XQEGEC1Y7",
	runKey: "run-delta-initial",
	uri: SUBJECT_DELTA.uri,
	cid: SUBJECT_DELTA.cid,
	artifactId: "artifact-delta-0004",
	artifactChecksum: "sha256:3c5e7a9c1b3d5f7e9a1c3b5d7f9e1a3c5b7d9f1e3a5c7e9b1d3f5a7c9e1b3d57",
	state: "running",
	publicState: "pending",
	trigger: "initial",
	triggerId: "initial:bafyreiq2fy4ydmg6jz5aljtgdwgwp4fr6tgvte25pv55k4ynibtva2p3hx",
	policyVersion: POLICY_VERSION,
	modelId: null,
	promptHash: null,
	publicSummary: null,
	supersedesAssessmentId: null,
	startedAt: "2026-07-13T07:50:05.000Z",
	completedAt: null,
	createdAt: "2026-07-13T07:50:00.000Z",
	isSuperseded: false,
};

export const ASSESSMENT_EPSILON: AssessmentRun = {
	id: "asmt_K2Y9KK9SSTD43VVT780P6HMT8A",
	runKey: "run-epsilon-initial",
	uri: SUBJECT_EPSILON.uri,
	cid: SUBJECT_EPSILON.cid,
	artifactId: "artifact-epsilon-0005",
	artifactChecksum: null,
	state: "error",
	publicState: "error",
	trigger: "initial",
	triggerId: "initial:bafyreic4ioya7s4elpagcfebx3hwhltmbmzgag7yx3q2smjhvt45i2dmts",
	policyVersion: POLICY_VERSION,
	modelId: null,
	promptHash: null,
	publicSummary: "Assessment failed to complete due to a scanner timeout.",
	supersedesAssessmentId: null,
	startedAt: "2026-07-12T22:15:10.000Z",
	completedAt: "2026-07-12T22:25:00.000Z",
	createdAt: "2026-07-12T22:15:00.000Z",
	isSuperseded: false,
};

/** Newest first, matching the labeler's `getAssessmentsPage` ordering. */
export const FIXTURE_ASSESSMENTS: readonly AssessmentRun[] = [
	ASSESSMENT_DELTA,
	ASSESSMENT_EPSILON,
	ASSESSMENT_GAMMA,
	ASSESSMENT_BETA,
	ASSESSMENT_ALPHA_RERUN,
	ASSESSMENT_ALPHA_INITIAL,
];
