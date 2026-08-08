/**
 * Content Actions E2E Tests
 *
 * Tests content lifecycle actions that go beyond basic CRUD:
 *   - Schedule / unschedule for future publishing
 *   - Duplicate content
 *   - Soft delete (trash) and restore from trash
 *   - Permanent delete
 *   - Discard draft changes (revert to published version)
 *
 * Uses the seeded "posts" collection which supports drafts and revisions.
 */

import { test, expect } from "../fixtures";

// ---------- regex patterns ----------

const SCHEDULE_API_PATTERN = /\/api\/content\/posts\/[A-Z0-9]+\/schedule/;
const DUPLICATE_API_PATTERN = /\/api\/content\/posts\/duplicate$/;
const DISCARD_DRAFT_API_PATTERN = /\/api\/content\/posts\/[A-Z0-9]+\/discard-draft/;
const RESTORE_API_PATTERN = /\/api\/content\/posts\/[A-Z0-9]+\/restore/;
const PERMANENT_DELETE_API_PATTERN = /\/api\/content\/posts\/[A-Z0-9]+\/permanent/;

// Button/tab label patterns
const TRASH_TAB_LABEL = /Trash/i;
const RESTORE_LABEL = /Restore/i;
const PERM_DELETE_LABEL = /Permanently delete/i;

// ---------- helpers ----------

function apiHeaders(token: string, baseUrl: string) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};
}

/** Create a post via API and return its ID */
async function createPost(
	baseUrl: string,
	headers: Record<string, string>,
	title: string,
	slug: string,
): Promise<string> {
	const res = await fetch(`${baseUrl}/_emdash/api/content/posts`, {
		method: "POST",
		headers,
		body: JSON.stringify({ data: { title }, slug }),
	});
	const json: any = await res.json();
	return json.data?.item?.id ?? json.data?.id;
}

/** Publish a post via API */
async function publishPost(
	baseUrl: string,
	headers: Record<string, string>,
	id: string,
): Promise<void> {
	await fetch(`${baseUrl}/_emdash/api/content/posts/${id}/publish`, {
		method: "POST",
		headers,
		body: JSON.stringify({}),
	});
}

/** Soft-delete a post via API (move to trash) */
async function trashPost(
	baseUrl: string,
	headers: Record<string, string>,
	id: string,
): Promise<void> {
	await fetch(`${baseUrl}/_emdash/api/content/posts/${id}`, {
		method: "DELETE",
		headers,
	});
}

/** Clean up a post — trash then permanently delete, ignoring errors */
async function cleanupPost(
	baseUrl: string,
	headers: Record<string, string>,
	id: string,
): Promise<void> {
	await fetch(`${baseUrl}/_emdash/api/content/posts/${id}`, {
		method: "DELETE",
		headers,
	}).catch(() => {});
	await fetch(`${baseUrl}/_emdash/api/content/posts/${id}/permanent`, {
		method: "DELETE",
		headers,
	}).catch(() => {});
}

// ==========================================================================
// Schedule / Unschedule
// ==========================================================================

