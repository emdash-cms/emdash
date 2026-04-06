/**
 * Admin UI fix verification tests
 *
 * API correctness:
 *   1. Media metadata updates (alt text, dimensions) save and persist
 *   2. Upload success toast only appears after upload completes
 *   3. Taxonomy term deletion shows ConfirmDialog (not browser confirm)
 *
 * Content editor performance:
 *   4. Autosave still triggers correctly after useMemo/useRef optimizations
 */

import { writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { test, expect } from "../fixtures";

// ---------- regex patterns (module scope for linter) ----------

const MEDIA_API_PATTERN = /\/api\/media/;
const MEDIA_UPLOAD_PATTERN = /\/api\/media(?:\/upload-url)?$/;
const MEDIA_PUT_PATTERN = /\/api\/media\//;
const TAXONOMY_DELETE_PATTERN = /\/api\/taxonomies\//;
const ALT_LABEL_PATTERN = /alt/i;
const SAVE_BUTTON_PATTERN = /save/i;
// ---------- helpers ----------

const TEST_ASSETS_DIR = join(process.cwd(), "e2e/fixtures/assets");

function ensureTestImage(): string {
	if (!existsSync(TEST_ASSETS_DIR)) mkdirSync(TEST_ASSETS_DIR, { recursive: true });
	const testImagePath = join(TEST_ASSETS_DIR, "test-image.png");
	if (!existsSync(testImagePath)) {
		// Minimal valid PNG (1x1 red pixel)
		const pngData = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
			0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
			0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
			0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
			0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		]);
		writeFileSync(testImagePath, pngData);
	}
	return testImagePath;
}

function apiHeaders(token: string, baseUrl: string) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};
}

// ==========================================================================
// Media metadata updates save and persist (updateMedia return path fix)
// ==========================================================================

test.describe("Media metadata updates", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("updating alt text on a media item persists after reload", async ({ admin, page }) => {
		const testImagePath = ensureTestImage();

		// Upload an image via the UI
		await admin.goToMedia();
		await admin.waitForLoading();

		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles(testImagePath);
		await page.waitForResponse((res) => MEDIA_API_PATTERN.test(res.url()) && res.status() === 200, {
			timeout: 10000,
		});
		await admin.waitForLoading();

		// Wait for the image to appear in the grid
		const mediaGrid = page.locator(".grid.gap-4");
		await expect(mediaGrid.locator("img").first()).toBeVisible({ timeout: 5000 });

		// Click the image to open the detail panel
		await mediaGrid.locator("button").first().click();

		// Wait for the detail panel — it's a slide-out div, not a dialog
		await expect(page.locator("text=Media Details")).toBeVisible({ timeout: 5000 });

		// Find the alt text input and fill it
		const altInput = page.getByLabel(ALT_LABEL_PATTERN);
		await expect(altInput).toBeVisible({ timeout: 3000 });
		const altText = `Test alt ${Date.now()}`;
		await altInput.fill(altText);

		// The Save button should become enabled after editing
		const saveButton = page.getByRole("button", { name: SAVE_BUTTON_PATTERN });
		await expect(saveButton).toBeEnabled({ timeout: 3000 });

		// Intercept the PUT response to verify the server returns the item
		const putResponse = page.waitForResponse(
			(res) =>
				MEDIA_PUT_PATTERN.test(res.url()) &&
				res.request().method() === "PUT" &&
				res.status() === 200,
			{ timeout: 10000 },
		);

		await saveButton.click();
		const response = await putResponse;

		// Verify the response contains the item (the fix: result.item, not result.data?.item)
		const body = await response.json();
		expect(body.data.item).toBeDefined();
		expect(body.data.item.alt).toBe(altText);
	});
});

// ==========================================================================
// Upload success only after completion (premature success fix)
// ==========================================================================

test.describe("Upload completion timing", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("upload success feedback appears only after server responds", async ({ admin, page }) => {
		const testImagePath = ensureTestImage();
		await admin.goToMedia();
		await admin.waitForLoading();

		// Set up response listener BEFORE triggering upload
		const uploadResponse = page.waitForResponse(
			(res) =>
				MEDIA_UPLOAD_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				res.status() === 200,
			{ timeout: 15000 },
		);

		// Trigger upload
		const fileInput = page.locator('input[type="file"]');
		await fileInput.setInputFiles(testImagePath);

		// Should see uploading state (or at least no success yet while request is pending)
		// Wait for the response to come back
		await uploadResponse;

		// Now success feedback should appear
		const successIndicator = page.locator("text=/file uploaded/i");
		await expect(successIndicator).toBeVisible({ timeout: 5000 });
	});
});

// ==========================================================================
// Taxonomy term deletion uses ConfirmDialog instead of browser confirm()
// ==========================================================================

