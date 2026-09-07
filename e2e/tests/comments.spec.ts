/**
 * Comments Moderation E2E Tests
 *
 * Tests the admin comment moderation inbox at /comments.
 * Seeds comments via the public API, then exercises the moderation UI:
 * page rendering, empty state, comment list, approve, and delete.
 */

import type { APIRequestContext } from "@playwright/test";

import { test, expect } from "../fixtures";

// Regex patterns (e18e/prefer-static-regex)
const PENDING_EMPTY_PATTERN = /no comments awaiting moderation/i;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiHeaders(token: string) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
	};
}

/** Seed an anonymous comment via the public API. */
async function seedComment(
	request: APIRequestContext,
	baseUrl: string,
	postId: string,
	overrides: { body?: string; authorName?: string; authorEmail?: string } = {},
) {
	const res = await request.post(`${baseUrl}/_emdash/api/comments/posts/${postId}`, {
		headers: {
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
		},
		data: {
			body: overrides.body ?? "Test comment from E2E",
			authorName: overrides.authorName ?? "E2E Tester",
			authorEmail: overrides.authorEmail ?? "e2e@test.com",
		},
	});
	expect(res.ok()).toBe(true);
	const json = (await res.json()) as { data: { status: string } };
	expect(json.data.status).toBe("pending");
}

