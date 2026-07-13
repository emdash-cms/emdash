import { describe, expect, it } from "vitest";

import {
	automatedBlockCategories,
	getLabelDefinition,
	MODERATION_POLICY,
	parseModerationPolicy,
} from "../src/policy.js";

describe("moderation policy fixture", () => {
	it("loads the ratified fixture and exposes label lookups", () => {
		expect(MODERATION_POLICY.policyVersion).toBe("2026-07-10.experimental.3");
		expect(getLabelDefinition("malware")).toMatchObject({
			value: "malware",
			category: "automated-block",
		});
		expect(getLabelDefinition("assessment-overridden")?.subjectRules[0]?.issuanceModes).toEqual([
			"reviewer",
		]);
		expect(getLabelDefinition("not-a-real-label")).toBeUndefined();
	});

	it("derives the automated-block category set from the fixture, not a hardcoded list", () => {
		const categories = automatedBlockCategories(MODERATION_POLICY);
		expect(categories.has("malware")).toBe(true);
		expect(categories.has("impersonation")).toBe(true);
		expect(categories.has("low-quality")).toBe(false);
	});
});

describe("strict policy parsing", () => {
	it("throws on missing required top-level fields", () => {
		expect(() => parseModerationPolicy({})).toThrow("policyVersion");
		expect(() => parseModerationPolicy({ policyVersion: "v1" })).toThrow("labelerDid");
		expect(() =>
			parseModerationPolicy({ policyVersion: "v1", labelerDid: "did:web:example" }),
		).toThrow("labels must be a non-empty array");
	});

	it("throws on a malformed label definition", () => {
		const base = { policyVersion: "v1", labelerDid: "did:web:example" };
		expect(() =>
			parseModerationPolicy({ ...base, labels: [{ value: "x", category: "not-a-category" }] }),
		).toThrow("category is invalid");
		expect(() =>
			parseModerationPolicy({
				...base,
				labels: [{ value: "x", category: "warning", officialEffect: "warn", subjectRules: [] }],
			}),
		).toThrow("subjectRules must be a non-empty array");
		expect(() =>
			parseModerationPolicy({
				...base,
				labels: [
					{
						value: "x",
						category: "warning",
						officialEffect: "warn",
						subjectRules: [
							{ subject: "not-a-subject", cidRule: "required", issuanceModes: ["automated"] },
						],
					},
				],
			}),
		).toThrow("subject is invalid");
		expect(() =>
			parseModerationPolicy({
				...base,
				labels: [
					{
						value: "x",
						category: "warning",
						officialEffect: "warn",
						subjectRules: [{ subject: "release", cidRule: "required", issuanceModes: [] }],
					},
				],
			}),
		).toThrow("issuanceModes must be a non-empty array");
	});

	it("throws on a duplicate label value", () => {
		const base = { policyVersion: "v1", labelerDid: "did:web:example" };
		const label = {
			value: "dup",
			category: "warning",
			officialEffect: "warn",
			subjectRules: [{ subject: "release", cidRule: "required", issuanceModes: ["automated"] }],
		};
		expect(() => parseModerationPolicy({ ...base, labels: [label, label] })).toThrow(
			"duplicates value",
		);
	});

	it("throws on duplicate subject rules within one label", () => {
		const base = { policyVersion: "v1", labelerDid: "did:web:example" };
		expect(() =>
			parseModerationPolicy({
				...base,
				labels: [
					{
						value: "x",
						category: "warning",
						officialEffect: "warn",
						subjectRules: [
							{ subject: "release", cidRule: "required", issuanceModes: ["reviewer"] },
							{ subject: "release", cidRule: "required", issuanceModes: ["automated"] },
						],
					},
				],
			}),
		).toThrow("duplicate subject");
	});
});
