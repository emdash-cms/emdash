import { describe, expect, it } from "vitest";

import type { NormalizedFinding } from "../src/findings.js";
import { resolvePolicyOutcome } from "../src/policy-resolver.js";
import { MODERATION_POLICY, parseModerationPolicy } from "../src/policy.js";

function finding(overrides: Partial<NormalizedFinding> & { category: string }): NormalizedFinding {
	return {
		source: "deterministic",
		severity: "medium",
		title: "test finding",
		publicSummary: "test finding",
		privateDetail: "test finding detail",
		evidenceRefs: [],
		...overrides,
	};
}

describe("resolvePolicyOutcome: blocking", () => {
	it("blocks on a deterministic finding at any severity", () => {
		const outcome = resolvePolicyOutcome(
			[finding({ source: "deterministic", category: "undeclared-access", severity: "low" })],
			MODERATION_POLICY,
		);
		expect(outcome.toState).toBe("blocked");
		expect(outcome.labels).toEqual([
			{ val: "undeclared-access", findingCategory: "undeclared-access", severity: "low" },
		]);
	});

	it("blocks on a critical model finding but not a high-severity one", () => {
		const critical = resolvePolicyOutcome(
			[finding({ source: "model", category: "malware", severity: "critical" })],
			MODERATION_POLICY,
		);
		expect(critical.toState).toBe("blocked");

		const high = resolvePolicyOutcome(
			[finding({ source: "model", category: "malware", severity: "high" })],
			MODERATION_POLICY,
		);
		expect(high.toState).toBe("passed");
		expect(high.labels).toEqual([{ val: "assessment-passed" }]);
	});

	it("blocks on a critical image finding", () => {
		const outcome = resolvePolicyOutcome(
			[finding({ source: "image", category: "impersonation", severity: "critical" })],
			MODERATION_POLICY,
		);
		expect(outcome.toState).toBe("blocked");
	});

	it("never blocks or labels a history finding, regardless of category or severity", () => {
		const outcome = resolvePolicyOutcome(
			[finding({ source: "history", category: "malware", severity: "critical" })],
			MODERATION_POLICY,
		);
		expect(outcome.toState).toBe("passed");
		expect(outcome.labels).toEqual([{ val: "assessment-passed" }]);
	});
});

describe("resolvePolicyOutcome: warnings", () => {
	it("warns on a low-severity model finding and still issues assessment-passed", () => {
		const outcome = resolvePolicyOutcome(
			[finding({ source: "model", category: "low-quality", severity: "info" })],
			MODERATION_POLICY,
		);
		expect(outcome.toState).toBe("warned");
		expect(outcome.labels).toEqual([
			{ val: "low-quality", findingCategory: "low-quality", severity: "info" },
			{ val: "assessment-passed" },
		]);
	});

	it("passes and warns at the same time when only a warning finding is present", () => {
		const outcome = resolvePolicyOutcome(
			[finding({ category: "obfuscated-code", severity: "medium" })],
			MODERATION_POLICY,
		);
		expect(outcome.toState).toBe("warned");
		expect(outcome.labels.map((l) => l.val)).toEqual(["obfuscated-code", "assessment-passed"]);
	});
});

describe("resolvePolicyOutcome: blocked outcomes still carry their warnings", () => {
	it("issues warning labels alongside blocking labels, with no assessment-passed", () => {
		const outcome = resolvePolicyOutcome(
			[
				finding({ source: "deterministic", category: "malware", severity: "critical" }),
				finding({ source: "model", category: "obfuscated-code", severity: "medium" }),
			],
			MODERATION_POLICY,
		);
		expect(outcome.toState).toBe("blocked");
		expect(outcome.labels.map((l) => l.val)).toEqual(["malware", "obfuscated-code"]);
	});
});

describe("resolvePolicyOutcome: dedup and severity aggregation", () => {
	it("dedupes two findings citing the same blocking category into one label", () => {
		const outcome = resolvePolicyOutcome(
			[
				finding({ source: "deterministic", category: "malware", severity: "critical" }),
				finding({ source: "model", category: "malware", severity: "critical" }),
			],
			MODERATION_POLICY,
		);
		expect(outcome.labels).toEqual([
			{ val: "malware", findingCategory: "malware", severity: "critical" },
		]);
	});

	it("carries the highest severity among findings that dedupe into one warning label", () => {
		const outcome = resolvePolicyOutcome(
			[
				finding({ category: "obfuscated-code", severity: "low" }),
				finding({ category: "obfuscated-code", severity: "high" }),
			],
			MODERATION_POLICY,
		);
		expect(outcome.labels[0]).toEqual({
			val: "obfuscated-code",
			findingCategory: "obfuscated-code",
			severity: "high",
		});
	});
});

describe("resolvePolicyOutcome: issuance-rule filter", () => {
	it("produces no label for a finding citing a block category without automated release issuance", () => {
		const policy = parseModerationPolicy({
			policyVersion: "test",
			labelerDid: "did:web:example",
			labels: [
				{
					value: "reviewer-only-block",
					category: "automated-block",
					officialEffect: "block",
					subjectRules: [{ subject: "release", cidRule: "required", issuanceModes: ["reviewer"] }],
				},
			],
		});
		const outcome = resolvePolicyOutcome(
			[finding({ source: "deterministic", category: "reviewer-only-block", severity: "critical" })],
			policy,
		);
		expect(outcome.toState).toBe("passed");
		expect(outcome.labels).toEqual([{ val: "assessment-passed" }]);
	});
});

describe("resolvePolicyOutcome: no findings", () => {
	it("passes with only assessment-passed", () => {
		const outcome = resolvePolicyOutcome([], MODERATION_POLICY);
		expect(outcome.toState).toBe("passed");
		expect(outcome.labels).toEqual([{ val: "assessment-passed" }]);
	});
});

describe("resolvePolicyOutcome: determinism", () => {
	it("orders labels blocking-first, then warnings, then assessment-passed, in first-citation order across repeated runs", () => {
		const findings = [
			finding({ source: "model", category: "obfuscated-code", severity: "low" }),
			finding({ source: "deterministic", category: "supply-chain-compromise", severity: "high" }),
			finding({ source: "deterministic", category: "malware", severity: "critical" }),
			finding({ source: "model", category: "privacy-risk", severity: "medium" }),
		];
		const expected = [
			{
				val: "supply-chain-compromise",
				findingCategory: "supply-chain-compromise",
				severity: "high",
			},
			{ val: "malware", findingCategory: "malware", severity: "critical" },
			{ val: "obfuscated-code", findingCategory: "obfuscated-code", severity: "low" },
			{ val: "privacy-risk", findingCategory: "privacy-risk", severity: "medium" },
		];
		for (let i = 0; i < 5; i++) {
			const outcome = resolvePolicyOutcome(findings, MODERATION_POLICY);
			expect(outcome.labels).toEqual(expected);
		}
	});
});
