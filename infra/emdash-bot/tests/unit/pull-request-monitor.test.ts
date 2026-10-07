import { describe, expect, test } from "vitest";

import type { PullRequestStatus } from "../../.flue/lib/github.js";
import { assessPullRequest, MAX_AUTOMATIC_REPAIRS } from "../../.flue/lib/pull-request-monitor.js";

function status(overrides: Partial<PullRequestStatus> = {}): PullRequestStatus {
	return {
		number: 42,
		url: "https://github.com/emdash-cms/emdash/pull/42",
		state: "open",
		draft: true,
		headSha: "abc123",
		mergeability: "mergeable",
		review: "review-required",
		checks: "pending",
		failingChecks: [],
		pendingChecks: ["Tests"],
		updatedAt: "2026-09-08T10:00:00Z",
		...overrides,
	};
}

describe("pull request monitoring", () => {
	test("waits while checks are pending", () => {
		expect(assessPullRequest(status(), null)).toEqual({ kind: "waiting" });
	});

	test("reports green only when checks pass and the branch is mergeable", () => {
		expect(
			assessPullRequest(status({ checks: "passing", pendingChecks: [], review: "approved" }), null),
		).toEqual({ kind: "green" });
	});

	test("describes failures and requests one repair per problem fingerprint", () => {
		const failing = status({
			checks: "failing",
			pendingChecks: [],
			failingChecks: [{ name: "Typecheck", url: "https://checks/1" }],
		});
		const first = assessPullRequest(failing, null);
		expect(first).toMatchObject({ kind: "repair", summary: expect.stringContaining("Typecheck") });
		if (first.kind !== "repair") return;
		expect(assessPullRequest(failing, first.fingerprint)).toEqual({ kind: "waiting" });
	});

	test("treats conflicts and requested changes as repairable problems", () => {
		for (const overrides of [
			{ mergeability: "conflicting" as const },
			{ review: "changes-requested" as const },
		]) {
			expect(
				assessPullRequest(status({ checks: "passing", pendingChecks: [], ...overrides }), null)
					.kind,
			).toBe("repair");
		}
	});

	test("does not repeat a stable repair when GitHub toggles mergeability", () => {
		const conflicting = assessPullRequest(
			status({
				mergeability: "conflicting",
				review: "changes-requested",
				checks: "failing",
				failingChecks: [{ name: "Smoke Tests", url: null }],
			}),
			null,
		);
		expect(conflicting.kind).toBe("repair");
		if (conflicting.kind !== "repair") return;

		expect(
			assessPullRequest(
				status({
					mergeability: "unknown",
					review: "changes-requested",
					checks: "failing",
					failingChecks: [{ name: "Smoke Tests", url: null }],
				}),
				conflicting.fingerprint,
			),
		).toEqual({ kind: "waiting" });
	});

	test("projects merged and closed pull requests", () => {
		expect(assessPullRequest(status({ state: "merged" }), null)).toEqual({ kind: "merged" });
		expect(assessPullRequest(status({ state: "closed" }), null)).toEqual({ kind: "closed" });
	});

	test("repairs a change request once, however many times the bot pushes", () => {
		const requested = status({
			checks: "passing",
			pendingChecks: [],
			review: "changes-requested",
			changesRequestedReviewIds: [11],
		});
		const first = assessPullRequest(requested, null);
		expect(first.kind).toBe("repair");
		if (first.kind !== "repair") return;

		const afterPush = { ...requested, headSha: "def456" };
		expect(assessPullRequest(afterPush, first.fingerprint)).toEqual({ kind: "waiting" });
	});

	test("repairs again when a reviewer requests changes again", () => {
		const requested = status({
			checks: "passing",
			pendingChecks: [],
			review: "changes-requested",
			changesRequestedReviewIds: [11],
		});
		const first = assessPullRequest(requested, null);
		if (first.kind !== "repair") throw new Error("expected a repair");

		expect(
			assessPullRequest(
				{ ...requested, headSha: "def456", changesRequestedReviewIds: [11, 12] },
				first.fingerprint,
			).kind,
		).toBe("repair");
	});

	test("repairs failing checks again on a new head", () => {
		const failing = status({
			checks: "failing",
			pendingChecks: [],
			failingChecks: [{ name: "Typecheck", url: null }],
		});
		const first = assessPullRequest(failing, null);
		if (first.kind !== "repair") throw new Error("expected a repair");

		expect(assessPullRequest({ ...failing, headSha: "def456" }, first.fingerprint).kind).toBe(
			"repair",
		);
	});

	test("waits instead of repairing checks that also fail on the base branch", () => {
		expect(
			assessPullRequest(
				status({
					checks: "failing",
					pendingChecks: [],
					failingChecks: [{ name: "Tests", url: null }],
					baseFailingChecks: ["Tests"],
				}),
				null,
			),
		).toEqual({ kind: "waiting" });
	});

	test("repairs only the checks the base branch passes, and says which failures are inherited", () => {
		const assessment = assessPullRequest(
			status({
				checks: "failing",
				pendingChecks: [],
				failingChecks: [
					{ name: "Tests", url: null },
					{ name: "Typecheck", url: null },
				],
				baseFailingChecks: ["Tests"],
			}),
			null,
		);
		expect(assessment.kind).toBe("repair");
		if (assessment.kind !== "repair") return;
		expect(assessment.summary).toContain("Failing checks: Typecheck.");
		expect(assessment.summary).toContain("Tests");
		expect(assessment.summary).toContain("also failing on the base branch");
	});

	test("includes the automated review of the current head in the repair", () => {
		const assessment = assessPullRequest(
			status({
				checks: "failing",
				pendingChecks: [],
				failingChecks: [{ name: "Typecheck", url: null }],
				latestBotReview: { body: "Blocking: the cursor overflows", commitSha: "abc123" },
			}),
			null,
		);
		expect(assessment).toMatchObject({
			kind: "repair",
			summary: expect.stringContaining("Blocking: the cursor overflows"),
		});
	});

	test("leaves out an automated review of an older head", () => {
		const assessment = assessPullRequest(
			status({
				checks: "failing",
				pendingChecks: [],
				failingChecks: [{ name: "Typecheck", url: null }],
				latestBotReview: { body: "Blocking: the cursor overflows", commitSha: "old000" },
			}),
			null,
		);
		expect(assessment.kind).toBe("repair");
		if (assessment.kind !== "repair") return;
		expect(assessment.summary).not.toContain("cursor overflows");
	});

	test("hands over instead of repairing once the automatic repairs are used up", () => {
		const failing = status({
			checks: "failing",
			pendingChecks: [],
			failingChecks: [{ name: "Typecheck", url: null }],
		});
		expect(assessPullRequest(failing, null, MAX_AUTOMATIC_REPAIRS - 1).kind).toBe("repair");
		expect(assessPullRequest(failing, null, MAX_AUTOMATIC_REPAIRS)).toMatchObject({
			kind: "exhausted",
			summary: expect.stringContaining("Typecheck"),
		});
	});
});
