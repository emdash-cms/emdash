// Pure tests for the webhook helper module. No bindings, no I/O.
//
// Note: `verifyWebhookSignature` uses `crypto.subtle.timingSafeEqual`, a
// workerd extension to Web Crypto. Tests that exercise the verifier proper
// live in tests/integration/webhook.test.ts where SELF.fetch runs in workerd.
// This file covers the pure logic that runs identically on Node and workerd:
//   - Actor classification
//   - Payload normalization for each event type

import { describe, expect, test } from "vitest";

import {
	classifyActor,
	normalizeWebhook,
	type IssueCommentEvent,
	type IssuesEvent,
	type PullRequestEvent,
	type PullRequestReviewCommentEvent,
	type PullRequestReviewEvent,
} from "../../.flue/lib/webhook.js";

describe("classifyActor", () => {
	test("maintainer for OWNER / MEMBER / COLLABORATOR", () => {
		for (const assoc of ["OWNER", "MEMBER", "COLLABORATOR"]) {
			expect(
				classifyActor({
					senderLogin: "alice",
					authorAssociation: assoc,
				}),
			).toBe("maintainer");
		}
	});

	test("reporter when sender is the issue opener and not a maintainer", () => {
		expect(
			classifyActor({
				senderLogin: "bob",
				authorAssociation: "CONTRIBUTOR",
				issueOpenerLogin: "bob",
			}),
		).toBe("reporter");
	});

	test("maintainer wins over reporter when the opener is also a maintainer", () => {
		// A maintainer who opens an issue acts with maintainer authority on
		// their own issue's comments, not reduced reporter authority.
		expect(
			classifyActor({
				senderLogin: "alice",
				authorAssociation: "MEMBER",
				issueOpenerLogin: "alice",
			}),
		).toBe("maintainer");
	});

	test("system for bot senders", () => {
		expect(
			classifyActor({
				senderLogin: "emdashbot[bot]",
				authorAssociation: "NONE",
			}),
		).toBe("system");
	});

	test("other for unknown / random users", () => {
		expect(
			classifyActor({
				senderLogin: "drive-by",
				authorAssociation: "FIRST_TIME_CONTRIBUTOR",
				issueOpenerLogin: "someone-else",
			}),
		).toBe("other");
	});

	test("other when senderLogin is missing", () => {
		expect(classifyActor({ senderLogin: undefined })).toBe("other");
		expect(classifyActor({ senderLogin: null })).toBe("other");
		expect(classifyActor({ senderLogin: "" })).toBe("other");
	});
});

