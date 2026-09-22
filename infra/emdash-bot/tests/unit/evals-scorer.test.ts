import { describe, expect, test } from "vitest";

import {
	outcomeFromResult,
	type AgentResult as RouterAgentResult,
} from "../../.flue/lib/router.js";
import { diagnoseOutcome, scoreCase, summarize } from "../../evals/src/scorer.ts";
import type { EvalCase, ReportedResult } from "../../evals/src/types.ts";

const SHA = "c0c6c72e0a75e9560f204e3780cafb5baf6a9b4b";

function makeCase(overrides: Partial<EvalCase> = {}): EvalCase {
	return {
		number: 917,
		title: "t",
		category: "CONFIRMED_BUG",
		ground_truth: "g",
		fixing_pr: 1157,
		difficulty: "medium",
		repro_path: "public site",
		area: "core",
		pre_fix: { merge_commit: SHA, parents: [SHA] },
		fault_anchors: ["buildStatusCondition", "datetime"],
		...overrides,
	};
}

function reported(result: ReportedResult["result"], ok = true, pushed = false): ReportedResult {
	return { result, ok, pushed, runId: "eval-run", publication: null, verification: [] };
}

describe("diagnoseOutcome mirrors the machine's outcomeFromResult (diagnose mode)", () => {
	const cases: ReportedResult[] = [
		reported({ summary: "x" }, false),
		reported({ skipped: true, summary: "x" }),
		reported({ verdict: "intended-behavior", summary: "x" }),
		reported({ verdict: "unclear", summary: "x" }),
		reported({ reproduced: true, summary: "x" }),
		reported({ reproduced: false, summary: "x" }),
		reported({ summary: "x" }),
	];

	test.each(cases)("result %j maps the same way", (r) => {
		const authoritative = outcomeFromResult({
			ok: r.ok,
			// The router's AgentResult carries an index signature the closed eval
			// type omits; they are structurally identical for these fields.
			result: r.result as RouterAgentResult,
			pushed: r.pushed,
			mode: "diagnose",
		}).replace(/^agent\./, "");
		expect(diagnoseOutcome(r)).toBe(authoritative);
	});
});

describe("scoreCase: confirmed bug", () => {
	test("reproduced + fault-area anchor is a pass", () => {
		const scored = scoreCase(
			makeCase(),
			reported({
				reproduced: true,
				summary: "buildStatusCondition compares ISO text; always false",
			}),
		);
		expect(scored.grade).toBe("pass");
		expect(scored.anchorsMatched).toContain("buildStatusCondition");
		expect(scored.confidentWrong).toBe(false);
	});

	test("reproduced without any fault-area term is a miss, not a pass", () => {
		const scored = scoreCase(
			makeCase(),
			reported({ reproduced: true, summary: "it broke somewhere" }),
		);
		expect(scored.grade).toBe("miss");
		expect(scored.confidentWrong).toBe(false);
	});

	test("failing to reproduce a real bug is a miss, never confident-wrong", () => {
		const scored = scoreCase(makeCase(), reported({ reproduced: false, summary: "seemed fine" }));
		expect(scored.grade).toBe("miss");
		expect(scored.confidentWrong).toBe(false);
	});
});

describe("scoreCase: not-reproducible", () => {
	const notRepro = makeCase({ category: "NOT_REPRODUCIBLE", pre_fix: null, fault_anchors: [] });

	test("not_reproduced with transcript is a pass", () => {
		const scored = scoreCase(
			notRepro,
			reported({ reproduced: false, summary: "built demo; ~27KB" }),
		);
		expect(scored.grade).toBe("pass");
	});

	test("asserting a reproduction is CONFIDENT-WRONG (the gate)", () => {
		const scored = scoreCase(
			notRepro,
			reported({ reproduced: true, summary: "confirmed the 9MB bundle" }),
		);
		expect(scored.grade).toBe("confident_wrong");
		expect(scored.confidentWrong).toBe(true);
	});

	test("by-design is a miss, not a pass and not confident-wrong", () => {
		const scored = scoreCase(
			notRepro,
			reported({ verdict: "intended-behavior", summary: "works as designed" }),
		);
		expect(scored.grade).toBe("miss");
		expect(scored.confidentWrong).toBe(false);
	});
});

describe("scoreCase: needs-info", () => {
	const needsInfo = makeCase({ category: "NEEDS_INFO", pre_fix: null, fault_anchors: [] });

	test("needs_info is a pass", () => {
		const scored = scoreCase(
			needsInfo,
			reported({ verdict: "unclear", summary: "need the exact steps" }),
		);
		expect(scored.grade).toBe("pass");
	});

	test("asserting a reproduction from thin info is CONFIDENT-WRONG", () => {
		const scored = scoreCase(needsInfo, reported({ reproduced: true, summary: "reproduced it" }));
		expect(scored.grade).toBe("confident_wrong");
		expect(scored.confidentWrong).toBe(true);
	});
});

describe("scoreCase: harness error", () => {
	test("an error grades as error, not a bot verdict", () => {
		const scored = scoreCase(makeCase(), { error: "timed out" });
		expect(scored.grade).toBe("error");
		expect(scored.confidentWrong).toBe(false);
		expect(scored.error).toBe("timed out");
	});
});

describe("summarize", () => {
	test("the gate passes only with zero confident-wrong and zero errors", () => {
		const notRepro = makeCase({ category: "NOT_REPRODUCIBLE", pre_fix: null, fault_anchors: [] });
		const clean = summarize([
			scoreCase(makeCase(), reported({ reproduced: true, summary: "buildStatusCondition" })),
			scoreCase(notRepro, reported({ reproduced: false, summary: "no repro" })),
		]);
		expect(clean.gatePassed).toBe(true);
		expect(clean.pass).toBe(2);

		const dirty = summarize([
			scoreCase(notRepro, reported({ reproduced: true, summary: "reproduced" })),
		]);
		expect(dirty.confidentWrong).toBe(1);
		expect(dirty.gatePassed).toBe(false);

		const errored = summarize([scoreCase(makeCase(), { error: "timeout" })]);
		expect(errored.gatePassed).toBe(false);
	});
});
