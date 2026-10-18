import { describe, expect, it } from "vitest";

import { runReviewPanel, type ReviewPanelDeps } from "../.flue/lib/review-panel.js";
import type { ReviewResult } from "../.flue/lib/review-schema.js";

const OPUS = "anthropic/claude-opus-5-5";
const SOL = "openai/gpt-6.1-sol";
const SONNET = "anthropic/claude-sonnet-5-5";
const KIMI = "cloudflare/@cf/moonshotai/kimi-k2.7-code";

const finding = (path: string, line: number): ReviewResult["findings"][number] => ({
	path,
	line,
	side: "RIGHT",
	severity: "needs_fixing",
	body: `Defect at ${path}:${line}.`,
});

const reviews: Record<string, ReviewResult> = {
	[OPUS]: { verdict: "comment", summary: "Opus.", findings: [finding("a.ts", 1)] },
	[SOL]: { verdict: "approve", summary: "Sol.", findings: [finding("b.ts", 2)] },
	[KIMI]: { verdict: "approve", summary: "Kimi.", findings: [] },
};

function deps(failing: readonly string[] = [], mergeReply?: string) {
	const logs: Array<{ message: string; fields: Record<string, unknown> }> = [];
	const reviewed: string[] = [];
	const merges: string[] = [];
	const panelDeps: ReviewPanelDeps = {
		review: async (model) => {
			reviewed.push(model);
			if (failing.includes(model)) throw new Error(`404 model ${model} not found`);
			const data = reviews[model];
			if (!data) throw new Error(`no review for ${model}`);
			return { data };
		},
		merge: async (model, prompt) => {
			merges.push(model);
			return {
				data:
					mergeReply ??
					JSON.stringify({
						verdict: "comment",
						summary: `Merged from: ${prompt.includes("Opus.") && prompt.includes("Sol.")}`,
						findings: [finding("a.ts", 1), finding("b.ts", 2)],
					}),
			};
		},
		log: (message, fields) => logs.push({ message, fields }),
	};
	return { panelDeps, logs, reviewed, merges };
}

describe("runReviewPanel", () => {
	it("returns a lone configured reviewer's review unchanged", async () => {
		const { panelDeps, merges } = deps();
		const outcome = await runReviewPanel({ reviewers: [KIMI] }, panelDeps);
		expect(outcome.mergePath).toBe("only_reviewer");
		expect(outcome.result).toEqual(reviews[KIMI]);
		expect(merges).toEqual([]);
	});

	it("merges two reviews with the merge model and names both in the footer", async () => {
		const { panelDeps, logs, merges } = deps();
		const outcome = await runReviewPanel({ reviewers: [OPUS, SOL], mergeModel: SONNET }, panelDeps);
		expect(outcome.mergePath).toBe("merged");
		expect(merges).toEqual([SONNET]);
		expect(outcome.result.findings).toHaveLength(2);
		expect(outcome.result.summary).toContain("Merged from: true");
		expect(outcome.result.summary).toContain(
			`Reviewed by \`${OPUS}\` and \`${SOL}\`, merged by \`${SONNET}\`.`,
		);
		const finished = logs.filter((entry) => entry.message === "reviewer finished");
		expect(finished.map((entry) => [entry.fields.model, entry.fields.ok])).toEqual([
			[OPUS, true],
			[SOL, true],
		]);
	});

	it("posts the one completed review with the unavailable note when a reviewer fails", async () => {
		const { panelDeps, logs, merges } = deps([SOL]);
		const outcome = await runReviewPanel({ reviewers: [OPUS, SOL], mergeModel: SONNET }, panelDeps);
		expect(outcome.mergePath).toBe("single_reviewer");
		expect(merges).toEqual([]);
		expect(outcome.result.findings).toEqual(reviews[OPUS]?.findings);
		expect(outcome.result.summary).toContain("other reviewer was unavailable");
		expect(outcome.result.summary).toContain(`\`${SOL}\` was unavailable.`);
		const failed = logs.find(
			(entry) => entry.message === "reviewer finished" && entry.fields.model === SOL,
		);
		expect(failed?.fields).toMatchObject({ ok: false, errorClass: "Error" });
	});

	it("falls back to the deterministic merge when the merge reply is not JSON", async () => {
		const { panelDeps } = deps([], "I cannot merge these.");
		const outcome = await runReviewPanel({ reviewers: [OPUS, SOL], mergeModel: SONNET }, panelDeps);
		expect(outcome.mergePath).toBe("fallback");
		expect(outcome.result.summary).toContain("### anthropic/claude-opus-5-5");
		expect(outcome.result.summary).not.toContain("merged by");
	});

	it("fails with the first reviewer's error when every reviewer fails", async () => {
		const { panelDeps, reviewed } = deps([OPUS, SOL]);
		await expect(
			runReviewPanel({ reviewers: [OPUS, SOL], mergeModel: SONNET }, panelDeps),
		).rejects.toThrow(`404 model ${OPUS} not found`);
		expect(reviewed).toEqual([OPUS, SOL]);
	});

	it("gives the merge the prior-review context on a re-review", async () => {
		const { panelDeps } = deps();
		let prompt = "";
		const outcome = await runReviewPanel(
			{ reviewers: [OPUS, SOL], mergeModel: SONNET },
			{
				...panelDeps,
				merge: async (model, text, signal) => {
					prompt = text;
					return panelDeps.merge!(model, text, signal);
				},
			},
			{ priorReview: "Your previous review: the author fixed a.ts." },
		);
		expect(outcome.mergePath).toBe("merged");
		expect(prompt).toContain("the author fixed a.ts");
		expect(prompt).toContain("Do not resurrect");
	});
});
