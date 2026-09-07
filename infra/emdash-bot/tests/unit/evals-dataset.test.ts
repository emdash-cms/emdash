import { describe, expect, test } from "vitest";

import {
	checkoutRefFor,
	loadDataset,
	parseDataset,
	resolvePreFixRef,
} from "../../evals/src/dataset.ts";
import type { EvalCase } from "../../evals/src/types.ts";

const SHA_A = "c0c6c72e0a75e9560f204e3780cafb5baf6a9b4b";
const SHA_B = "7554bd3ba81477383d2616df209050cb29e6ad17";

function confirmedRaw(overrides: Record<string, unknown> = {}) {
	return {
		number: 917,
		title: "scheduled posts never publish",
		category: "CONFIRMED_BUG",
		ground_truth: "reproducible on sqlite",
		fixing_pr: 1157,
		difficulty: "medium",
		repro_path: "public site",
		area: "core",
		pre_fix: { merge_commit: SHA_B, parents: [SHA_A] },
		fault_anchors: ["buildStatusCondition"],
		...overrides,
	};
}

function dataset(cases: unknown[]) {
	return { counts: {}, cases };
}

describe("parseDataset", () => {
	test("accepts a well-formed confirmed-bug case", () => {
		const parsed = parseDataset(dataset([confirmedRaw()]));
		expect(parsed.cases).toHaveLength(1);
		expect(parsed.cases[0]?.pre_fix?.parents[0]).toBe(SHA_A);
	});

	test("rejects a fixed confirmed bug missing its pre_fix", () => {
		expect(() => parseDataset(dataset([confirmedRaw({ pre_fix: null })]))).toThrow(
			/without pre_fix/,
		);
	});

	test("accepts an unfixed confirmed bug with no pre_fix", () => {
		const raw = confirmedRaw({ pre_fix: null, fixing_pr: null });
		const parsed = parseDataset(dataset([raw]));
		expect(checkoutRefFor(parsed.cases[0] as EvalCase)).toBe("main");
	});

	test("rejects a confirmed bug with no fault anchors", () => {
		expect(() => parseDataset(dataset([confirmedRaw({ fault_anchors: [] })]))).toThrow(
			/without fault_anchors/,
		);
	});

	test("rejects a negative case that carries a pre_fix", () => {
		expect(() =>
			parseDataset(
				dataset([
					confirmedRaw({ category: "NOT_REPRODUCIBLE", fault_anchors: [], fixing_pr: null }),
				]),
			),
		).toThrow(/must not carry pre_fix/);
	});

	test("rejects a non-40-hex parent SHA", () => {
		expect(() =>
			parseDataset(dataset([confirmedRaw({ pre_fix: { merge_commit: SHA_B, parents: ["abc"] } })])),
		).toThrow();
	});
});

describe("resolvePreFixRef", () => {
	test("computes the pre-fix ref as the merge commit's first parent", () => {
		expect(resolvePreFixRef({ merge_commit: SHA_B, parents: [SHA_A, SHA_B] })).toBe(SHA_A);
	});
});

describe("checkoutRefFor", () => {
	test("a confirmed bug checks out its pre-fix parent", () => {
		const c = parseDataset(dataset([confirmedRaw()])).cases[0] as EvalCase;
		expect(checkoutRefFor(c)).toBe(SHA_A);
	});

	test("a negative case checks out main", () => {
		const raw = confirmedRaw({
			category: "NEEDS_INFO",
			pre_fix: null,
			fault_anchors: [],
			fixing_pr: null,
		});
		const c = parseDataset(dataset([raw])).cases[0] as EvalCase;
		expect(checkoutRefFor(c)).toBe("main");
	});
});

describe("committed dataset.json", () => {
	const ds = loadDataset();

	test("has 26 cases across the three categories", () => {
		expect(ds.cases).toHaveLength(26);
		const byCat = ds.cases.reduce<Record<string, number>>((acc, c) => {
			acc[c.category] = (acc[c.category] ?? 0) + 1;
			return acc;
		}, {});
		expect(byCat).toEqual({ CONFIRMED_BUG: 19, NOT_REPRODUCIBLE: 3, NEEDS_INFO: 4 });
	});

	test("every fixed confirmed bug resolves a 40-hex pre-fix ref equal to its first parent", () => {
		for (const c of ds.cases.filter(
			(x) => x.category === "CONFIRMED_BUG" && x.fixing_pr !== null,
		)) {
			const ref = checkoutRefFor(c);
			expect(ref).toMatch(/^[0-9a-f]{40}$/i);
			expect(ref).toBe(c.pre_fix?.parents[0]);
		}
	});

	test("every unfixed confirmed bug checks out main", () => {
		for (const c of ds.cases.filter(
			(x) => x.category === "CONFIRMED_BUG" && x.fixing_pr === null,
		)) {
			expect(c.pre_fix).toBeNull();
			expect(checkoutRefFor(c)).toBe("main");
		}
	});

	test("every negative case checks out main", () => {
		for (const c of ds.cases.filter((x) => x.category !== "CONFIRMED_BUG")) {
			expect(checkoutRefFor(c)).toBe("main");
		}
	});
});