test.describe("Schedule content", () => {
	let headers: Record<string, string>;
	let baseUrl: string;
	let postId: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		// Create a fresh draft post for scheduling tests
		postId = await createPost(
			baseUrl,
			headers,
			"Schedule Test Post",
			`schedule-test-${Date.now()}`,
		);
	});

	test.afterEach(async () => {
		await cleanupPost(baseUrl, headers, postId);
	});

	test("schedule a draft post for future publishing", async ({ admin, page }) => {
		await admin.goToEditContent("posts", postId);
		await admin.waitForLoading();

		// Verify we're on the edit page with our post
		await expect(page.locator("#field-title")).toHaveValue("Schedule Test Post");

		// The "Schedule for later" button should be visible in the sidebar
		const scheduleButton = page.getByRole("button", { name: "Schedule for later" });
		await expect(scheduleButton).toBeVisible({ timeout: 5000 });
		await scheduleButton.click();

		// A datetime input should appear
		const dateInput = page.getByLabel("Schedule for");
		await expect(dateInput).toBeVisible({ timeout: 5000 });

		// Set a future date (tomorrow)
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		tomorrow.setHours(9, 0, 0, 0);
		const dateValue = tomorrow.toISOString().slice(0, 16); // datetime-local format
		await dateInput.fill(dateValue);

		// Click the "Schedule" confirm button and wait for the API response
		const scheduleResponse = page.waitForResponse(
			(res) =>
				SCHEDULE_API_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await page.getByRole("button", { name: "Schedule", exact: true }).click();
		await scheduleResponse;

		// A toast confirming scheduling should appear
		await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible({ timeout: 5000 });

		// The scheduled date info should be visible
		await expect(page.locator("text=Scheduled for:")).toBeVisible({ timeout: 5000 });

		// An "Unschedule" button should be visible
		await expect(page.getByRole("button", { name: "Unschedule" })).toBeVisible();
	});

	test("unschedule a scheduled post", async ({ admin, page }) => {
		// Schedule the post via API first
		const tomorrow = new Date();
		tomorrow.setDate(tomorrow.getDate() + 1);
		await fetch(`${baseUrl}/_emdash/api/content/posts/${postId}/schedule`, {
			method: "POST",
			headers,
			body: JSON.stringify({ scheduledAt: tomorrow.toISOString() }),
		});

		await admin.goToEditContent("posts", postId);
		await admin.waitForLoading();

		// Verify scheduled state is shown
		await expect(page.locator("text=Scheduled for:")).toBeVisible({ timeout: 5000 });

		// Click unschedule and wait for API response
		const unscheduleResponse = page.waitForResponse(
			(res) =>
				SCHEDULE_API_PATTERN.test(res.url()) &&
				res.request().method() === "DELETE" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await page.getByRole("button", { name: "Unschedule" }).click();
		await unscheduleResponse;

		// The scheduled info should disappear
		await expect(page.locator("text=Scheduled for:")).not.toBeVisible({ timeout: 5000 });

		// The "Schedule for later" button should reappear
		await expect(page.getByRole("button", { name: "Schedule for later" })).toBeVisible({
			timeout: 5000,
		});
	});
});

// ==========================================================================
// Duplicate
// ==========================================================================

test.describe("Duplicate content", () => {
	let headers: Record<string, string>;
	let baseUrl: string;
	let postId: string;
	let duplicateId: string | undefined;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		postId = await createPost(
			baseUrl,
			headers,
			"Duplicate Source Post",
			`dup-source-${Date.now()}`,
		);
	});

	test.afterEach(async () => {
		await cleanupPost(baseUrl, headers, postId);
		if (duplicateId) {
			await cleanupPost(baseUrl, headers, duplicateId);
		}
	});

	test("duplicate a post from the content list", async ({ admin, page }) => {
		await admin.goToContent("posts");
		await admin.waitForLoading();

		// Find the row for our post and click the duplicate button
		const row = page.locator("tr", { hasText: "Duplicate Source Post" });
		await expect(row).toBeVisible({ timeout: 5000 });

		await row.getByRole("button", { name: "Duplicate Duplicate Source Post" }).click();

		// The action always confirms first, so nothing is copied on the click alone.
		const confirm = page
			.getByRole("dialog")
			.getByRole("button", { name: "Duplicate", exact: true });
		await expect(confirm).toBeEnabled({ timeout: 10000 });

		const duplicateResponse = page.waitForResponse(
			(res) =>
				DUPLICATE_API_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				(res.status() === 200 || res.status() === 201),
			{ timeout: 10000 },
		);
		await confirm.click();
		const response = await duplicateResponse;
		const body = await response.json();
		duplicateId = body.data?.results?.[0]?.targetId;

		// Wait for the list to refresh
		await admin.waitForLoading();

		// A copy should now appear in the list (typically with "(Copy)" suffix or similar)
		// Reload to ensure fresh data
		await page.reload();
		await admin.waitForShell();
		await admin.waitForLoading();

		// The duplicate should exist -- verify via API since the title pattern may vary
		expect(duplicateId).toBeTruthy();
		const getRes = await fetch(`${baseUrl}/_emdash/api/content/posts/${duplicateId}`, {
			headers,
		});
		expect(getRes.ok).toBe(true);
	});

	test("duplicate a post from the editor", async ({ admin, page }) => {
		await admin.goToEditContent("posts", postId);
		await admin.waitForLoading();

		await page.getByRole("button", { name: "Duplicate…" }).click();

		const confirm = page
			.getByRole("dialog")
			.getByRole("button", { name: "Duplicate", exact: true });
		await expect(confirm).toBeEnabled({ timeout: 10000 });

		const duplicateResponse = page.waitForResponse(
			(res) => DUPLICATE_API_PATTERN.test(res.url()) && res.request().method() === "POST",
			{ timeout: 10000 },
		);
		await confirm.click();
		const body = await (await duplicateResponse).json();
		duplicateId = body.data?.results?.[0]?.targetId;
		expect(duplicateId).toBeTruthy();

		// The editor follows the copy rather than leaving the original open.
		await expect(page).toHaveURL(new RegExp(`/content/posts/${duplicateId}`), { timeout: 10000 });
	});
});

