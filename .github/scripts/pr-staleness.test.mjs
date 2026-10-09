import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lastHumanActivity, sweepAction } from "./pr-staleness.mjs";

const human = { __typename: "User" };
const bot = { __typename: "Bot" };

function pullRequest({ comments = [], reviews = [], committedDate = "2026-09-01T00:00:00Z" } = {}) {
	return {
		createdAt: "2026-08-01T00:00:00Z",
		commits: { nodes: [{ commit: { committedDate } }] },
		comments: { nodes: comments },
		reviews: { nodes: reviews },
	};
}

describe("lastHumanActivity", () => {
	it("ignores bot comments and reviews posted after the last human activity", () => {
		const pr = pullRequest({
			comments: [
				{ createdAt: "2026-09-02T00:00:00Z", author: human },
				{ createdAt: "2026-09-20T00:00:00Z", author: bot },
			],
			reviews: [{ submittedAt: "2026-09-21T00:00:00Z", author: bot }],
		});

		assert.equal(lastHumanActivity(pr).toISOString(), "2026-09-02T00:00:00.000Z");
	});

	it("counts the latest human comment, human review, or commit", () => {
		assert.equal(
			lastHumanActivity(
				pullRequest({ comments: [{ createdAt: "2026-09-10T00:00:00Z", author: human }] }),
			).toISOString(),
			"2026-09-10T00:00:00.000Z",
		);
		assert.equal(
			lastHumanActivity(
				pullRequest({ reviews: [{ submittedAt: "2026-09-12T00:00:00Z", author: human }] }),
			).toISOString(),
			"2026-09-12T00:00:00.000Z",
		);
		assert.equal(
			lastHumanActivity(pullRequest({ committedDate: "2026-09-15T00:00:00Z" })).toISOString(),
			"2026-09-15T00:00:00.000Z",
		);
	});

	it("counts a human reopening the PR, but not a bot", () => {
		const reopened = (author) => ({
			...pullRequest(),
			timelineItems: { nodes: [{ createdAt: "2026-09-20T00:00:00Z", actor: author }] },
		});

		assert.equal(lastHumanActivity(reopened(human)).toISOString(), "2026-09-20T00:00:00.000Z");
		assert.equal(lastHumanActivity(reopened(bot)).toISOString(), "2026-09-01T00:00:00.000Z");
	});

	it("treats comments from deleted accounts as human and falls back to creation", () => {
		const pr = pullRequest({ comments: [{ createdAt: "2026-09-05T00:00:00Z", author: null }] });
		assert.equal(lastHumanActivity(pr).toISOString(), "2026-09-05T00:00:00.000Z");

		const empty = { createdAt: "2026-08-01T00:00:00Z" };
		assert.equal(lastHumanActivity(empty).toISOString(), "2026-08-01T00:00:00.000Z");
	});
});

