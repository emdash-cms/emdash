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

import type { Locator, Page } from "@playwright/test";

import { test, expect } from "../fixtures";

// ---------- regex patterns ----------

const SCHEDULE_API_PATTERN = /\/api\/content\/posts\/[A-Z0-9]+\/schedule/;
const DUPLICATE_API_PATTERN = /\/api\/content\/posts\/[A-Z0-9]+\/duplicate/;
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

function localDateKey(date: Date): string {
	return [
		date.getFullYear(),
		String(date.getMonth() + 1).padStart(2, "0"),
		String(date.getDate()).padStart(2, "0"),
	].join("-");
}

async function selectTomorrow(dialog: Locator) {
	const tomorrow = new Date();
	tomorrow.setDate(tomorrow.getDate() + 1);
	await dialog.locator(`[data-day="${localDateKey(tomorrow)}"] button`).click();
}

async function fillTime(page: Page, dialog: Locator, value: `${string}:${string}`) {
	const [hour = "", minute = ""] = value.split(":");
	const hour24 = Number(hour);
	const displayHour = String(hour24 % 12 || 12).padStart(2, "0");
	await dialog.getByRole("textbox", { name: "Hour" }).fill(displayHour);
	await dialog.getByRole("textbox", { name: "Minute" }).fill(minute);
	const desiredPeriod = hour24 >= 12 ? "PM" : "AM";
	const period = dialog.getByRole("combobox", { name: "Period" });
	if (!(await period.textContent())?.includes(desiredPeriod)) {
		await period.click();
		await page.getByRole("option", { name: desiredPeriod, exact: true }).click();
	}
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
	let postSlug: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		// Create a fresh draft post for scheduling tests
		postSlug = `schedule-test-${Date.now()}`;
		postId = await createPost(baseUrl, headers, "Schedule Test Post", postSlug);
	});

	test.afterEach(async () => {
		await cleanupPost(baseUrl, headers, postId);
	});

	test("schedule a draft post for future publishing", async ({ admin, page }) => {
		await admin.goToEditContent("posts", postId);
		await admin.waitForLoading();

		// Verify we're on the edit page with our post
		await expect(page.locator("#field-title")).toHaveValue("Schedule Test Post");

		const publishButton = page.getByRole("button", { name: "Publish", exact: true });
		await expect(publishButton).toBeVisible({ timeout: 5000 });
		await publishButton.click();
		await page.getByRole("menuitem", { name: /Schedule publication/ }).click();

		const dialog = page.getByRole("dialog", { name: "Schedule publication" });
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await selectTomorrow(dialog);
		await fillTime(page, dialog, "14:43");
		const minuteInput = dialog.getByRole("textbox", { name: "Minute" });
		await expect(minuteInput).toHaveValue("43");

		// Submit from the time field and wait for the API response.
		const scheduleResponse = page.waitForResponse(
			(res) =>
				SCHEDULE_API_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await minuteInput.press("Enter");
		await scheduleResponse;

		// A toast confirming scheduling should appear
		await expect(page.getByRole("heading", { name: "Scheduled" })).toBeVisible({ timeout: 5000 });

		await expect(page.getByText("First publication", { exact: true })).toBeVisible({
			timeout: 5000,
		});
		const scheduledButton = page.getByRole("button", { name: "Scheduled", exact: true });
		await expect(scheduledButton).toBeVisible();
		await scheduledButton.click();
		await expect(page.getByRole("menuitem", { name: /Change schedule/ })).toBeVisible();
		await expect(page.getByRole("menuitem", { name: /Remove schedule/ })).toBeVisible();
	});

	test("keeps publishing choices usable in a 320-pixel viewport", async ({ admin, page }) => {
		await admin.goToEditContent("posts", postId);
		await admin.waitForLoading();
		await page.setViewportSize({ width: 320, height: 576 });

		const publishButton = page.getByRole("button", { name: "Publish", exact: true });
		await publishButton.focus();
		await page.keyboard.press("Enter");
		await page.keyboard.press("ArrowDown");
		await expect(page.locator('[role="menuitem"][data-highlighted]')).toHaveCount(1);
		await expect(page.getByText("Choose when this draft goes live", { exact: true })).toHaveCount(
			0,
		);
		await page.keyboard.press("Escape");
		await expect(publishButton).toBeFocused();
		await publishButton.click();
		const menu = page.getByRole("menu", { name: "Publish" });
		const menuBox = await menu.boundingBox();
		expect(menuBox).not.toBeNull();
		expect(menuBox!.x).toBeGreaterThanOrEqual(0);
		expect(menuBox!.x + menuBox!.width).toBeLessThanOrEqual(320);

		await page.getByRole("menuitem", { name: /Schedule publication/ }).click();
		const dialog = page.getByRole("dialog", { name: "Schedule publication" });
		const dialogBox = await dialog.boundingBox();
		expect(dialogBox).not.toBeNull();
		expect(dialogBox!.x).toBeGreaterThanOrEqual(0);
		expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(320);
		expect(dialogBox!.y).toBeGreaterThanOrEqual(0);
		expect(dialogBox!.y + dialogBox!.height).toBeLessThanOrEqual(576);
		const timeSpacing = await dialog.getByRole("group", { name: "Time" }).evaluate((fieldset) => {
			const legend = fieldset.querySelector("legend")!;
			const picker = legend.nextElementSibling!;
			return picker.getBoundingClientRect().top - legend.getBoundingClientRect().bottom;
		});
		expect(timeSpacing).toBeGreaterThanOrEqual(7);
		expect(timeSpacing).toBeLessThanOrEqual(9);
		const calendarBox = await dialog.locator(".rdp-root").boundingBox();
		expect(calendarBox).not.toBeNull();
		const calendarStart = calendarBox!.x - dialogBox!.x;
		const calendarEnd = dialogBox!.x + dialogBox!.width - (calendarBox!.x + calendarBox!.width);
		expect(Math.abs(calendarStart - calendarEnd)).toBeLessThan(2);
		await expect(dialog.getByRole("button", { name: /Tomorrow at/ })).toHaveCount(0);
		await expect(dialog.getByRole("button", { name: /Next .* at/ })).toHaveCount(0);
		expect(await dialog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
			true,
		);
		expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
			320,
		);
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

		await expect(page.getByText("First publication", { exact: true })).toBeVisible({
			timeout: 5000,
		});

		// Click unschedule and wait for API response
		const unscheduleResponse = page.waitForResponse(
			(res) =>
				SCHEDULE_API_PATTERN.test(res.url()) &&
				res.request().method() === "DELETE" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await page.getByRole("button", { name: "Scheduled", exact: true }).click();
		await page.getByRole("menuitem", { name: /Remove schedule/ }).click();
		await unscheduleResponse;

		await expect(page.getByText("Draft version", { exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(page.getByRole("button", { name: "Publish", exact: true })).toBeVisible();
	});

	test("keeps the live version public while a draft update is scheduled and removed", async ({
		admin,
		page,
	}) => {
		await publishPost(baseUrl, headers, postId);
		await admin.goToEditContent("posts", postId);
		await admin.waitForLoading();

		const title = page.locator("#field-title");
		await expect(title).toHaveValue("Schedule Test Post");
		await title.fill("Scheduled Draft Update");
		await admin.clickSave();
		await admin.waitForSaveComplete();

		await expect(page.getByText("Live version", { exact: true })).toBeVisible();
		await expect(page.getByText("Draft changes", { exact: true })).toBeVisible();
		let publicResponse = await fetch(`${baseUrl}/posts/${postSlug}`);
		expect(publicResponse.ok).toBe(true);
		let publicHtml = await publicResponse.text();
		expect(publicHtml).toContain("Schedule Test Post");
		expect(publicHtml).not.toContain("Scheduled Draft Update");

		const publicationDateTrigger = page.getByRole("button", {
			name: /Change publication date:/,
		});
		const publishingSummary = page.getByRole("group", { name: "Publishing summary" });
		const createdAndUpdatedTrigger = publishingSummary.getByRole("button", {
			name: "Created and updated",
		});
		const statusIconBox = await publishingSummary.locator("svg").first().boundingBox();
		const publicationLabelBox = await publicationDateTrigger
			.getByText("Publication date", { exact: true })
			.boundingBox();
		const createdAndUpdatedLabelBox = await createdAndUpdatedTrigger
			.locator("span")
			.filter({ hasText: /^Created and updated$/ })
			.last()
			.boundingBox();
		const publicationButtonBox = await publicationDateTrigger.boundingBox();
		const createdAndUpdatedButtonBox = await createdAndUpdatedTrigger.boundingBox();
		for (const box of [
			statusIconBox,
			publicationLabelBox,
			createdAndUpdatedLabelBox,
			publicationButtonBox,
			createdAndUpdatedButtonBox,
		]) {
			expect(box).not.toBeNull();
		}
		expect(Math.abs(publicationLabelBox!.x - statusIconBox!.x)).toBeLessThanOrEqual(1);
		expect(Math.abs(createdAndUpdatedLabelBox!.x - statusIconBox!.x)).toBeLessThanOrEqual(1);
		expect(statusIconBox!.x - publicationButtonBox!.x).toBeGreaterThanOrEqual(7);
		expect(statusIconBox!.x - createdAndUpdatedButtonBox!.x).toBeGreaterThanOrEqual(7);
		const publicationDateLayout = await publicationDateTrigger.evaluate((element) => {
			(element as HTMLElement).style.width = "296px";
			const label = element.querySelector(".text-kumo-subtle")!;
			const value = element.querySelector("time")!;
			const lineCount = (target: Element) => {
				const range = document.createRange();
				range.selectNodeContents(target);
				return range.getClientRects().length;
			};
			return {
				height: element.getBoundingClientRect().height,
				labelLines: lineCount(label),
				valueLines: lineCount(value),
			};
		});
		expect(publicationDateLayout).toEqual({ height: 36, labelLines: 1, valueLines: 1 });
		await publicationDateTrigger.click();
		const publicationDateDialog = page.getByRole("dialog", {
			name: "Change publication date",
		});
		await expect(
			publicationDateDialog.getByText("Change the recorded date for the live version.", {
				exact: true,
			}),
		).toHaveCount(0);
		await expect(publicationDateDialog.getByRole("textbox", { name: "Hour" })).toBeVisible();
		await expect(publicationDateDialog.getByRole("textbox", { name: "Minute" })).toBeVisible();
		expect(await publicationDateDialog.locator('input[type="time"]').count()).toBe(0);
		await publicationDateDialog.getByRole("button", { name: "Cancel", exact: true }).click();
		await expect(publicationDateTrigger).toBeFocused();

		const publishChanges = page.getByRole("button", { name: "Publish changes", exact: true });
		const publishChangesLayout = await publishChanges.evaluate((element) => {
			const button = element.getBoundingClientRect();
			const caret = element.querySelector("svg")!.getBoundingClientRect();
			const label = element.querySelector("span.truncate")!.getBoundingClientRect();
			return {
				labelCenterOffset: Math.abs(
					button.left + button.width / 2 - (label.left + label.width / 2),
				),
				trailingGap: button.right - caret.right,
			};
		});
		expect(publishChangesLayout.labelCenterOffset).toBeLessThanOrEqual(1);
		expect(publishChangesLayout.trailingGap).toBeLessThanOrEqual(16);
		await publishChanges.click();
		await page.getByRole("menuitem", { name: /Schedule changes/ }).click();
		const dialog = page.getByRole("dialog", { name: "Schedule changes" });
		await expect(
			dialog.getByText("Choose when these changes replace the live version.", { exact: true }),
		).toBeVisible();
		await selectTomorrow(dialog);
		await fillTime(page, dialog, "09:00");
		const scheduleResponse = page.waitForResponse(
			(res) =>
				SCHEDULE_API_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await dialog.getByRole("button", { name: "Schedule changes", exact: true }).click();
		await scheduleResponse;

		await expect(page.getByRole("button", { name: "Scheduled update", exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(
			page.getByText("Visitors see the published version until the scheduled update", {
				exact: true,
			}),
		).toBeVisible();
		await expect(page.getByText("Draft changes", { exact: true })).toBeVisible();
		publicResponse = await fetch(`${baseUrl}/posts/${postSlug}`);
		publicHtml = await publicResponse.text();
		expect(publicHtml).toContain("Schedule Test Post");
		expect(publicHtml).not.toContain("Scheduled Draft Update");

		await page.getByRole("button", { name: "Scheduled update", exact: true }).click();
		const unscheduleResponse = page.waitForResponse(
			(res) =>
				SCHEDULE_API_PATTERN.test(res.url()) &&
				res.request().method() === "DELETE" &&
				res.status() === 200,
			{ timeout: 10000 },
		);
		await page.getByRole("menuitem", { name: /Remove schedule/ }).click();
		await unscheduleResponse;

		await expect(page.getByRole("button", { name: "Publish changes", exact: true })).toBeVisible({
			timeout: 5000,
		});
		await expect(
			page.getByText("Ready to publish now or schedule for later", { exact: true }),
		).toBeVisible();
		publicResponse = await fetch(`${baseUrl}/posts/${postSlug}`);
		publicHtml = await publicResponse.text();
		expect(publicHtml).toContain("Schedule Test Post");
		expect(publicHtml).not.toContain("Scheduled Draft Update");
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

		const duplicateResponse = page.waitForResponse(
			(res) =>
				DUPLICATE_API_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				(res.status() === 200 || res.status() === 201),
			{ timeout: 10000 },
		);

		await row.getByRole("button", { name: "Duplicate Duplicate Source Post" }).click();
		const response = await duplicateResponse;
		const body = await response.json();
		duplicateId = body.data?.item?.id ?? body.data?.id;

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

		await expect(page.getByText("Draft changes", { exact: true })).toBeVisible({ timeout: 5000 });

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

		await expect(page.getByText("Draft changes", { exact: true })).not.toBeVisible({
			timeout: 5000,
		});

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