describe("normalizeWebhook", () => {
	test("ping → pong", () => {
		const result = normalizeWebhook({ eventType: "ping", payload: {} });
		expect(result.kind).toBe("pong");
	});

	test("unknown event → skip", () => {
		const result = normalizeWebhook({ eventType: "star", payload: {} });
		expect(result.kind).toBe("skip");
	});

	describe("issue_comment", () => {
		const baseComment: IssueCommentEvent = {
			action: "created",
			issue: { number: 42, user: { login: "alice" }, labels: [{ name: "bot:bug" }] },
			comment: {
				body: "@emdashbot please retry",
				author_association: "MEMBER",
				user: { login: "alice" },
			},
			sender: { login: "alice" },
		};

		test("dispatches a free-text comment to the classifier path", () => {
			// `please retry` is not an exact bare verb, so it routes through
			// the classifier (needsClassify=true, no resolved event).
			const r = normalizeWebhook({
				eventType: "issue_comment",
				deliveryId: "del-1",
				payload: baseComment,
			});
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.anchor).toBe("issue-42");
			expect(r.event.actor).toBe("maintainer");
			expect(r.event.labels).toEqual(["bot:bug"]);
			expect(r.event.event).toBe(null);
			expect(r.event.needsClassify).toBe(true);
			expect(r.event.classifyText).toBe("please retry");
			expect(r.event.deliveryId).toBe("del-1");
		});

		test("dispatches a bare verb as a deterministic event (no classifier)", () => {
			const r = normalizeWebhook({
				eventType: "issue_comment",
				payload: {
					...baseComment,
					comment: { ...baseComment.comment, body: "@emdashbot retry" },
				},
			});
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.event.event).toBe("retry");
			expect(r.event.needsClassify).toBe(false);
			expect(r.event.arg).toBe(null);
		});

		test("dispatches a bare destructive verb deterministically", () => {
			const r = normalizeWebhook({
				eventType: "issue_comment",
				payload: {
					...baseComment,
					comment: { ...baseComment.comment, body: "@emdashbot decline" },
				},
			});
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.event.event).toBe("decline");
			expect(r.event.needsClassify).toBe(false);
		});

		test("dispatches a bare mention with empty body as readonly status", () => {
			const r = normalizeWebhook({
				eventType: "issue_comment",
				payload: {
					...baseComment,
					comment: { ...baseComment.comment, body: "@emdashbot " },
				},
			});
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.event.event).toBe("status");
			expect(r.event.needsClassify).toBe(false);
		});

		test("skips comment edits", () => {
			const r = normalizeWebhook({
				eventType: "issue_comment",
				payload: { ...baseComment, action: "edited" },
			});
			expect(r.kind).toBe("skip");
		});

		test("skips comments without an @emdashbot mention", () => {
			const r = normalizeWebhook({
				eventType: "issue_comment",
				payload: {
					...baseComment,
					comment: { ...baseComment.comment, body: "just a comment" },
				},
			});
			expect(r.kind).toBe("skip");
		});

		test("uses reporter actor when the opener comments without maintainer association", () => {
			const r = normalizeWebhook({
				eventType: "issue_comment",
				payload: {
					...baseComment,
					sender: { login: "bob" },
					comment: { ...baseComment.comment, author_association: "CONTRIBUTOR" },
					issue: { ...baseComment.issue, user: { login: "bob" } },
				},
			});
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.event.actor).toBe("reporter");
		});
	});

	describe("issues", () => {
		test("opened acknowledges but skips (no auto-action without mention)", () => {
			const payload: IssuesEvent = {
				action: "opened",
				issue: { number: 7, user: { login: "alice" } },
				sender: { login: "alice" },
			};
			const r = normalizeWebhook({ eventType: "issues", payload });
			expect(r.kind).toBe("skip");
		});

		test("labeled is not handled (DO is the source of truth, not labels)", () => {
			const payload: IssuesEvent = {
				action: "labeled",
				issue: { number: 7, user: { login: "alice" } },
				sender: { login: "alice" },
			};
			const r = normalizeWebhook({ eventType: "issues", payload });
			expect(r.kind).toBe("skip");
		});
	});

	describe("pull_request", () => {
		test("opened by a bot dispatches pr.opened", () => {
			const payload: PullRequestEvent = {
				action: "opened",
				pull_request: { number: 99, user: { login: "emdashbot[bot]" } },
				sender: { login: "emdashbot[bot]" },
			};
			const r = normalizeWebhook({ eventType: "pull_request", payload });
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.anchor).toBe("issue-99");
			expect(r.event.event).toBe("pr.opened");
			expect(r.event.actor).toBe("system");
		});

		test("opened by a non-bot is skipped", () => {
			const payload: PullRequestEvent = {
				action: "opened",
				pull_request: { number: 99, user: { login: "alice" } },
				sender: { login: "alice" },
			};
			const r = normalizeWebhook({ eventType: "pull_request", payload });
			expect(r.kind).toBe("skip");
		});

		test("synchronize is skipped (no re-fire on every push)", () => {
			const payload: PullRequestEvent = {
				action: "synchronize",
				pull_request: { number: 99, user: { login: "emdashbot[bot]" } },
				sender: { login: "emdashbot[bot]" },
			};
			const r = normalizeWebhook({ eventType: "pull_request", payload });
			expect(r.kind).toBe("skip");
		});

		test("closed with merged=true dispatches pr.merged", () => {
			const payload: PullRequestEvent = {
				action: "closed",
				pull_request: {
					number: 99,
					user: { login: "emdashbot[bot]" },
					merged: true,
				},
				sender: { login: "emdashbot[bot]" },
			};
			const r = normalizeWebhook({ eventType: "pull_request", payload });
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.event.event).toBe("pr.merged");
		});

		test("closed with merged=false dispatches pr.closed", () => {
			const payload: PullRequestEvent = {
				action: "closed",
				pull_request: {
					number: 99,
					user: { login: "emdashbot[bot]" },
					merged: false,
				},
				sender: { login: "emdashbot[bot]" },
			};
			const r = normalizeWebhook({ eventType: "pull_request", payload });
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.event.event).toBe("pr.closed");
		});
	});

	describe("pull_request_review", () => {
		test("approved → pr.approved with system actor", () => {
			const payload: PullRequestReviewEvent = {
				action: "submitted",
				review: { state: "approved", author_association: "MEMBER", user: { login: "alice" } },
				pull_request: { number: 99, user: { login: "emdashbot[bot]" } },
				sender: { login: "alice" },
			};
			const r = normalizeWebhook({ eventType: "pull_request_review", payload });
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.event.event).toBe("pr.approved");
			// `pr.*` events are machine-defined as actors:["system"] regardless
			// of who pressed the button on GitHub.
			expect(r.event.actor).toBe("system");
		});

		test("changes_requested → pr.changes_requested", () => {
			const payload: PullRequestReviewEvent = {
				action: "submitted",
				review: {
					state: "changes_requested",
					author_association: "MEMBER",
					user: { login: "alice" },
				},
				pull_request: { number: 99, user: { login: "emdashbot[bot]" } },
				sender: { login: "alice" },
			};
			const r = normalizeWebhook({ eventType: "pull_request_review", payload });
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.event.event).toBe("pr.changes_requested");
		});

		test("commented (no approval signal) is skipped", () => {
			const payload: PullRequestReviewEvent = {
				action: "submitted",
				review: { state: "commented", author_association: "MEMBER", user: { login: "alice" } },
				pull_request: { number: 99, user: { login: "emdashbot[bot]" } },
				sender: { login: "alice" },
			};
			const r = normalizeWebhook({ eventType: "pull_request_review", payload });
			expect(r.kind).toBe("skip");
		});
	});

	describe("pull_request_review_comment", () => {
		test("created with mention dispatches via classifier", () => {
			const payload: PullRequestReviewCommentEvent = {
				action: "created",
				comment: {
					body: "@emdashbot please fix this loop",
					author_association: "MEMBER",
					user: { login: "alice" },
				},
				pull_request: { number: 99, user: { login: "emdashbot[bot]" } },
				sender: { login: "alice" },
			};
			const r = normalizeWebhook({ eventType: "pull_request_review_comment", payload });
			expect(r.kind).toBe("dispatch");
			if (r.kind !== "dispatch") return;
			expect(r.anchor).toBe("issue-99");
			expect(r.event.needsClassify).toBe(true);
			expect(r.event.classifyText).toBe("please fix this loop");
			expect(r.event.actor).toBe("maintainer");
		});

		test("created without mention is skipped", () => {
			const payload: PullRequestReviewCommentEvent = {
				action: "created",
				comment: {
					body: "just a thought",
					author_association: "MEMBER",
					user: { login: "alice" },
				},
				pull_request: { number: 99, user: { login: "emdashbot[bot]" } },
				sender: { login: "alice" },
			};
			const r = normalizeWebhook({ eventType: "pull_request_review_comment", payload });
			expect(r.kind).toBe("skip");
		});
	});
});