describe("sweepAction", () => {
	const now = new Date("2026-10-30T00:00:00Z");
	const daysAgo = (days) => new Date(now.getTime() - days * 24 * 60 * 60 * 1000);

	function state(overrides = {}) {
		return {
			now,
			createdAt: daysAgo(60),
			isBotAuthor: false,
			isDraft: false,
			labels: new Set(["review/awaiting-author"]),
			mergeable: true,
			lastActivity: daysAgo(1),
			claReminderAt: null,
			staleWarningAt: null,
			...overrides,
		};
	}

	describe("unsigned CLA", () => {
		const unsigned = new Set(["cla: needed", "review/needs-review"]);

		it("waits a day before reminding", () => {
			assert.equal(
				sweepAction(state({ labels: unsigned, createdAt: daysAgo(0.5) })).action,
				"none",
			);
			assert.equal(
				sweepAction(state({ labels: unsigned, createdAt: daysAgo(1) })).action,
				"cla-remind",
			);
		});

		it("closes seven days after opening once the reminder has stood for six days", () => {
			assert.equal(
				sweepAction(state({ labels: unsigned, createdAt: daysAgo(7), claReminderAt: daysAgo(6) }))
					.action,
				"cla-close",
			);
		});

		it("reminds before closing an old unsigned PR that was never reminded", () => {
			assert.equal(
				sweepAction(state({ labels: unsigned, createdAt: daysAgo(70) })).action,
				"cla-remind",
			);
			assert.equal(
				sweepAction(state({ labels: unsigned, createdAt: daysAgo(70), claReminderAt: daysAgo(2) }))
					.action,
				"none",
			);
		});

		it("is not reset by activity, and takes precedence over author staleness", () => {
			const result = sweepAction(
				state({
					labels: new Set(["cla: needed", "review/awaiting-author"]),
					createdAt: daysAgo(30),
					lastActivity: daysAgo(30),
					claReminderAt: daysAgo(6),
				}),
			);
			assert.deepEqual(result, { action: "cla-close", stale: false, reason: null });
		});
	});

	describe("waiting on the author", () => {
		it("warns after 14 days without human activity", () => {
			assert.equal(sweepAction(state({ lastActivity: daysAgo(13) })).action, "none");
			assert.deepEqual(sweepAction(state({ lastActivity: daysAgo(14) })), {
				action: "stale-warn",
				stale: true,
				reason: "changes-requested",
			});
		});

		it("closes seven days after a warning with no human activity since", () => {
			assert.deepEqual(
				sweepAction(state({ lastActivity: daysAgo(21), staleWarningAt: daysAgo(7) })),
				{ action: "stale-close", stale: true, reason: "changes-requested" },
			);
			assert.deepEqual(
				sweepAction(state({ lastActivity: daysAgo(20), staleWarningAt: daysAgo(6) })),
				{ action: "none", stale: true, reason: "changes-requested" },
			);
		});

		it("ignores a warning that human activity has answered", () => {
			assert.deepEqual(
				sweepAction(state({ lastActivity: daysAgo(3), staleWarningAt: daysAgo(10) })),
				{ action: "none", stale: false, reason: "changes-requested" },
			);
		});

		it("treats drafts and merge conflicts as waiting on the author", () => {
			const idle = { lastActivity: daysAgo(15), labels: new Set(["review/needs-review"]) };
			assert.equal(sweepAction(state({ ...idle, isDraft: true })).reason, "draft");
			assert.equal(sweepAction(state({ ...idle, mergeable: false })).reason, "conflicts");
			assert.equal(sweepAction(state({ ...idle, isDraft: true })).action, "stale-warn");
		});

		it("warns on inactive design PRs but never closes them for staleness", () => {
			for (const authorState of [
				{},
				{ isDraft: true, labels: new Set(["review/needs-review"]) },
				{ mergeable: false, labels: new Set(["review/needs-review"]) },
			]) {
				const design = state({ ...authorState, isDesign: true, lastActivity: daysAgo(90) });
				assert.equal(sweepAction(design).action, "stale-warn");
				const warned = sweepAction({ ...design, staleWarningAt: daysAgo(30) });
				assert.equal(warned.action, "none");
				assert.equal(warned.stale, true);
			}
		});

		it("still closes design PRs whose CLA remains unsigned", () => {
			const result = sweepAction(
				state({ isDesign: true, labels: new Set(["cla: needed"]), claReminderAt: daysAgo(6) }),
			);
			assert.equal(result.action, "cla-close");
		});
	});

	describe("not waiting on the author", () => {
		it("never goes stale while waiting on a review", () => {
			for (const label of ["review/needs-review", "review/needs-rereview", "review/approved"]) {
				assert.deepEqual(
					sweepAction(state({ labels: new Set([label]), lastActivity: daysAgo(90) })),
					{ action: "none", stale: false, reason: null },
				);
			}
		});

		it("skips bot-authored and blocked PRs", () => {
			const idle = { lastActivity: daysAgo(90), staleWarningAt: daysAgo(30) };
			assert.equal(sweepAction(state({ ...idle, isBotAuthor: true })).action, "none");
			assert.equal(
				sweepAction(state({ ...idle, labels: new Set(["review/awaiting-author", "blocked"]) }))
					.action,
				"none",
			);
		});
	});
});
