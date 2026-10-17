import { describe, expect, it } from "vitest";

import { gatePullRequestEvent, getWebhookDeliveryId } from "../.flue/lib/webhook.js";

describe("pull request webhook gate", () => {
	function event(action: string, author: string) {
		return {
			action,
			pull_request: {
				number: 42,
				title: "Improve observability",
				body: "",
				draft: false,
				head: { ref: "feature", sha: "abc123" },
				base: { ref: "main", sha: "def456" },
				user: { login: author },
			},
			repository: { name: "emdash", owner: { login: "emdash-cms" } },
		};
	}

	it("rejects a webhook without a delivery id", () => {
		expect(getWebhookDeliveryId(undefined)).toBeNull();
		expect(getWebhookDeliveryId("delivery-1")).toBe("delivery-1");
	});

	it("carries the immutable head SHA into the review payload", () => {
		const decision = gatePullRequestEvent({
			action: "opened",
			pull_request: {
				number: 42,
				title: "Improve observability",
				body: "",
				draft: false,
				head: { ref: "feature", sha: "abc123" },
				base: { ref: "main", sha: "def456" },
				user: { login: "contributor" },
			},
			repository: { name: "emdash", owner: { login: "emdash-cms" } },
		});

		expect(decision).toMatchObject({
			review: true,
			pr: {
				authorLogin: "contributor",
				headSha: "abc123",
				baseSha: "def456",
			},
		});
	});

	it("rejects an event without a head SHA", () => {
		const decision = gatePullRequestEvent({
			action: "opened",
			pull_request: {
				number: 42,
				title: "Improve observability",
				head: { ref: "feature" },
				base: { ref: "main", sha: "def456" },
				user: { login: "contributor" },
			},
			repository: { name: "emdash", owner: { login: "emdash-cms" } },
		});

		expect(decision).toEqual({ review: false, reason: "payload missing required PR fields" });
	});

	it("skips unsolicited PRs from other bots", () => {
		expect(gatePullRequestEvent(event("opened", "dependabot[bot]"))).toEqual({
			review: false,
			reason: 'author "dependabot[bot]" is a bot',
		});
	});

	it.each(["emdashbot[bot]", "emdash-autofix[bot]"])("automatically reviews %s PRs", (author) => {
		expect(gatePullRequestEvent(event("opened", author))).toMatchObject({ review: true });
	});

	it("reviews emdash-autofix's own pushes to its PRs", () => {
		const push = event("synchronize", "emdash-autofix[bot]");
		expect(
			gatePullRequestEvent({ ...push, sender: { login: "emdash-autofix[bot]" } }),
		).toMatchObject({ review: true, pr: { headSha: "abc123" } });
	});

	it.each([
		{ author: "emdash-autofix[bot]", sender: "emdashbot[bot]" },
		{ author: "emdash-autofix[bot]", sender: "ascorbic" },
		{ author: "emdashbot[bot]", sender: "emdashbot[bot]" },
		{ author: "contributor", sender: "contributor" },
	])("skips a push by $sender to a PR by $author", ({ author, sender }) => {
		expect(
			gatePullRequestEvent({ ...event("synchronize", author), sender: { login: sender } }),
		).toEqual({ review: false, reason: 'action "synchronize" is not reviewable' });
	});

	it("honors a bot:review label on any bot PR", () => {
		const botEvent = event("labeled", "dependabot[bot]");
		expect(
			gatePullRequestEvent({
				...botEvent,
				label: { name: "bot:review" },
				pull_request: { ...botEvent.pull_request, draft: true },
			}),
		).toMatchObject({ review: true });
	});

	it.each([
		{ title: "design: add content locking", body: "" },
		{ title: "Add content locking", body: "<!-- design-pr -->" },
	])("skips a design PR, including a manual review request", ({ title, body }) => {
		const designEvent = event("labeled", "contributor");
		expect(
			gatePullRequestEvent({
				...designEvent,
				label: { name: "bot:review" },
				pull_request: { ...designEvent.pull_request, title, body },
			}),
		).toEqual({ review: false, reason: "design PRs require human discussion" });
	});
});
