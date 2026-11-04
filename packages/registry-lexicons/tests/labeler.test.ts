import { is } from "@atcute/lexicons/validations";
import { MODERATION_FINDING_CATEGORIES } from "@emdash-cms/registry-moderation";
import { describe, expect, it } from "vitest";

import labelerDefsLexicon from "../lexicons/com/emdashcms/experimental/labeler/defs.json" with { type: "json" };
import {
	LabelerDefs,
	LabelerGetAssessment,
	LabelerGetCurrentAssessment,
	LabelerGetPolicy,
	LabelerListAssessments,
	NSID,
} from "../src/index.js";

const subject: LabelerDefs.AssessmentSubject = {
	kind: "profile",
	uri: "at://did:plc:publisher/com.emdashcms.experimental.package.profile/gallery",
	cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
};

const model: LabelerDefs.ModelDescriptor = {
	purpose: "text",
	provider: "workers-ai",
	modelId: "@cf/meta/llama-3.1-8b-instruct",
	modelVersion: "2026-08-01",
	promptHash: "sha256:4e07408562bedb8b60ce05c1decfe3ad16b722309c8e",
};

const label = {
	ver: 1,
	src: "did:web:labels.emdashcms.com",
	uri: subject.uri,
	cid: subject.cid,
	val: "listing-passed",
	cts: "2026-08-20T12:01:00Z",
	sig: { $bytes: "AA==" },
} as const;

const assessment: LabelerDefs.PublicAssessment = {
	id: "asmt_01K33QGCAGQ4GEXGAAZ7PEQRQ8",
	src: label.src,
	subject,
	state: "passed",
	coverage: {
		text: "complete",
		links: "complete",
		media: "not-present",
	},
	reasonCodes: [],
	findings: [],
	summary: "Required listing checks completed.",
	assessmentSchemaVersion: 1,
	policyVersion: "listing-policy-2026-08-20",
	parserVersion: "metadata-parser-1",
	models: [model],
	labels: [label],
	createdAt: "2026-08-20T12:00:00Z",
	completedAt: "2026-08-20T12:01:00Z",
};

