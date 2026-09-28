import { describe, expect, it, vi } from "vitest";

import { reviewUntilCurrentHead, type PullRequestRevision } from "../.flue/lib/review-head.js";

const first = { headSha: "a".repeat(40), baseSha: "1".repeat(40) };
const second = { headSha: "b".repeat(40), baseSha: "2".repeat(40) };

function callbacks(currentRevisions: PullRequestRevision[], move: "format_only" | "substantive") {
	const review = vi.fn(async (revision: PullRequestRevision) => `review:${revision.headSha}`);
	const currentRevision = vi.fn(async () => currentRevisions.shift() ?? second);
	const classifyMove = vi.fn(async () => move);
	const publish = vi.fn(async () => undefined);
	return { review, currentRevision, classifyMove, publish };
}

describe("reviewUntilCurrentHead", () => {
	it("publishes the completed review when the head is unchanged", async () => {
		const operations = callbacks([first], "substantive");

		await expect(reviewUntilCurrentHead(first, operations)).resolves.toBe(
			`review:${first.headSha}`,
		);

		expect(operations.review).toHaveBeenCalledOnce();
		expect(operations.classifyMove).not.toHaveBeenCalled();
		expect(operations.publish).toHaveBeenCalledWith(`review:${first.headSha}`, first);
	});

	it("publishes the original review after a formatter-only head move", async () => {
		const formatted = { ...second, baseSha: first.baseSha };
		const operations = callbacks([formatted], "format_only");

		await reviewUntilCurrentHead(first, operations);

		expect(operations.review).toHaveBeenCalledOnce();
		expect(operations.classifyMove).toHaveBeenCalledWith(first.headSha, formatted.headSha);
		expect(operations.publish).toHaveBeenCalledWith(`review:${first.headSha}`, first);
	});

	it("reviews a substantive new head and publishes only that result", async () => {
		const operations = callbacks([second, second], "substantive");

		await expect(reviewUntilCurrentHead(first, operations)).resolves.toBe(
			`review:${second.headSha}`,
		);

		expect(operations.review).toHaveBeenNthCalledWith(1, first);
		expect(operations.review).toHaveBeenNthCalledWith(2, second);
		expect(operations.publish).toHaveBeenCalledOnce();
		expect(operations.publish).toHaveBeenCalledWith(`review:${second.headSha}`, second);
	});

	it("re-reviews when the base changes even if the head does not", async () => {
		const newBase = { headSha: first.headSha, baseSha: second.baseSha };
		const operations = callbacks([newBase, newBase], "format_only");

		await reviewUntilCurrentHead(first, operations);

		expect(operations.review).toHaveBeenNthCalledWith(1, first);
		expect(operations.review).toHaveBeenNthCalledWith(2, newBase);
		expect(operations.classifyMove).not.toHaveBeenCalled();
		expect(operations.publish).toHaveBeenCalledWith(`review:${newBase.headSha}`, newBase);
	});

	it("fails visibly when the head changes throughout the bounded re-reviews", async () => {
		const third = { headSha: "c".repeat(40), baseSha: "3".repeat(40) };
		const fourth = { headSha: "d".repeat(40), baseSha: "4".repeat(40) };
		const operations = callbacks([second, third, fourth], "substantive");

		await expect(reviewUntilCurrentHead(first, operations)).rejects.toThrow(
			"PR head kept changing during review after 3 reviewed revisions",
		);
		expect(operations.publish).not.toHaveBeenCalled();
	});
});
