import { describe, expect, it } from "vitest";

import type { PullRequestState } from "../.flue/lib/github.js";
import {
	DEFAULT_REREVIEW_LIMIT,
	evaluateRereview,
	followUpHead,
	REREVIEW_NO_CI_GRACE_MS,
	REREVIEW_WINDOW_MS,
	rereviewLimit,
	type PendingRereview,
	type RereviewDeps,
	type RereviewHistory,
} from "../.flue/lib/rereview.js";

const NOW = 10_000_000;
const PR: PullRequestState = {
	state: "open",
	draft: false,
	title: "Fix the cache",
	body: "",
	authorLogin: "contributor",
	headRef: "fix",
	headSha: "B",
	baseRef: "main",
	baseSha: "base",
};
const PENDING: PendingRereview = {
	owner: "emdash-cms",
	repo: "emdash",
	prNumber: 42,
	headSha: "B",
	since: NOW - 30 * 60_000,
	checksDoneAt: NOW - 2 * 60_000,
};
const HISTORY: RereviewHistory = { admittedAt: [], admittedHeads: [] };

function deps(
	overrides: Partial<RereviewDeps> = {},
	pr: Partial<PullRequestState> = {},
): RereviewDeps {
	return {
		pullRequest: async () => ({ ...PR, ...pr }),
		headChecks: async () => ({ total: 4, incomplete: 0 }),
		lastReviewedHead: async () => "A",
		reviewStarted: async () => false,
		classifyMove: async () => "substantive",
		reviewInFlight: async () => false,
		...overrides,
	};
}

const evaluate = (
	d: RereviewDeps,
	history: RereviewHistory = HISTORY,
	pending: PendingRereview = PENDING,
) => evaluateRereview(pending, history, d, { now: NOW, limit: DEFAULT_REREVIEW_LIMIT });

describe("evaluateRereview", () => {
	it("admits a scoped re-review of the current head against the last reviewed head", async () => {
		await expect(evaluate(deps())).resolves.toMatchObject({
			kind: "admit",
			attemptId: "rereview:emdash-cms/emdash#42@B",
			input: { headSha: "B", reviewMode: "scoped", priorHeadSha: "A" },
		});
	});

	it.each([
		[{ state: "closed" }, "pr_closed"],
		[{ draft: true }, "pr_draft"],
		[{ title: "design: locking" }, "design_pr"],
		[{ authorLogin: "dependabot[bot]" }, "bot_author"],
	])("drops a PR that is no longer eligible (%o)", async (pr, reason) => {
		await expect(evaluate(deps({}, pr))).resolves.toEqual({ kind: "drop", reason });
	});

	it("never re-reviews a PR the bot has not reviewed", async () => {
		await expect(evaluate(deps({ lastReviewedHead: async () => undefined }))).resolves.toEqual({
			kind: "drop",
			reason: "never_reviewed",
		});
	});

	it("skips a head that a label-forced or earlier review already started", async () => {
		await expect(evaluate(deps({ reviewStarted: async () => true }))).resolves.toEqual({
			kind: "drop",
			reason: "review_already_started",
		});
		await expect(evaluate(deps({ lastReviewedHead: async () => "B" }))).resolves.toEqual({
			kind: "drop",
			reason: "head_already_reviewed",
		});
	});

	it.each(["format_only", "base_merge_only"] as const)("skips a %s move", async (move) => {
		await expect(evaluate(deps({ classifyMove: async () => move }))).resolves.toEqual({
			kind: "drop",
			reason: move,
		});
	});

	it("stops at the per-PR limit within the window and counts only admitted reviews", async () => {
		const full: RereviewHistory = {
			admittedAt: Array.from({ length: DEFAULT_REREVIEW_LIMIT }, (_, i) => NOW - i * 60_000),
			admittedHeads: [],
		};
		await expect(evaluate(deps(), full)).resolves.toEqual({
			kind: "drop",
			reason: "limit_reached",
		});
		const expired: RereviewHistory = {
			...full,
			admittedAt: full.admittedAt.map((at) => at - REREVIEW_WINDOW_MS),
		};
		await expect(evaluate(deps(), expired)).resolves.toMatchObject({ kind: "admit" });
	});

	it("reads the limit from configuration", () => {
		expect(rereviewLimit({})).toBe(DEFAULT_REREVIEW_LIMIT);
		expect(rereviewLimit({ REVIEW_AUTO_REREVIEW_LIMIT: "2" })).toBe(2);
		expect(rereviewLimit({ REVIEW_AUTO_REREVIEW_LIMIT: "many" })).toBe(DEFAULT_REREVIEW_LIMIT);
	});

	it("waits for CI to start, then reviews a head that has no CI", async () => {
		const noChecks = deps({ headChecks: async () => ({ total: 0, incomplete: 0 }) });
		const fresh = { ...PENDING, since: NOW - 60_000, checksDoneAt: undefined };
		await expect(evaluate(noChecks, HISTORY, fresh)).resolves.toMatchObject({
			kind: "wait",
			reason: "waiting_for_ci_to_start",
		});
		const stale = { ...fresh, since: NOW - REREVIEW_NO_CI_GRACE_MS };
		await expect(evaluate(noChecks, HISTORY, stale)).resolves.toMatchObject({
			kind: "admit",
			reason: "no_ci",
		});
	});
});

describe("followUpHead", () => {
	it("follows up only from a scheduled scoped re-review with an earlier review", () => {
		expect(followUpHead({ reviewMode: "scoped", priorHeadSha: "A" }, "Earlier review.")).toBe("A");
		expect(followUpHead({ priorHeadSha: "A" }, "Earlier review.")).toBeUndefined();
		expect(
			followUpHead({ reviewMode: "full", priorHeadSha: "A" }, "Earlier review."),
		).toBeUndefined();
		expect(followUpHead({ reviewMode: "scoped", priorHeadSha: "A" }, undefined)).toBeUndefined();
	});
});