// ==========================================================================
// Trash (soft delete) and Restore
// ==========================================================================

test.describe("Trash and restore content", () => {
	let headers: Record<string, string>;
	let baseUrl: string;
	let postId: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		postId = await createPost(baseUrl, headers, "Trash Test Post", `trash-test-${Date.now()}`);
	});

	test.afterEach(async () => {
		await cleanupPost(baseUrl, headers, postId);
	});

	test("move a post to trash from the content list", async ({ admin, page }) => {
		await admin.goToContent("posts");
		await admin.waitForLoading();

		// Find the row and click the trash button
		const row = page.locator("tr", { hasText: "Trash Test Post" });
		await expect(row).toBeVisible({ timeout: 5000 });
		await row.getByRole("button", { name: "Move Trash Test Post to trash" }).click();

		// A confirmation dialog should appear
		const dialog = page.locator('[role="dialog"]').filter({ hasText: "Move to Trash?" });
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog.locator("text=Trash Test Post")).toBeVisible();

		// Confirm the deletion
		const deleteResponse = page.waitForResponse(
			(res) =>
				res.url().includes(`/api/content/posts/${postId}`) &&
				res.request().method() === "DELETE" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await dialog.getByRole("button", { name: "Move to Trash" }).click();
		await deleteResponse;

		// The dialog should close
		await expect(dialog).not.toBeVisible({ timeout: 5000 });

		// The post should no longer appear in the "All" tab
		await admin.waitForLoading();
		await expect(page.locator("tr", { hasText: "Trash Test Post" })).not.toBeVisible({
			timeout: 5000,
		});
	});

	test("restore a trashed post from the trash tab", async ({ admin, page }) => {
		// Trash the post via API first
		await trashPost(baseUrl, headers, postId);

		await admin.goToContent("posts");
		await admin.waitForLoading();

		// Switch to the Trash tab
		const trashTab = page.getByRole("tab", { name: TRASH_TAB_LABEL });
		await expect(trashTab).toBeVisible({ timeout: 5000 });
		await trashTab.click();

		// Wait for trashed items to load
		await admin.waitForLoading();

		// The trashed post should appear
		const trashedRow = page.locator("tr", { hasText: "Trash Test Post" });
		await expect(trashedRow).toBeVisible({ timeout: 10000 });

		// Click the restore button
		const restoreResponse = page.waitForResponse(
			(res) =>
				RESTORE_API_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await trashedRow.getByRole("button", { name: RESTORE_LABEL }).click();
		await restoreResponse;

		// Wait for the list to refresh
		await admin.waitForLoading();

		// Switch back to the All tab
		const allTab = page.getByRole("tab", { name: "All" });
		await allTab.click();
		await admin.waitForLoading();

		// The post should be back in the main list
		await expect(page.locator("tr", { hasText: "Trash Test Post" })).toBeVisible({
			timeout: 10000,
		});
	});
});

// ==========================================================================
// Permanent delete
// ==========================================================================

test.describe("Permanent delete", () => {
	let headers: Record<string, string>;
	let baseUrl: string;
	let postId: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		postId = await createPost(baseUrl, headers, "Permanent Delete Post", `perm-del-${Date.now()}`);
		// Trash it first -- permanent delete only works on trashed items
		await trashPost(baseUrl, headers, postId);
	});

	test("permanently delete a trashed post", async ({ admin, page }) => {
		await admin.goToContent("posts");
		await admin.waitForLoading();

		// Switch to the Trash tab
		const trashTab = page.getByRole("tab", { name: TRASH_TAB_LABEL });
		await trashTab.click();
		await admin.waitForLoading();

		// The trashed post should appear
		const trashedRow = page.locator("tr", { hasText: "Permanent Delete Post" });
		await expect(trashedRow).toBeVisible({ timeout: 10000 });

		// Click the permanent delete button (trash icon in trash view)
		await trashedRow.getByRole("button", { name: PERM_DELETE_LABEL }).click();

		// A confirmation dialog should appear
		const dialog = page.locator('[role="dialog"]').filter({ hasText: "Delete Permanently?" });
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog.locator("text=Permanent Delete Post")).toBeVisible();

		// Confirm permanent deletion
		const permanentDeleteResponse = page.waitForResponse(
			(res) =>
				PERMANENT_DELETE_API_PATTERN.test(res.url()) &&
				res.request().method() === "DELETE" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await dialog.getByRole("button", { name: "Delete Permanently" }).click();
		await permanentDeleteResponse;

		// The dialog should close
		await expect(dialog).not.toBeVisible({ timeout: 5000 });

		// The post should disappear from the trash
		await admin.waitForLoading();
		await expect(page.locator("tr", { hasText: "Permanent Delete Post" })).not.toBeVisible({
			timeout: 5000,
		});

		// Verify via API that the post is truly gone
		const getRes = await fetch(`${baseUrl}/_emdash/api/content/posts/${postId}`, { headers });
		expect(getRes.status).toBe(404);
	});
});

