import { describe, expect, it } from "vitest";

import type { Assessment } from "../src/assessment-store.js";
import {
	derivePublicState,
	toPublicAssessment,
	type PublicAssessmentView,
} from "../src/public-assessment.js";

const BASE_ASSESSMENT: Assessment = {
	id: "asmt_00000000000000000000000001",
	runKey: "internal-run-key-should-never-leak",
	uri: "at://did:plc:publisher000000000000000000/com.emdashcms.experimental.package.release/demo:1.0.0",
	cid: "bafkreif4oaymum54i5qefbwoblrt5zasfjhpyhyvacpseqtehi3queew5m",
	artifactId: null,
	artifactChecksum: null,
	state: "passed",
	trigger: "initial",
	triggerId: "initial:internal-trigger-id-should-never-leak",
	policyVersion: "2026-07-10.experimental.2",
	modelId: null,
	promptHash: null,
	publicSummary: "no blocking condition found",
	coverageJson: '{"code":"complete","images":"not-present","metadata":"complete"}',
	supersedesAssessmentId: null,
	startedAt: "2026-07-11T00:00:00.000Z",
	completedAt: "2026-07-11T00:05:00.000Z",
	createdAt: "2026-07-11T00:00:00.000Z",
};

function view(
	overrides: Partial<Assessment> = {},
	opts: Partial<Parameters<typeof toPublicAssessment>[1]> = {},
) {
	return toPublicAssessment(
		{ ...BASE_ASSESSMENT, ...overrides },
		{
			labelerDid: "did:web:labels.emdashcms.com",
			publicState: "passed",
			labels: [],
			reconsiderationUrl: "https://emdashcms.com/plugin-moderation/reconsideration",
			...opts,
		},
	);
}

describe("derivePublicState", () => {
	it("maps pre-decision and terminal-inconclusive states to not-public (null)", () => {
		for (const state of ["observed", "verifying", "stale", "cancelled"] as const) {
			expect(derivePublicState(state, false)).toBeNull();
			expect(derivePublicState(state, true)).toBeNull();
		}
	});

	it("maps running and pending to the public pending state", () => {
		expect(derivePublicState("running", false)).toBe("pending");
		expect(derivePublicState("pending", false)).toBe("pending");
	});

	it("maps each decision outcome to itself when not superseded", () => {
		expect(derivePublicState("passed", false)).toBe("passed");
		expect(derivePublicState("warned", false)).toBe("warned");
		expect(derivePublicState("blocked", false)).toBe("blocked");
		expect(derivePublicState("error", false)).toBe("error");
	});

	it("maps every decision outcome to superseded when isSuperseded is true", () => {
		expect(derivePublicState("passed", true)).toBe("superseded");
		expect(derivePublicState("warned", true)).toBe("superseded");
		expect(derivePublicState("blocked", true)).toBe("superseded");
		expect(derivePublicState("error", true)).toBe("superseded");
	});
});

describe("toPublicAssessment: coverage parsing", () => {
	it("parses a well-formed coverage blob", () => {
		expect(view().coverage).toEqual({
			code: "complete",
			images: "not-present",
			metadata: "complete",
		});
	});

	it("falls back to all-unavailable on malformed JSON without throwing", () => {
		expect(view({ coverageJson: "{not json" }).coverage).toEqual({
			code: "unavailable",
			images: "unavailable",
			metadata: "unavailable",
		});
	});

	it("falls back to all-unavailable when a value is outside the known set", () => {
		expect(
			view({ coverageJson: '{"code":"complete","images":"bogus","metadata":"complete"}' }).coverage,
		).toEqual({
			code: "unavailable",
			images: "unavailable",
			metadata: "unavailable",
		});
	});

	it("falls back to all-unavailable when a required key is missing", () => {
		expect(view({ coverageJson: '{"code":"complete"}' }).coverage).toEqual({
			code: "unavailable",
			images: "unavailable",
			metadata: "unavailable",
		});
	});
});

describe("toPublicAssessment: field presence", () => {
	it("omits artifact when artifactChecksum is null and includes it, with an optional id, when present", () => {
		expect(view().artifact).toBeUndefined();
		expect(view({ artifactChecksum: "sha256:abc" }).artifact).toEqual({ checksum: "sha256:abc" });
		expect(view({ artifactId: "artifact-1", artifactChecksum: "sha256:abc" }).artifact).toEqual({
			id: "artifact-1",
			checksum: "sha256:abc",
		});
	});

	it("omits model when modelId or promptHash is null and includes it when both are present", () => {
		expect(view().model).toBeUndefined();
		expect(view({ modelId: "llama-4" }).model).toBeUndefined();
		expect(view({ modelId: "llama-4", promptHash: "prompt-hash-1" }).model).toEqual({
			provider: "workers-ai",
			modelId: "llama-4",
			promptVersion: "prompt-hash-1",
		});
	});

	it("omits completedAt and supersedesAssessmentId when null, includes them when present", () => {
		const pending = view({ completedAt: null }, { publicState: "pending" });
		expect(pending.completedAt).toBeUndefined();
		expect(pending.supersedesAssessmentId).toBeUndefined();
		expect(
			view({ supersedesAssessmentId: "asmt_previous00000000000000" }).supersedesAssessmentId,
		).toBe("asmt_previous00000000000000");
	});

	it("substitutes a stable fallback summary when publicSummary is null or empty, per public state", () => {
		expect(view({ publicSummary: null }, { publicState: "pending" }).summary).toBe(
			"Assessment pending.",
		);
		expect(view({ publicSummary: "" }, { publicState: "error" }).summary).toBe(
			"Assessment failed to complete.",
		);
		expect(view({ publicSummary: "custom summary" }).summary).toBe("custom summary");
	});

	it("passes labels through as given", () => {
		const labels = [
			{ val: "assessment-passed", active: true, issuedAt: "2026-07-11T00:00:00.000Z" },
		];
		expect(view({}, { labels }).labels).toEqual(labels);
	});
});

describe("public/private serializer boundary", () => {
	it("never leaks internal-only stored fields in the serialized JSON", () => {
		const serialized = JSON.stringify(view({ runKey: BASE_ASSESSMENT.runKey }));
		expect(serialized).not.toContain("internal-run-key-should-never-leak");
		expect(serialized).not.toContain("internal-trigger-id-should-never-leak");
		expect(serialized).not.toContain("runKey");
		expect(serialized).not.toContain("triggerId");
		expect(serialized).not.toContain("promptHash");
	});

	it("type-rejects a raw Assessment passed directly as a PublicAssessmentView", () => {
		// Compile-time assertion: `Assessment` has no `src`/`subject`/`summary`/
		// `coverage`/`labels`/`assessmentSchemaVersion`/`reconsiderationUrl` —
		// required PublicAssessmentView fields the raw row simply doesn't
		// carry. If this stops erroring, the boundary has been weakened
		// (e.g. by widening PublicAssessmentView).
		// @ts-expect-error a raw Assessment row must not satisfy the public view
		const rejected: PublicAssessmentView = BASE_ASSESSMENT;
		expect(rejected).toBeDefined();
	});
});
