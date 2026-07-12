import { describe, expect, it } from "vitest";

import type { PublicFindingView } from "../src/evidence.js";
import {
	allowedFindingCategories,
	FindingValidationError,
	toPublicFindingView,
	validateFinding,
	validateFindings,
	type NormalizedFinding,
} from "../src/findings.js";
import { MODERATION_POLICY, parseModerationPolicy } from "../src/policy.js";

function baseFinding(overrides: Partial<Record<string, unknown>> = {}): Record<string, unknown> {
	return {
		source: "deterministic",
		category: "obfuscated-code",
		severity: "medium",
		title: "test finding",
		publicSummary: "test finding summary",
		privateDetail: "test finding detail with a denylist match",
		evidenceRefs: [],
		...overrides,
	};
}

const ALLOWED_CATEGORIES = allowedFindingCategories(MODERATION_POLICY);
const NO_EVIDENCE = new Set<string>();

describe("allowedFindingCategories", () => {
	it("derives automated-block union warning values from the fixture, excluding eligibility and manual-system", () => {
		expect(ALLOWED_CATEGORIES.has("malware")).toBe(true);
		expect(ALLOWED_CATEGORIES.has("impersonation")).toBe(true);
		expect(ALLOWED_CATEGORIES.has("obfuscated-code")).toBe(true);
		expect(ALLOWED_CATEGORIES.has("low-quality")).toBe(true);
		expect(ALLOWED_CATEGORIES.has("assessment-passed")).toBe(false);
		expect(ALLOWED_CATEGORIES.has("assessment-pending")).toBe(false);
		expect(ALLOWED_CATEGORIES.has("!takedown")).toBe(false);
		expect(ALLOWED_CATEGORIES.has("security-yanked")).toBe(false);
		expect(ALLOWED_CATEGORIES.has("package-disputed")).toBe(false);
	});

	it("changes when the policy changes, rather than staying hardcoded", () => {
		const variant = parseModerationPolicy({
			policyVersion: "variant",
			labelerDid: "did:web:example",
			labels: [
				{
					value: "only-warning",
					category: "warning",
					officialEffect: "warn",
					subjectRules: [{ subject: "release", cidRule: "required", issuanceModes: ["automated"] }],
				},
			],
		});
		const categories = allowedFindingCategories(variant);
		expect(categories.has("only-warning")).toBe(true);
		expect(categories.has("malware")).toBe(false);
	});
});

