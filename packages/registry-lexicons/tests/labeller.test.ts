import { is } from "@atcute/lexicons/validations";
import { describe, expect, it } from "vitest";

import {
	LabellerDefs,
	LabellerGetAssessment,
	LabellerGetCurrentAssessment,
	LabellerGetPolicy,
	LabellerListAssessments,
	NSID,
} from "../src/index.js";

const assessment: LabellerDefs.PublicAssessment = {
	id: "asmt_01J2Q5Y7V8N9M0K1H2G3F4E5D6",
	src: "did:web:labels.emdashcms.com",
	subject: {
		uri: "at://did:plc:publisher/com.emdashcms.experimental.package.release/gallery:1.0.0",
		cid: "bafyreiaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
	},
	state: "passed",
	summary: "No blocking condition found.",
	coverage: {
		code: "complete",
		metadata: "complete",
		images: "not-present",
		dependencies: "complete",
	},
	labels: [{ val: "assessment-passed", active: true, issuedAt: "2026-07-10T12:00:00Z" }],
	policyVersion: "2026-07-10",
	assessmentSchemaVersion: 1,
	scannerVersions: [{ scanner: "dependency", version: "1.0.0" }],
	createdAt: "2026-07-10T12:00:00Z",
	completedAt: "2026-07-10T12:01:00Z",
	reconsiderationUrl: "https://emdashcms.com/plugin-moderation/reconsideration",
};

describe("labeller Lexicons", () => {
	it("validates the public assessment and current-assessment output", () => {
		const output: LabellerGetCurrentAssessment.$output = {
			src: assessment.src,
			subject: assessment.subject,
			current: assessment,
			activeLabels: [
				{
					ver: 1,
					src: assessment.src,
					uri: assessment.subject.uri,
					cid: assessment.subject.cid,
					val: "assessment-passed",
					cts: assessment.completedAt,
				},
			],
		};

		expect(is(LabellerDefs.publicAssessmentSchema, assessment)).toBe(true);
		expect(
			is(LabellerDefs.publicAssessmentSchema, {
				...assessment,
				subject: { ...assessment.subject, uri: "did:web:publisher.example.com" },
			}),
		).toBe(false);
		expect(is(LabellerGetCurrentAssessment.mainSchema.output.schema, output)).toBe(true);
	});

	it("validates a publisher-level manual action with a DID subject", () => {
		const action: LabellerDefs.PublicManualAction = {
			id: "action_01J2Q5Y7V8N9M0K1H2G3F4E5D6",
			src: assessment.src,
			subject: { uri: "did:web:publisher.example.com" },
			type: "emergency-takedown",
			summary: "The publisher identity is believed to be compromised.",
			labels: [
				{
					val: "publisher-compromised",
					active: true,
					issuedAt: "2026-07-10T12:00:00Z",
				},
			],
			createdAt: "2026-07-10T12:00:00Z",
		};

		expect(is(LabellerDefs.publicManualActionSchema, action)).toBe(true);
	});

	it("validates query parameters and rejects schema-invalid inputs", () => {
		const current: LabellerGetCurrentAssessment.$params = {
			uri: assessment.subject.uri,
			cid: assessment.subject.cid,
			src: assessment.src,
		};
		const list: LabellerListAssessments.$params = { state: "passed", limit: 50 };

		expect(is(LabellerGetCurrentAssessment.mainSchema.params, current)).toBe(true);
		expect(is(LabellerListAssessments.mainSchema.params, list)).toBe(true);
		expect(
			is(LabellerGetCurrentAssessment.mainSchema.params, { ...current, src: "not-a-did" }),
		).toBe(false);
		expect(
			is(LabellerGetCurrentAssessment.mainSchema.params, {
				...current,
				uri: "https://example.com/release",
			}),
		).toBe(false);
		expect(is(LabellerListAssessments.mainSchema.params, { cursor: "a".repeat(1025) })).toBe(false);
		expect(is(LabellerListAssessments.mainSchema.params, { limit: 101 })).toBe(false);
	});

	it("validates endpoint output shapes and the fixed-field policy document", () => {
		const list: LabellerListAssessments.$output = { assessments: [assessment] };
		const policy: LabellerGetPolicy.$output = {
			schemaVersion: 1,
			policyVersion: "2026-07-10",
			effectiveAt: "2026-07-10T00:00:00Z",
			labellerDid: assessment.src,
			assessmentSchemaVersion: 1,
			supportedSubjects: {
				publisher: { kind: "did" },
				packageCollections: [NSID.packageProfile],
				releaseCollections: [NSID.packageRelease],
			},
			reasonCodes: [{ code: "missing-assessment-pass", description: "No active pass label." }],
			labels: [],
			overrideRule: {
				subject: "release",
				cidRule: "required",
				reviewerLabels: ["assessment-passed", "assessment-overridden"],
				requireSameSource: true,
				requireAtomicIssuance: true,
			},
			precedence: ["manual-block", "eligible"],
			publicApi: {
				baseUrl: "https://labels.emdashcms.com/xrpc/",
				policyUrl: "https://labels.emdashcms.com/.well-known/emdash-labeler-policy.json",
				getAssessmentNsid: NSID.labellerGetAssessment,
				getCurrentAssessmentNsid: NSID.labellerGetCurrentAssessment,
				listAssessmentsNsid: NSID.labellerListAssessments,
				getPolicyNsid: NSID.labellerGetPolicy,
			},
			contact: {
				reconsiderationUrl: assessment.reconsiderationUrl,
				reconsiderationEmail: "plugin-moderation@emdashcms.com",
			},
			transparency: { modelOutputIsAdvisoryEvidence: true },
		};

		expect(is(LabellerGetAssessment.mainSchema.params, { id: assessment.id })).toBe(true);
		expect(is(LabellerGetAssessment.mainSchema.params, { id: "" })).toBe(false);
		expect(is(LabellerListAssessments.mainSchema.output.schema, list)).toBe(true);
		expect(is(LabellerGetPolicy.mainSchema.output.schema, policy)).toBe(true);
		expect(is(LabellerGetPolicy.mainSchema.output.schema, { ...policy, schemaVersion: 2 })).toBe(
			false,
		);
	});
});
