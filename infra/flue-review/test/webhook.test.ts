import { describe, expect, it } from "vitest";

import { gatePullRequestEvent, getWebhookDeliveryId } from "../.flue/lib/webhook.js";

describe("pull request webhook gate", () => {
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
			pr: { headSha: "abc123", baseSha: "def456" },
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
});
