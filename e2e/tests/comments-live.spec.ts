/**
 * Live/optimistic comment display E2E test.
 *
 * <Comments live> + <CommentForm live> insert a newly submitted comment into
 * the DOM without a page reload. Covers the real browser behavior the
 * integration test (packages/core/tests/integration/client/comments.test.ts)
 * can't: that the submit handler actually fires, the event actually gets
 * picked up, and the comment actually lands in the DOM.
 *
 * The public comment endpoint rate-limits at 5 submissions per 10 minutes
 * per IP, shared with comments.spec.ts's seeded submissions against the same
 * dev server -- this file submits exactly one comment to stay within budget.
 */

import { test, expect } from "../fixtures";

test.describe("Live comment display", () => {
	test("inserts a submitted comment into the DOM without a page reload", async ({
		page,
		serverInfo,
	}) => {
		// Auto-approve so the inserted comment isn't wrapped in the
		// "Awaiting moderation" pending state.
		const res = await page.request.put(
			`${serverInfo.baseUrl}/_emdash/api/schema/collections/posts`,
			{
				headers: {
					"Content-Type": "application/json",
					Authorization: `Bearer ${serverInfo.token}`,
					"X-EmDash-Request": "1",
				},
				data: { commentsEnabled: true, commentsModeration: "none" },
			},
		);
		expect(res.ok()).toBe(true);

		await page.goto("/posts/first-post");

		// A marker that only survives if the page never navigates/reloads.
		await page.evaluate(() => {
			(window as unknown as { __e2eMarker: string }).__e2eMarker = "still-here";
		});

		const commentBody = `Live comment ${Date.now()}`;
		await page.locator('.ec-comment-form textarea[name="body"]').fill(commentBody);
		await page.locator('.ec-comment-form input[name="authorName"]').fill("Live E2E Tester");
		await page.locator('.ec-comment-form input[name="authorEmail"]').fill("live-e2e@test.com");
		await page.locator(".ec-comment-form-submit").click();

		await expect(page.locator(".ec-comment-body", { hasText: commentBody })).toBeVisible({
			timeout: 10000,
		});

		// Still on the same document -- the comment was inserted client-side.
		const marker = await page.evaluate(
			() => (window as unknown as { __e2eMarker?: string }).__e2eMarker,
		);
		expect(marker).toBe("still-here");

		// Auto-approved, so it renders without the pending notice.
		const article = page.locator(".ec-comment", { hasText: commentBody });
		await expect(article).not.toHaveClass(/ec-comment-pending/);
	});
});