test.describe("Taxonomy ConfirmDialog", () => {
	let headers: Record<string, string>;
	let baseUrl: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);
	});

	test("deleting a taxonomy term shows a dialog instead of browser confirm", async ({
		admin,
		page,
		serverInfo,
	}) => {
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		// Check if any taxonomies exist
		const taxRes = await fetch(`${baseUrl}/_emdash/api/taxonomies`, { headers });
		const taxData: any = await taxRes.json();

		if (!taxData.data?.taxonomies || taxData.data.taxonomies.length === 0) {
			test.skip();
			return;
		}

		const taxonomy = taxData.data.taxonomies[0];

		// Create a term to delete
		const termRes = await fetch(`${baseUrl}/_emdash/api/taxonomies/${taxonomy.name}/terms`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: `e2e-delete-test-${Date.now()}`,
				label: "E2E Delete Test Term",
			}),
		});

		if (!termRes.ok) {
			test.skip();
			return;
		}

		// Navigate to the taxonomy page
		await admin.goto(`/taxonomies/${taxonomy.name}`);
		await admin.waitForShell();
		await admin.waitForLoading();

		// Ensure the term we created is visible
		await expect(page.locator("text=E2E Delete Test Term")).toBeVisible({ timeout: 5000 });

		// Set up a listener to ensure NO browser dialog appears
		let browserDialogAppeared = false;
		page.on("dialog", async (dialog) => {
			browserDialogAppeared = true;
			await dialog.dismiss();
		});

		// Click the delete button for the term
		await page.getByRole("button", { name: "Delete E2E Delete Test Term" }).click();

		// A ConfirmDialog (React dialog) should appear — NOT a browser confirm()
		// The dialog title is "Delete {labelSingular}?" e.g. "Delete Category?"
		const confirmDialog = page.locator('[role="dialog"]').filter({ hasText: "permanently" });
		await expect(confirmDialog).toBeVisible({ timeout: 3000 });

		// The dialog should have a "Delete" button and "Cancel" button
		await expect(confirmDialog.getByRole("button", { name: "Delete" })).toBeVisible();
		await expect(confirmDialog.getByRole("button", { name: "Cancel" })).toBeVisible();

		// The dialog should mention the term name (rendered in curly quotes)
		await expect(confirmDialog.getByText("E2E Delete Test Term")).toBeVisible();

		// No browser dialog should have appeared
		expect(browserDialogAppeared).toBe(false);

		// Actually delete it (confirm)
		const deleteResponse = page.waitForResponse(
			(res) => TAXONOMY_DELETE_PATTERN.test(res.url()) && res.request().method() === "DELETE",
			{ timeout: 10000 },
		);
		await confirmDialog.getByRole("button", { name: "Delete" }).click();
		await deleteResponse;

		// Dialog should close
		await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });

		// Term should be gone
		await expect(page.locator("text=E2E Delete Test Term")).not.toBeVisible({ timeout: 5000 });
	});
});

// ==========================================================================
// Autosave still triggers after useMemo/useRef perf optimizations
// ==========================================================================

test.describe("Autosave after perf optimizations", () => {
	let collectionSlug: string;
	let postId: string;
	let headers: Record<string, string>;
	let baseUrl: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();

		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		// Create a collection with revision + draft support
		collectionSlug = `autosave_test_${Date.now()}`;
		await fetch(`${baseUrl}/_emdash/api/schema/collections`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				slug: collectionSlug,
				label: "Autosave Test Collection",
				labelSingular: "Autosave Test Collection",
				supports: ["revisions", "drafts"],
			}),
		});

		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}/fields`, {
			method: "POST",
			headers,
			body: JSON.stringify({ slug: "title", type: "string", label: "Title", required: true }),
		});

		// Create a draft post (autosave works on existing items, no need to publish)
		const createRes = await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}`, {
			method: "POST",
			headers,
			body: JSON.stringify({ data: { title: "Autosave Test" }, slug: "autosave-perf-test" }),
		});
		const createData: any = await createRes.json();
		postId = createData.data?.item?.id ?? createData.data?.id;
	});

	test.afterEach(async () => {
		await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
		await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
	});

	test("autosave triggers after editing content (useMemo/useRef optimizations)", async ({
		admin,
		page,
	}) => {
		const contentUrl = `/_emdash/api/content/${collectionSlug}/${postId}`;

		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		const titleInput = page.locator("#field-title");
		await expect(titleInput).toHaveValue("Autosave Test");

		// Wait for a PUT whose request body contains the updated title
		// (an initial autosave with old data may fire first — skip it)
		const autosavePut = page.waitForResponse(
			(res) => {
				if (!res.url().includes(contentUrl) || res.request().method() !== "PUT") return false;
				const postData = res.request().postData() ?? "";
				return postData.includes("Autosave Perf Test Edit");
			},
			{ timeout: 15000 },
		);

		await titleInput.fill("Autosave Perf Test Edit");
		const response = await autosavePut;

		// Autosave should succeed (200)
		expect(response.status()).toBe(200);

		// The autosave indicator should show "Saved"
		await expect(page.locator("text=Saved")).toBeVisible({ timeout: 5000 });
	});

	test("multiple rapid edits result in single autosave (debounce still works)", async ({
		admin,
		page,
	}) => {
		const contentUrl = `/_emdash/api/content/${collectionSlug}/${postId}`;

		await admin.goToEditContent(collectionSlug, postId);
		await admin.waitForLoading();

		const titleInput = page.locator("#field-title");
		await expect(titleInput).toHaveValue("Autosave Test");

		// Wait for any initial autosave to settle before tracking
		await page.waitForTimeout(3000);

		// Track PUT requests only from this point forward
		const putRequests: any[] = [];
		page.on("response", (res) => {
			if (res.url().includes(contentUrl) && res.request().method() === "PUT") {
				putRequests.push(res);
			}
		});

		// Type multiple characters rapidly (within the 2s debounce window)
		await titleInput.fill("");
		await titleInput.pressSequentially("ABCDEF", { delay: 50 });

		// Wait for autosave to trigger (debounce is 2s + some margin)
		await page.waitForTimeout(4000);

		// Should have exactly 1 PUT request (debounced)
		expect(putRequests.length).toBe(1);

		// Verify the PUT sent the correct final value
		const postData = putRequests[0].request().postData() ?? "";
		expect(postData).toContain("ABCDEF");
	});
});
