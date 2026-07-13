import { describe, expect, it } from "vitest";

import type { AssessmentState } from "../src/assessment-lifecycle.js";
import type {
	AssessmentFinding,
	AssessmentIssuedLabel,
	ListedAssessment,
	Subject,
} from "../src/assessment-store.js";
import {
	serializeAssessmentRun,
	serializeIssuedLabel,
	serializeOperatorActionView,
	serializeOperatorFinding,
	serializeSubjectRecord,
} from "../src/console-serialize.js";
import type { StoredOperatorAction } from "../src/operator-actions.js";
import { derivePublicState } from "../src/public-assessment.js";

function listedAssessment(overrides: Partial<ListedAssessment> = {}): ListedAssessment {
	return {
		id: "asmt_01",
		runKey: "run-01",
		uri: "at://did:plc:x/com.emdashcms.experimental.package.release/rk1",
		cid: "bafyreialpha",
		artifactId: "artifact-1",
		artifactChecksum: "sha256:abc",
		state: "passed",
		trigger: "initial",
		triggerId: "initial:x",
		policyVersion: "2026-07-10.experimental.2",
		modelId: "@cf/meta/llama-3.1-70b-instruct",
		promptHash: "sha256:prompt",
		publicSummary: "No blocking findings.",
		coverageJson: '{"code":"complete","images":"not-present","metadata":"complete"}',
		supersedesAssessmentId: null,
		startedAt: "2026-07-08T09:12:05.000Z",
		completedAt: "2026-07-08T09:13:40.000Z",
		createdAt: "2026-07-08T09:12:00.000Z",
		isSuperseded: false,
		...overrides,
	};
}

describe("serializeAssessmentRun", () => {
	it("omits coverageJson but keeps operator provenance (modelId/promptHash)", () => {
		const run = serializeAssessmentRun(listedAssessment());
		expect(run).not.toHaveProperty("coverageJson");
		expect(run.modelId).toBe("@cf/meta/llama-3.1-70b-instruct");
		expect(run.promptHash).toBe("sha256:prompt");
		expect(run.isSuperseded).toBe(false);
	});

	it("computes publicState as derivePublicState(state, isSuperseded) across the state matrix", () => {
		const states: AssessmentState[] = [
			"observed",
			"verifying",
			"pending",
			"running",
			"passed",
			"warned",
			"blocked",
			"error",
			"stale",
			"cancelled",
		];
		for (const state of states) {
			for (const isSuperseded of [false, true]) {
				const run = serializeAssessmentRun(listedAssessment({ state, isSuperseded }));
				expect(run.publicState).toBe(derivePublicState(state, isSuperseded));
			}
		}
	});

	it("marks a superseded decision run as publicState superseded", () => {
		const run = serializeAssessmentRun(listedAssessment({ state: "passed", isSuperseded: true }));
		expect(run.publicState).toBe("superseded");
	});
});

describe("serializeOperatorFinding", () => {
	const base: AssessmentFinding = {
		id: "find_01",
		assessmentId: "asmt_01",
		source: "model",
		category: "low-quality",
		severity: "medium",
		confidence: 0.72,
		title: "Packaging metadata inconsistent",
		publicSummary: "Declared entry point does not match the bundle.",
		privateDetail: "Model flagged package.json main field — likely a broken build step.",
		evidenceRefs: ["evid_01"],
		createdAt: "2026-07-12T08:06:40.000Z",
	};

	it("includes the operator-only privateDetail and evidenceRefs", () => {
		const finding = serializeOperatorFinding(base);
		expect(finding.privateDetail).toBe(base.privateDetail);
		expect(finding.evidenceRefs).toEqual(["evid_01"]);
	});

	it("includes confidence when present and omits it when null", () => {
		expect(serializeOperatorFinding(base).confidence).toBe(0.72);
		const withoutConfidence = serializeOperatorFinding({ ...base, confidence: null });
		expect(withoutConfidence).not.toHaveProperty("confidence");
	});
});

describe("serializeIssuedLabel", () => {
	it("maps the integer neg flag to a boolean", () => {
		const label: AssessmentIssuedLabel = {
			val: "malware",
			cts: "2026-07-12T11:32:50.000Z",
			exp: null,
			neg: true,
			sequence: 5,
		};
		expect(serializeIssuedLabel(label)).toEqual({
			val: "malware",
			cts: "2026-07-12T11:32:50.000Z",
			exp: null,
			neg: true,
			sequence: 5,
		});
	});
});

describe("serializeSubjectRecord", () => {
	it("maps snake_case store fields to the wire shape", () => {
		const subject: Subject = {
			uri: "at://did:plc:x/col/rk",
			cid: "bafyreialpha",
			did: "did:plc:x",
			collection: "col",
			rkey: "rk",
			observedAt: "2026-07-08T09:10:00.000Z",
			deletedAt: null,
		};
		expect(serializeSubjectRecord(subject)).toEqual(subject);
	});
});

describe("serializeOperatorActionView", () => {
	const stored: StoredOperatorAction = {
		id: "oact_01",
		actorType: "human",
		actorId: "access|sub-1",
		actorEmail: "reviewer@example.com",
		actorCommonName: null,
		role: "reviewer",
		action: "label-retract",
		subjectUri: "at://did:plc:x/col/rk",
		subjectCid: "bafyreialpha",
		labelValue: "malware",
		reason: "false positive",
		idempotencyKey: "idem-abcdefgh",
		requestFingerprint: "a".repeat(64),
		resultJson: '{"retracted":true}',
		metadataJson: '{"note":"internal"}',
		createdAt: "2026-07-12T14:02:15.000Z",
		createdAtEpochMs: 1_752_328_935_000,
	};

	it("excludes the internal replay fields", () => {
		const view = serializeOperatorActionView(stored);
		expect(view).not.toHaveProperty("idempotencyKey");
		expect(view).not.toHaveProperty("requestFingerprint");
		expect(view).not.toHaveProperty("resultJson");
		expect(view).not.toHaveProperty("metadataJson");
		expect(view).not.toHaveProperty("createdAtEpochMs");
	});

	it("keeps the displayed who/what/why fields", () => {
		const view = serializeOperatorActionView(stored);
		expect(view).toMatchObject({
			id: "oact_01",
			actorType: "human",
			actorId: "access|sub-1",
			actorEmail: "reviewer@example.com",
			role: "reviewer",
			action: "label-retract",
			subjectUri: "at://did:plc:x/col/rk",
			subjectCid: "bafyreialpha",
			labelValue: "malware",
			reason: "false positive",
			createdAt: "2026-07-12T14:02:15.000Z",
		});
	});
});
