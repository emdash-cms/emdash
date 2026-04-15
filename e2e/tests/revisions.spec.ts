/**
 * Revisions E2E Tests
 *
 * Tests revision history in the content editor.
 * Creates a dedicated collection with revision support because the
 * fixture seed's posts collection doesn't include `supports: ["revisions"]`.
 *
 * Covers:
 *   - Edit creates a new revision
 *   - Revision history panel shows revisions
 *   - Restoring a revision updates content
 */

import { test, expect } from "../fixtures";

// Regex patterns
const REVISIONS_API_PATTERN = /\/api\/content\/[^/]+\/[^/]+\/revisions/;

// API helper
function apiHeaders(token: string, baseUrl: string) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};
}

test.describe("Revisions", () => {
	let collectionSlug: string;
	let postId: string;
	let headers: Record<string, string>;
	let baseUrl: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();

		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		// Create a collection with revision + draft support
		collectionSlug = `rev_test_${Date.now()}`;
		await fetch(`${baseUrl}/_emdash/api/schema/collections`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: collectionSlug,
				label: "Revision Test",
				labelSingular: "Revision Test",
				supports: ["revisions", "drafts"],
			}),
		});

		// Add a title field
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}/fields`, {
			method: "POST",
			headers,
			body: JSON.stringify({ slug: "title", type: "string", label: "Title", required: true }),
		});

		// Add an excerpt field for multi-field revision diffs
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}/fields`, {
			method: "POST",
			headers,
			body: JSON.stringify({ slug: "excerpt", type: "text", label: "Excerpt" }),
		});

		// Create and publish a post (publishing creates the first live revision)
		const createRes = await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				data: { title: "Original Title", excerpt: "Original excerpt" },
				slug: "revision-test-post",
			}),
		});
		const createData: any = await createRes.json();
		postId = createData.data?.item?.id ?? createData.data?.id;

		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/publish`, {
			method: "POST",
			headers,
			body: JSON.stringify({}),
		});
	});

	test.afterEach(async () => {
		// Clean up test data
		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
	});

	test("revision history panel is visible for collections with revision support", async ({
		admin,
		page,
	}) => {
		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		// The title field should have the original value
		await expect(page.locator("#field-title")).toHaveValue("Original Title");

		// The Revisions panel should be visible (collapsed by default)
		const revisionsButton = page.locator("button", { hasText: "Revisions" });
		await expect(revisionsButton).toBeVisible({ timeout: 10000 });
	});

	test("expanding revision history shows existing revisions", async ({ admin, page }) => {
		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		// Click on the Revisions header to expand
		const revisionsButton = page.locator("button", { hasText: "Revisions" });
		await revisionsButton.click();

		// Wait for revisions to load (API call)
		await page
			.waitForResponse((res) => REVISIONS_API_PATTERN.test(res.url()) && res.status() === 200, {
				timeout: 10000,
			})
			.catch(() => {});

		// Should show at least one revision entry
		// The latest revision has a "Current" badge (a span.badge element)
		const currentBadge = page.locator("span.rounded-full", { hasText: "Current" });
		await expect(currentBadge.first()).toBeVisible({ timeout: 10000 });
	});

	test("editing and saving creates a new revision", async ({ admin, page }) => {
		// Get initial revision count
		const initialRes = await fetch(
			`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/revisions`,
			{ headers },
		);
		const initialData: any = await initialRes.json();
		const initialCount = initialData.data?.total ?? 0;

		// Navigate to edit
		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		const titleInput = page.locator("#field-title");
		await expect(titleInput).toHaveValue("Original Title");

		// Wait for any initial autosave to settle
		await page.waitForTimeout(3000);

		// Edit the title -- autosave will fire after debounce
		const contentUrl = `/_emdash/api/content/${collectionSlug}/${postId}`;
		const autosavePut = page.waitForResponse(
			(res) => res.url().includes(contentUrl) && res.request().method() === "PUT",
			{ timeout: 15000 },
		);

		await titleInput.fill("Updated Title for Revision");
		const response = await autosavePut;
		expect(response.status()).toBe(200);

		// Wait for autosave indicator
		await expect(page.getByRole("status", { name: "Autosave status" })).toContainText("Saved", {
			timeout: 5000,
		});

		// Now publish to create a new live revision
		const publishButton = page.getByRole("button", { name: "Publish" });
		if (await publishButton.isVisible({ timeout: 3000 }).catch(() => false)) {
			await publishButton.click();
			await admin.waitForLoading();
		}

		// Check that revision count increased
		const afterRes = await fetch(
			`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/revisions`,
			{ headers },
		);
		const afterData: any = await afterRes.json();
		const afterCount = afterData.data?.total ?? 0;

		expect(afterCount).toBeGreaterThan(initialCount);
	});

	test("can view a revision's data by clicking on it", async ({ admin, page }) => {
		// Create a second revision by updating via API + publishing
		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ data: { title: "Second Version", excerpt: "Updated excerpt" } }),
		});
		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/publish`, {
			method: "POST",
			headers,
			body: JSON.stringify({}),
		});

		// Navigate to edit
		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		// Expand revisions panel
		const revisionsButton = page.locator("button", { hasText: "Revisions" });
		await revisionsButton.click();

		// Wait for revisions to load
		await page
			.waitForResponse((res) => REVISIONS_API_PATTERN.test(res.url()) && res.status() === 200, {
				timeout: 10000,
			})
			.catch(() => {});

		// Should see the "Current" badge on the latest revision
		await expect(page.locator("span.rounded-full", { hasText: "Current" }).first()).toBeVisible({
			timeout: 10000,
		});

		// There should be multiple revision items (rounded-md border entries)
		const revisionItems = page.locator(".rounded-md.border.p-3");
		const count = await revisionItems.count();
		expect(count).toBeGreaterThanOrEqual(2);

		// Click on the non-latest (older) revision to view its data
		// The second item (index 1) is the older revision
		const olderRevision = revisionItems.nth(1);
		await olderRevision.locator("button.flex-1.text-start").click();

		// A diff view or snapshot should appear
		// Look for either "Content snapshot" or a diff with field changes
		const snapshotOrDiff = page.locator("text=Content snapshot").or(page.locator("text=change"));
		await expect(snapshotOrDiff.first()).toBeVisible({ timeout: 5000 });
	});

	test("restoring a revision updates the content", async ({ admin, page }) => {
		const originalTitle = "Original Title";

		// Create a second version via API
		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ data: { title: "Changed Title", excerpt: "Changed excerpt" } }),
		});
		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/publish`, {
			method: "POST",
			headers,
			body: JSON.stringify({}),
		});

		// Get revision list to find the older revision's ID
		const revisionsRes = await fetch(
			`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/revisions`,
			{ headers },
		);
		const revisionsData: any = await revisionsRes.json();
		const revisions = revisionsData.data?.items ?? [];

		// Need at least 2 revisions to restore
		expect(revisions.length).toBeGreaterThanOrEqual(2);

		// The first item (index 0) is the latest, older ones follow
		const olderRevision = revisions[1];
		expect(olderRevision).toBeDefined();

		// Navigate to the editor
		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		// Verify we have the latest title
		await expect(page.locator("#field-title")).toHaveValue("Changed Title");

		// Expand revisions
		const revisionsButton = page.locator("button", { hasText: "Revisions" });
		await revisionsButton.click();

		// Wait for revisions to load
		await page
			.waitForResponse((res) => REVISIONS_API_PATTERN.test(res.url()) && res.status() === 200, {
				timeout: 10000,
			})
			.catch(() => {});

		// Wait for revision items to render
		const revisionItems = page.locator(".rounded-md.border.p-3");
		await expect(revisionItems.first()).toBeVisible({ timeout: 10000 });

		// Find the restore button on the older revision (not the "Current" one)
		// The restore button uses ArrowCounterClockwise icon and title="Restore this version"
		const restoreButton = page.locator('button[title="Restore this version"]').first();
		await expect(restoreButton).toBeVisible({ timeout: 5000 });

		// Click restore -- this opens a ConfirmDialog
		await restoreButton.click();

		// ConfirmDialog should appear
		const confirmDialog = page.getByRole("dialog", { name: "Restore Revision" });
		await expect(confirmDialog).toBeVisible({ timeout: 5000 });

		// Confirm the restore
		await confirmDialog.getByRole("button", { name: "Restore" }).click();

		// Wait for the restore to complete
		await expect(confirmDialog).not.toBeVisible({ timeout: 10000 });

		// Wait for the page to update with restored content
		await admin.waitForLoading();

		// Verify via API that the content was restored
		const contentRes = await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}`, {
			headers,
		});
		const contentData: any = await contentRes.json();
		const currentTitle = contentData.data?.item?.data?.title ?? contentData.data?.item?.title;

		// The title should be back to the original
		expect(currentTitle).toBe(originalTitle);
	});

	test("restore creates a new revision in the history", async ({ admin: _admin }) => {
		// Create a second version
		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}`, {
			method: "PUT",
			headers,
			body: JSON.stringify({ data: { title: "Version 2", excerpt: "v2 excerpt" } }),
		});
		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/publish`, {
			method: "POST",
			headers,
			body: JSON.stringify({}),
		});

		// Get revision count before restore
		const beforeRes = await fetch(
			`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/revisions`,
			{ headers },
		);
		const beforeData: any = await beforeRes.json();
		const countBefore = beforeData.data?.total ?? 0;
		const revisions = beforeData.data?.items ?? [];

		expect(revisions.length).toBeGreaterThanOrEqual(2);
		const olderRevisionId = revisions[1].id;

		// Restore via API
		const restoreRes = await fetch(`${baseUrl}/_emdash/api/revisions/${olderRevisionId}/restore`, {
			method: "POST",
			headers,
		});
		expect(restoreRes.status).toBe(200);

		// Get revision count after restore -- should have increased
		const afterRes = await fetch(
			`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}/revisions`,
			{ headers },
		);
		const afterData: any = await afterRes.json();
		const countAfter = afterData.data?.total ?? 0;

		expect(countAfter).toBeGreaterThan(countBefore);
	});
});