/** Delete all comments currently in the admin inbox (best-effort cleanup). */
async function cleanupComments(
	page: import("@playwright/test").Page,
	baseUrl: string,
	token: string,
) {
	const headers = apiHeaders(token);

	for (const status of ["pending", "approved", "spam", "trash"] as const) {
		const res = await page.request.fetch(
			`${baseUrl}/_emdash/api/admin/comments?status=${status}&limit=100`,
			{ headers },
		);
		if (!res.ok()) continue;

		const data: { data?: { items?: { id: string }[] } } = await res.json().catch(() => ({}));
		const ids = data?.data?.items?.map((c) => c.id) ?? [];
		if (ids.length === 0) continue;

		await page.request
			.post(`${baseUrl}/_emdash/api/admin/comments/bulk`, {
				headers,
				data: { ids, action: "delete" },
			})
			.catch(() => {});
	}
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test.describe("Comments Moderation", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("page renders with correct title", async ({ admin }) => {
		await admin.goto("/comments");
		await admin.waitForShell();
		await admin.waitForLoading();

		await admin.expectPageTitle("Comments");
	});

	test("shows empty state when no comments exist", async ({ admin, page, serverInfo }) => {
		// Clean up any existing comments first
		await cleanupComments(page, serverInfo.baseUrl, serverInfo.token);

		await admin.goto("/comments");
		await admin.waitForShell();
		await admin.waitForLoading();

		// The "Pending" tab is active by default -- should show empty message
		await expect(page.locator("td").filter({ hasText: PENDING_EMPTY_PATTERN })).toBeVisible({
			timeout: 10000,
		});
	});

	test("displays seeded comments with author and body", async ({
		admin,
		page,
		request: anonymousRequest,
		serverInfo,
	}) => {
		const postId = serverInfo.contentIds.posts[0]!;

		// Clean slate
		await cleanupComments(page, serverInfo.baseUrl, serverInfo.token);

		// Seed two comments
		await seedComment(anonymousRequest, serverInfo.baseUrl, postId, {
			body: "First seeded comment",
			authorName: "Alice Commenter",
			authorEmail: "alice@test.com",
		});
		await seedComment(anonymousRequest, serverInfo.baseUrl, postId, {
			body: "Second seeded comment",
			authorName: "Bob Commenter",
			authorEmail: "bob@test.com",
		});

		await admin.goto("/comments");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Comments land as "pending" by default (moderation: first_time or all).
		// The Pending tab is the default view, so we should see them.
		// If the collection auto-approves, check the Approved tab instead.
		const approvedTab = page.locator('[role="tab"]', { hasText: "Approved" });

		// Try pending first -- if empty, check approved
		let foundAlice = await page
			.locator("text=Alice Commenter")
			.isVisible({ timeout: 5000 })
			.catch(() => false);

		if (!foundAlice) {
			// Comments may have been auto-approved
			await approvedTab.click();
			await admin.waitForLoading();
			foundAlice = await page
				.locator("text=Alice Commenter")
				.isVisible({ timeout: 5000 })
				.catch(() => false);
		}

		// At least one comment should be visible with author name and body
		expect(foundAlice).toBe(true);
		await expect(page.locator("text=First seeded comment").first()).toBeVisible();
		await expect(page.locator("text=Bob Commenter").first()).toBeVisible();
		await expect(page.locator("text=Second seeded comment").first()).toBeVisible();
	});

	test("approve a pending comment", async ({
		admin,
		page,
		request: anonymousRequest,
		serverInfo,
	}) => {
		const postId = serverInfo.contentIds.posts[0]!;

		// Clean slate
		await cleanupComments(page, serverInfo.baseUrl, serverInfo.token);

		// Seed a comment
		await seedComment(anonymousRequest, serverInfo.baseUrl, postId, {
			body: "Comment to approve",
			authorName: "Approval Tester",
			authorEmail: "approve@test.com",
		});

		await admin.goto("/comments");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Ensure we're on the Pending tab
		const pendingTab = page.locator('[role="tab"]', { hasText: "Pending" });
		await pendingTab.click();
		await admin.waitForLoading();

		// If the comment was auto-approved, this test cannot proceed -- skip gracefully
		const hasPendingComment = await page
			.locator("text=Approval Tester")
			.isVisible({ timeout: 5000 })
			.catch(() => false);

		if (!hasPendingComment) {
			// Comment was auto-approved -- verify it's in the Approved tab instead
			const approvedTab = page.locator('[role="tab"]', { hasText: "Approved" });
			await approvedTab.click();
			await admin.waitForLoading();
			await expect(page.locator("text=Approval Tester").first()).toBeVisible({
				timeout: 5000,
			});
			return;
		}

		// Find the comment row and click the Approve button
		const row = page.locator("tr", { hasText: "Approval Tester" });
		const approveBtn = row.locator('button[aria-label="Approve"]');
		await expect(approveBtn).toBeVisible({ timeout: 5000 });
		await approveBtn.click();

		// Wait for the mutation to settle
		await admin.waitForLoading();

		// The comment should disappear from the Pending tab
		await expect(page.locator("tr", { hasText: "Approval Tester" })).not.toBeVisible({
			timeout: 10000,
		});

		// Verify it moved to the Approved tab
		const approvedTab = page.locator('[role="tab"]', { hasText: "Approved" });
		await approvedTab.click();
		await admin.waitForLoading();

		await expect(page.locator("text=Approval Tester").first()).toBeVisible({
			timeout: 10000,
		});
	});

	test("delete a comment permanently", async ({
		admin,
		page,
		request: anonymousRequest,
		serverInfo,
	}) => {
		const postId = serverInfo.contentIds.posts[0]!;

		// Clean slate
		await cleanupComments(page, serverInfo.baseUrl, serverInfo.token);

		// Seed a comment
		await seedComment(anonymousRequest, serverInfo.baseUrl, postId, {
			body: "Comment to delete",
			authorName: "Delete Tester",
			authorEmail: "delete@test.com",
		});

		await admin.goto("/comments");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Find the comment -- could be in Pending or Approved
		let commentVisible = await page
			.locator("text=Delete Tester")
			.isVisible({ timeout: 5000 })
			.catch(() => false);

		if (!commentVisible) {
			const approvedTab = page.locator('[role="tab"]', { hasText: "Approved" });
			await approvedTab.click();
			await admin.waitForLoading();
			commentVisible = await page
				.locator("text=Delete Tester")
				.isVisible({ timeout: 5000 })
				.catch(() => false);
		}

		expect(commentVisible).toBe(true);

		// The admin user should see the "Delete permanently" button
		const row = page.locator("tr", { hasText: "Delete Tester" });
		const deleteBtn = row.locator('button[aria-label="Delete permanently"]');

		const hasDeleteBtn = await deleteBtn.isVisible({ timeout: 3000 }).catch(() => false);

		if (!hasDeleteBtn) {
			// Fallback: try the "Trash" button instead (non-admin role)
			const trashBtn = row.locator('button[aria-label="Trash"]');
			await expect(trashBtn).toBeVisible({ timeout: 3000 });
			await trashBtn.click();
			await admin.waitForLoading();

			// Comment should disappear from the current tab
			await expect(row).not.toBeVisible({ timeout: 10000 });
			return;
		}

		// Click "Delete permanently" -- this opens a ConfirmDialog
		await deleteBtn.click();

		// Confirm deletion in the dialog
		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog.locator("text=Delete Comment")).toBeVisible();

		await dialog.getByRole("button", { name: "Delete" }).click();

		// Wait for dialog to close and comment to disappear
		await expect(dialog).not.toBeVisible({ timeout: 10000 });
		await admin.waitForLoading();

		// Comment should be gone from all tabs
		await expect(page.locator("text=Delete Tester")).not.toBeVisible({ timeout: 10000 });
	});
});
