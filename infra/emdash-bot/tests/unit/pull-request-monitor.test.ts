import { describe, expect, test } from "vitest";

import type { PullRequestStatus } from "../../.flue/lib/github.js";
import { assessPullRequest } from "../../.flue/lib/pull-request-monitor.js";

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
});
