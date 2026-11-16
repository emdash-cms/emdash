import { describe, expect, it } from "vitest";

import exampleRuleset from "../code-rules/example-ruleset.json";
import {
	clearCodeRulesetCache,
	createR2CodeRulesetSource,
	type CodeRulesetBucket,
} from "../src/code/ruleset-source.js";
import { parseCodeRuleset } from "../src/code/ruleset.js";
import { loadExampleRuleset } from "./code-fixtures.js";

function rule(overrides: Record<string, unknown>) {
	return {
		schemaVersion: 1,
		rulesetId: "test",
		version: "1",
		rules: [
			{
				kind: "text",
				id: "rule-a",
				category: "unsafe-code",
				severity: "low",
				confidence: 0.5,
				summary: "Example.",
				pattern: "x",
				...overrides,
			},
		],
	};
}

describe("code ruleset schema", () => {
	it("accepts the committed example ruleset and applies file defaults", async () => {
		const { ruleset, sha256 } = await loadExampleRuleset();
		expect(ruleset).toMatchObject({ rulesetId: "emdash-example", version: "2026-11-16.1" });
		expect(sha256).toMatch(/^[a-f0-9]{64}$/);
		expect(ruleset.rules.find(({ id }) => id === "js-dynamic-evaluation")).toMatchObject({
			kind: "ast",
			files: ["*.js"],
		});
	});

	it.each([
		["an unsupported schema version", { ...exampleRuleset, schemaVersion: 2 }, /schemaVersion/],
		["an unknown top-level field", { ...exampleRuleset, extra: true }, /unsupported field: extra/],
		["an unknown rule field", rule({ action: "block" }), /unsupported field: action/],
		["an unknown category", rule({ category: "malware" }), /category/],
		["an unknown severity", rule({ severity: "severe" }), /severity/],
		["an out-of-range confidence", rule({ confidence: 2 }), /confidence/],
		["an invalid regular expression", rule({ pattern: "(" }), /not a valid regular expression/],
		["an unsupported regex flag", rule({ flags: "g" }), /flags/],
		["an unknown rule kind", rule({ kind: "script" }), /kind/],
		["a path-like file pattern", rule({ files: ["../secret"] }), /malformed/],
	])("rejects %s", (_name, value, message) => {
		expect(() => parseCodeRuleset(value)).toThrow(message);
	});

	it("rejects duplicate rule ids", () => {
		const value = rule({});
		value.rules.push({ ...value.rules[0]! });
		expect(() => parseCodeRuleset(value)).toThrow(/duplicated: rule-a/);
	});

	it("rejects an AST rule with an unknown match type", () => {
		const value = rule({ kind: "ast", match: { type: "regex" } });
		delete (value.rules[0] as { pattern?: string }).pattern;
		expect(() => parseCodeRuleset(value)).toThrow(/match.type/);
	});
});

describe("R2 code ruleset source", () => {
	function bucket(initial: string) {
		const state = { body: initial, etag: "etag-1", gets: 0 };
		const binding: CodeRulesetBucket = {
			async get() {
				state.gets += 1;
				return state.body === ""
					? null
					: { size: state.body.length, etag: state.etag, text: async () => state.body };
			},
		};
		return { state, binding };
	}

	it("caches the parsed ruleset per isolate until the cache window ends", async () => {
		clearCodeRulesetCache();
		let now = 0;
		const { state, binding } = bucket(JSON.stringify(exampleRuleset));
		const source = createR2CodeRulesetSource(binding, "cache-window.json", () => now);
		const first = await source.load();
		expect(await source.load()).toBe(first);
		expect(state.gets).toBe(1);

		now = 6 * 60 * 1_000;
		expect(await source.load()).toBe(first);
		expect(state.gets).toBe(2);

		state.body = JSON.stringify({ ...exampleRuleset, version: "2026-11-17.1" });
		state.etag = "etag-2";
		now = 12 * 60 * 1_000;
		expect((await source.load()).ruleset.version).toBe("2026-11-17.1");
	});

	it("fails closed when the ruleset object is missing or invalid", async () => {
		clearCodeRulesetCache();
		await expect(
			createR2CodeRulesetSource(bucket("").binding, "missing.json").load(),
		).rejects.toThrow(/missing/);
		await expect(
			createR2CodeRulesetSource(bucket("{").binding, "invalid.json").load(),
		).rejects.toThrow(/not valid JSON/);
	});
});
