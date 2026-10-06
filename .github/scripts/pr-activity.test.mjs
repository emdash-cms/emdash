import assert from "node:assert/strict";
import { describe, it } from "node:test";

import { lastHumanActivity } from "./pr-activity.mjs";

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

	it("treats comments from deleted accounts as human and falls back to creation", () => {
		const pr = pullRequest({ comments: [{ createdAt: "2026-09-05T00:00:00Z", author: null }] });
		assert.equal(lastHumanActivity(pr).toISOString(), "2026-09-05T00:00:00.000Z");

		const empty = { createdAt: "2026-08-01T00:00:00Z" };
		assert.equal(lastHumanActivity(empty).toISOString(), "2026-08-01T00:00:00.000Z");
	});
});