describe("labeler assessment lexicons", () => {
	it("validates an exact-CID metadata assessment using standard ATProto labels", () => {
		const current: LabelerGetCurrentAssessment.$output = {
			src: assessment.src,
			subject,
			assessment,
			activeLabels: [label],
		};

		expect(is(LabelerDefs.publicAssessmentSchema, assessment)).toBe(true);
		expect(is(LabelerDefs.currentAssessmentViewSchema, current)).toBe(true);
	});

	it("requires signatures on public assessment and current labels", () => {
		const { sig: _signature, ...unsigned } = label;

		expect(
			is(LabelerDefs.publicAssessmentSchema, {
				...assessment,
				labels: [unsigned],
			}),
		).toBe(false);
		expect(
			is(LabelerDefs.currentAssessmentViewSchema, {
				src: assessment.src,
				subject,
				assessment,
				activeLabels: [unsigned],
			}),
		).toBe(false);
	});

	it("represents every public assessment state", () => {
		const states = ["pending", "passed", "review", "blocked", "error", "superseded"];

		for (const state of states) {
			expect(is(LabelerDefs.publicAssessmentSchema, { ...assessment, state })).toBe(true);
		}
	});

	it("requires an exact subject kind, URI, and CID", () => {
		expect(is(LabelerDefs.assessmentSubjectSchema, subject)).toBe(true);
		expect(is(LabelerDefs.assessmentSubjectSchema, { uri: subject.uri, cid: subject.cid })).toBe(
			false,
		);
		expect(
			is(LabelerDefs.assessmentSubjectSchema, {
				...subject,
				uri: "https://example.com/plugin",
			}),
		).toBe(false);
		expect(
			is(LabelerDefs.assessmentSubjectSchema, {
				...subject,
				cid: "not-a-cid",
			}),
		).toBe(false);
	});

	it("bounds public reason codes and findings", () => {
		const finding: LabelerDefs.PublicFinding = {
			category: "phishing-or-credential-solicitation",
			reasonCode: "phishing-review",
			summary: "Link behavior requires operator review.",
		};

		expect(is(LabelerDefs.publicFindingSchema, finding)).toBe(true);
		expect(
			is(LabelerDefs.publicAssessmentSchema, {
				...assessment,
				reasonCodes: Array.from({ length: 33 }).fill("review-required"),
			}),
		).toBe(false);
		expect(
			is(LabelerDefs.publicFindingSchema, {
				...finding,
				summary: "x".repeat(513),
			}),
		).toBe(false);
	});

	it("publishes the moderation package's finding categories", () => {
		expect(labelerDefsLexicon.defs.publicFinding.properties.category.knownValues).toEqual(
			MODERATION_FINDING_CATEGORIES,
		);
	});

	it("validates a public manual decision without operator-private fields", () => {
		const blocked: LabelerDefs.PublicAssessment = {
			...assessment,
			state: "blocked",
			reasonCodes: ["operator-blocked"],
			labels: [{ ...label, val: "listing-blocked" }],
			manualDecision: {
				outcome: "blocked",
				reasonCode: "operator-blocked",
				decidedAt: "2026-08-20T13:00:00Z",
			},
		};

		expect(is(LabelerDefs.publicAssessmentSchema, blocked)).toBe(true);
	});

	it("validates public query parameters and pagination bounds", () => {
		const current: LabelerGetCurrentAssessment.$params = subject;
		const list: LabelerListAssessments.$params = {
			kind: "profile",
			uri: subject.uri,
			cid: subject.cid,
			state: "review",
			limit: 50,
		};

		expect(is(LabelerGetAssessment.mainSchema.params, { id: assessment.id })).toBe(true);
		expect(is(LabelerGetCurrentAssessment.mainSchema.params, current)).toBe(true);
		expect(is(LabelerListAssessments.mainSchema.params, list)).toBe(true);
		expect(is(LabelerGetAssessment.mainSchema.params, { id: "" })).toBe(false);
		expect(is(LabelerListAssessments.mainSchema.params, { limit: 101 })).toBe(false);
		expect(is(LabelerListAssessments.mainSchema.params, { cursor: "x".repeat(1025) })).toBe(false);
	});
});

describe("labeler policy lexicon", () => {
	it("describes metadata-only subjects, model versions, and standard label effects", () => {
		const policy: LabelerGetPolicy.$output = {
			schemaVersion: 1,
			policyVersion: assessment.policyVersion,
			effectiveAt: "2026-08-20T00:00:00Z",
			labelerDid: assessment.src,
			assessmentSchemaVersion: 1,
			parserVersion: assessment.parserVersion,
			supportedSubjects: [
				{ kind: "profile", collection: NSID.packageProfile },
				{ kind: "release", collection: NSID.packageRelease },
			],
			reasonCodes: [
				{
					code: "incomplete-coverage",
					description: "A required metadata coverage stage did not complete.",
				},
			],
			labels: [
				{
					value: "listing-passed",
					officialEffect: "eligible",
					subjectKinds: ["profile", "release"],
					issuanceModes: ["automated", "reviewer"],
				},
			],
			models: [model],
			publicApi: {
				baseUrl: "https://labels.emdashcms.com/xrpc/",
				getAssessmentNsid: NSID.labelerGetAssessment,
				getCurrentAssessmentNsid: NSID.labelerGetCurrentAssessment,
				listAssessmentsNsid: NSID.labelerListAssessments,
				getPolicyNsid: NSID.labelerGetPolicy,
			},
		};
		const listed: LabelerListAssessments.$output = { assessments: [assessment] };

		expect(is(LabelerGetPolicy.mainSchema.output.schema, policy)).toBe(true);
		expect(is(LabelerListAssessments.mainSchema.output.schema, listed)).toBe(true);
		expect(is(LabelerGetPolicy.mainSchema.output.schema, { ...policy, schemaVersion: 2 })).toBe(
			false,
		);
	});
});
