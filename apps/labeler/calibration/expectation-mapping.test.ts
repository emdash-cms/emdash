import { describe, expect, it } from "vitest";

import { MODERATION_POLICY } from "../src/policy.js";
import { mapLegacyExpectation, parseExpectation } from "./fixture-loader.js";

const policy = MODERATION_POLICY;

describe("mapLegacyExpectation", () => {
	it("maps a clean pass to passed with no categories", () => {
		expect(mapLegacyExpectation({ verdict: "pass", categories: [] }, policy)).toEqual({
			code: { toState: "passed", categories: [] },
		});
	});

	it("maps a fail on a block category to blocked", () => {
		expect(
			mapLegacyExpectation({ verdict: "fail", categories: ["credential-harvesting"] }, policy),
		).toEqual({ code: { toState: "blocked", categories: ["credential-harvesting"] } });
	});

	it("maps a fail whose only category is a warning label to review", () => {
		const result = mapLegacyExpectation({ verdict: "fail", categories: ["obfuscation"] }, policy);
		expect(result.code?.review).toBe(true);
		expect(result.code?.toState).toBeUndefined();
	});

	it("marks an unmapped legacy category as review", () => {
		const result = mapLegacyExpectation(
			{ verdict: "fail", categories: ["resource-abuse"] },
			policy,
		);
		expect(result.code?.review).toBe(true);
		expect(result.code?.note).toMatch(/resource-abuse/);
	});

	it("marks a warn verdict as review", () => {
		const result = mapLegacyExpectation(
			{ verdict: "warn", categories: ["data-exfiltration"] },
			policy,
		);
		expect(result.code?.review).toBe(true);
	});

	it("blocks when at least one category is a block label in a mixed fail", () => {
		expect(
			mapLegacyExpectation(
				{ verdict: "fail", categories: ["data-exfiltration", "obfuscation"] },
				policy,
			).code,
		).toEqual({ toState: "blocked", categories: ["data-exfiltration"] });
	});

	it("derives an image expectation and flags an unmapped image category", () => {
		const result = mapLegacyExpectation(
			{ verdict: "pass", categories: [], images: "fail", imageCategories: ["nsfw"] },
			policy,
		);
		expect(result.code).toEqual({ toState: "passed", categories: [] });
		expect(result.image?.review).toBe(true);
		expect(result.image?.note).toMatch(/nsfw/);
	});
});

describe("parseExpectation", () => {
	it("parses a code+image expectation file", () => {
		const parsed = parseExpectation({
			expect: {
				code: { toState: "blocked", categories: ["data-exfiltration"] },
				image: { review: true, note: "needs eyes" },
			},
		});
		expect(parsed.code).toEqual({ toState: "blocked", categories: ["data-exfiltration"] });
		expect(parsed.image).toEqual({ review: true, note: "needs eyes" });
	});

	it("rejects a missing expect key", () => {
		expect(() => parseExpectation({})).toThrow(/expect/);
	});

	it("rejects an invalid toState", () => {
		expect(() => parseExpectation({ expect: { code: { toState: "nope" } } })).toThrow(/toState/);
	});

	it("rejects toState 'warned' (the warn-zone must be expressed as review)", () => {
		expect(() => parseExpectation({ expect: { code: { toState: "warned" } } })).toThrow(
			/passed.*blocked.*review/,
		);
	});
});