describe("validateFinding", () => {
	it("passes a valid finding for each FindingSource", () => {
		for (const source of ["deterministic", "capability", "model", "image", "history"]) {
			const finding = validateFinding(baseFinding({ source }), {
				allowedCategories: ALLOWED_CATEGORIES,
				resolvableEvidenceIds: NO_EVIDENCE,
			});
			expect(finding.source).toBe(source);
		}
	});

	it("throws on an unknown category", () => {
		expect(() =>
			validateFinding(baseFinding({ category: "not-a-real-label" }), {
				allowedCategories: ALLOWED_CATEGORIES,
				resolvableEvidenceIds: NO_EVIDENCE,
			}),
		).toThrow(FindingValidationError);
	});

	it("throws on an eligibility or manual-system category, since those are never finding-derived", () => {
		expect(() =>
			validateFinding(baseFinding({ category: "assessment-passed" }), {
				allowedCategories: ALLOWED_CATEGORIES,
				resolvableEvidenceIds: NO_EVIDENCE,
			}),
		).toThrow(FindingValidationError);
		expect(() =>
			validateFinding(baseFinding({ category: "security-yanked" }), {
				allowedCategories: ALLOWED_CATEGORIES,
				resolvableEvidenceIds: NO_EVIDENCE,
			}),
		).toThrow(FindingValidationError);
	});

	it("throws on an invalid severity", () => {
		expect(() =>
			validateFinding(baseFinding({ severity: "catastrophic" }), {
				allowedCategories: ALLOWED_CATEGORIES,
				resolvableEvidenceIds: NO_EVIDENCE,
			}),
		).toThrow(FindingValidationError);
	});

	it("accepts confidence at the boundaries and absent, rejects out-of-range or non-finite", () => {
		for (const confidence of [0, 1, 0.5, undefined]) {
			expect(() =>
				validateFinding(baseFinding({ confidence }), {
					allowedCategories: ALLOWED_CATEGORIES,
					resolvableEvidenceIds: NO_EVIDENCE,
				}),
			).not.toThrow();
		}
		for (const confidence of [1.5, -0.1, Number.NaN, Number.POSITIVE_INFINITY]) {
			expect(() =>
				validateFinding(baseFinding({ confidence }), {
					allowedCategories: ALLOWED_CATEGORIES,
					resolvableEvidenceIds: NO_EVIDENCE,
				}),
			).toThrow(FindingValidationError);
		}
	});

	it("throws when an evidence reference does not resolve to a recorded evidence object", () => {
		expect(() =>
			validateFinding(baseFinding({ evidenceRefs: ["evid_missing"] }), {
				allowedCategories: ALLOWED_CATEGORIES,
				resolvableEvidenceIds: NO_EVIDENCE,
			}),
		).toThrow(FindingValidationError);
	});

	it("passes when every evidence reference resolves", () => {
		const finding = validateFinding(baseFinding({ evidenceRefs: ["evid_01example"] }), {
			allowedCategories: ALLOWED_CATEGORIES,
			resolvableEvidenceIds: new Set(["evid_01example"]),
		});
		expect(finding.evidenceRefs).toEqual(["evid_01example"]);
	});

	it("throws on a blank title", () => {
		expect(() =>
			validateFinding(baseFinding({ title: "   " }), {
				allowedCategories: ALLOWED_CATEGORIES,
				resolvableEvidenceIds: NO_EVIDENCE,
			}),
		).toThrow(FindingValidationError);
	});

	it("throws on an oversized public summary", () => {
		expect(() =>
			validateFinding(baseFinding({ publicSummary: "x".repeat(4097) }), {
				allowedCategories: ALLOWED_CATEGORIES,
				resolvableEvidenceIds: NO_EVIDENCE,
			}),
		).toThrow(FindingValidationError);
	});

	it("bounds affected-file/image and evidence arrays by entry length, count, and non-emptiness", () => {
		const opts = { allowedCategories: ALLOWED_CATEGORIES, resolvableEvidenceIds: NO_EVIDENCE };
		expect(() => validateFinding(baseFinding({ affectedFiles: ["x".repeat(1025)] }), opts)).toThrow(
			FindingValidationError,
		);
		expect(() =>
			validateFinding(baseFinding({ affectedImages: Array.from({ length: 513 }).fill("a") }), opts),
		).toThrow(FindingValidationError);
		expect(() => validateFinding(baseFinding({ affectedFiles: [""] }), opts)).toThrow(
			FindingValidationError,
		);
		const ok = validateFinding(baseFinding({ affectedFiles: ["src/index.ts"] }), opts);
		expect(ok.affectedFiles).toEqual(["src/index.ts"]);
	});

	it("decouples validated arrays from the caller's input array", () => {
		const opts = { allowedCategories: ALLOWED_CATEGORIES, resolvableEvidenceIds: NO_EVIDENCE };
		const affectedFiles = ["src/index.ts"];
		const finding = validateFinding(baseFinding({ affectedFiles }), opts);
		affectedFiles.push("src/mutated.ts");
		expect(finding.affectedFiles).toEqual(["src/index.ts"]);
	});

	it("validates a typed sourceMetadata shape", () => {
		const withTool = validateFinding(
			baseFinding({ sourceMetadata: { kind: "tool", tool: "semgrep", version: "1.2.3" } }),
			{ allowedCategories: ALLOWED_CATEGORIES, resolvableEvidenceIds: NO_EVIDENCE },
		);
		expect(withTool.sourceMetadata).toEqual({ kind: "tool", tool: "semgrep", version: "1.2.3" });

		const withModel = validateFinding(
			baseFinding({
				sourceMetadata: { kind: "model", modelId: "claude-opus-4", promptVersion: "v3" },
			}),
			{ allowedCategories: ALLOWED_CATEGORIES, resolvableEvidenceIds: NO_EVIDENCE },
		);
		expect(withModel.sourceMetadata).toEqual({
			kind: "model",
			modelId: "claude-opus-4",
			promptVersion: "v3",
		});

		expect(() =>
			validateFinding(baseFinding({ sourceMetadata: { kind: "unknown-kind" } }), {
				allowedCategories: ALLOWED_CATEGORIES,
				resolvableEvidenceIds: NO_EVIDENCE,
			}),
		).toThrow(FindingValidationError);
	});
});

describe("validateFindings", () => {
	it("validates every finding and returns them in order", () => {
		const findings = validateFindings(
			[baseFinding({ category: "obfuscated-code" }), baseFinding({ category: "malware" })],
			{ allowedCategories: ALLOWED_CATEGORIES, resolvableEvidenceIds: NO_EVIDENCE },
		);
		expect(findings.map((f) => f.category)).toEqual(["obfuscated-code", "malware"]);
	});

	it("throws on the first bad element, naming its index", () => {
		expect(() =>
			validateFindings(
				[baseFinding(), baseFinding({ category: "not-a-real-label" }), baseFinding()],
				{ allowedCategories: ALLOWED_CATEGORIES, resolvableEvidenceIds: NO_EVIDENCE },
			),
		).toThrow("findings[1]");
	});
});

describe("public projection", () => {
	const FINDING: NormalizedFinding = {
		source: "model",
		category: "malware",
		severity: "critical",
		confidence: 0.9,
		title: "known malicious pattern",
		publicSummary: "the bundle matched a known malicious pattern",
		privateDetail: "sha256 abc123 matches denylist entry NASTY-001",
		evidenceRefs: ["evid_01example"],
		sourceMetadata: { kind: "model", modelId: "claude-opus-4", promptVersion: "v3" },
	};

	it("carries no privateDetail or evidenceRefs in the public view", () => {
		const publicView = toPublicFindingView(FINDING, "find_01example", "asmt_01example");
		expect(publicView).not.toHaveProperty("privateDetail");
		expect(publicView).not.toHaveProperty("evidenceRefs");
		expect(publicView).toEqual({
			id: "find_01example",
			assessmentId: "asmt_01example",
			category: "malware",
			severity: "critical",
			title: "known malicious pattern",
			publicSummary: "the bundle matched a known malicious pattern",
		});
	});

	it("does not leak private detail into the serialized public payload", () => {
		const publicView = toPublicFindingView(FINDING, "find_01example", "asmt_01example");
		expect(JSON.stringify(publicView)).not.toContain("denylist");
	});

	it("type-rejects a NormalizedFinding passed directly to the public serializer", () => {
		// @ts-expect-error a normalized finding carries privateDetail/evidenceRefs and must not satisfy the public view
		const rejected: PublicFindingView = FINDING;
		expect(rejected).toBeDefined();
	});
});