// ==========================================================================
// Discard draft changes
// ==========================================================================

test.describe("Discard draft changes", () => {
	let headers: Record<string, string>;
	let baseUrl: string;
	let postId: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		// Create and publish a post
		postId = await createPost(
			baseUrl,
			headers,
			"Published Original Title",
			`discard-draft-${Date.now()}`,
		);
		await publishPost(baseUrl, headers, postId);
	});

	test.afterEach(async () => {
		await cleanupPost(baseUrl, headers, postId);
	});

	test("discard draft reverts to the published version", async ({ admin, page }) => {
		// Navigate to the editor and make changes to create a draft
		await admin.goToEditContent("posts", postId);
		await admin.waitForLoading();

		// Verify the published title
		const titleInput = page.locator("#field-title");
		await expect(titleInput).toHaveValue("Published Original Title");

		// Edit the title
		await titleInput.fill("Draft Modified Title");

		// Save to create a draft revision
		await admin.clickSave();
		await admin.waitForSaveComplete();

		// The "Pending changes" badge should appear
		await expect(page.locator("text=Pending changes")).toBeVisible({ timeout: 5000 });

		// The "Discard changes" button should be visible
		const discardButton = page.getByRole("button", { name: "Discard changes" });
		await expect(discardButton).toBeVisible({ timeout: 5000 });
		await discardButton.click();

		// A confirmation dialog should appear
		const dialog = page.locator('[role="dialog"]').filter({ hasText: "Discard draft changes?" });
		await expect(dialog).toBeVisible({ timeout: 5000 });

		// Confirm discarding the draft
		const discardResponse = page.waitForResponse(
			(res) =>
				DISCARD_DRAFT_API_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await dialog.getByRole("button", { name: "Discard changes" }).click();
		await discardResponse;

		// Wait for the page to update
		await admin.waitForLoading();

		// The title should revert to the published version
		await expect(titleInput).toHaveValue("Published Original Title", { timeout: 10000 });

		// The "Pending changes" badge should be gone
		await expect(page.locator("text=Pending changes")).not.toBeVisible({ timeout: 5000 });

		// The "Discard changes" button should also be gone
		await expect(discardButton).not.toBeVisible({ timeout: 5000 });
	});
});

// ==========================================================================
// Trash from the editor
// ==========================================================================

test.describe("Trash from editor", () => {
	let headers: Record<string, string>;
	let baseUrl: string;
	let postId: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		postId = await createPost(baseUrl, headers, "Editor Trash Post", `editor-trash-${Date.now()}`);
	});

	test.afterEach(async () => {
		await cleanupPost(baseUrl, headers, postId);
	});

	test("move a post to trash from the editor sidebar", async ({ admin, page }) => {
		await admin.goToEditContent("posts", postId);
		await admin.waitForLoading();

		// The "Move to Trash" button should be in the sidebar
		const trashButton = page.getByRole("button", { name: "Move to Trash" });
		await expect(trashButton).toBeVisible({ timeout: 5000 });
		await trashButton.click();

		// A confirmation dialog should appear
		const dialog = page.locator('[role="dialog"]').filter({ hasText: "Move to Trash?" });
		await expect(dialog).toBeVisible({ timeout: 5000 });

		// Confirm trashing
		const deleteResponse = page.waitForResponse(
			(res) =>
				res.url().includes(`/api/content/posts/${postId}`) &&
				res.request().method() === "DELETE" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await dialog.getByRole("button", { name: "Move to Trash" }).click();
		await deleteResponse;

		// Should navigate back to the content list (or show a confirmation)
		// Verify the post is trashed via API
		const getRes = await fetch(`${baseUrl}/_emdash/api/content/posts/${postId}`, { headers });
		expect(getRes.status).toBe(404);
	});
});
