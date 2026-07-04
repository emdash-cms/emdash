/**
 * Media Library E2E Tests
 *
 * Tests uploading, viewing, and deleting media files.
 * Runs against an isolated fixture — starts with no media.
 */

import { writeFileSync, mkdirSync, existsSync } from "node:fs";
import { join } from "node:path";

import type { Page } from "@playwright/test";

import { test, expect } from "../fixtures";

// Create a test image for uploads
const TEST_ASSETS_DIR = join(process.cwd(), "e2e/fixtures/assets");

// Regex patterns
const MEDIA_API_RESPONSE_PATTERN = /\/api\/media/;
const UPLOAD_BUTTON_REGEX = /Upload/;

function ensureTestAssets(): string {
	if (!existsSync(TEST_ASSETS_DIR)) {
		mkdirSync(TEST_ASSETS_DIR, { recursive: true });
	}

	// Create a simple test PNG (1x1 red pixel)
	const testImagePath = join(TEST_ASSETS_DIR, "test-image.png");
	if (!existsSync(testImagePath)) {
		// Minimal valid PNG file (1x1 red pixel)
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

async function uploadTestImage(page: Page) {
	const testImagePath = ensureTestAssets();
	const fileInput = page.locator('input[type="file"]');
	await fileInput.setInputFiles(testImagePath);
	await page.waitForResponse(
		(res) => MEDIA_API_RESPONSE_PATTERN.test(res.url()) && res.status() === 200,
		{ timeout: 10000 },
	);
}

test.describe("Media Library", () => {
	test.beforeAll(() => {
		ensureTestAssets();
	});

	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Media List", () => {
		test("displays media library page", async ({ admin }) => {
			await admin.goToMedia();
			await admin.waitForLoading();

			// Should show the media library heading
			await admin.expectPageTitle("Media Library");

			// Should have upload button
			await expect(
				admin.page.getByRole("button", { name: UPLOAD_BUTTON_REGEX }).first(),
			).toBeVisible();
		});

		test("shows grid view by default", async ({ admin, page }) => {
			await admin.goToMedia();
			await admin.waitForLoading();
			await uploadTestImage(page);

			// Grid view tab should be active
			const gridTab = admin.page.getByRole("tab", { name: "Grid view" });
			await expect(gridTab).toBeVisible();
			await expect(gridTab).toHaveAttribute("aria-selected", "true");
		});

		test("shows view toggle tabs", async ({ admin, page }) => {
			await admin.goToMedia();
			await admin.waitForLoading();
			await uploadTestImage(page);

			await expect(admin.page.getByRole("tab", { name: "Grid view" })).toBeVisible();
			await expect(admin.page.getByRole("tab", { name: "List view" })).toBeVisible();
		});
	});

	test.describe("Upload Media", () => {
		test("uploads a new image file", async ({ admin, page }) => {
			await admin.goToMedia();
			await admin.waitForLoading();

			// Upload file
			await uploadTestImage(page);

			// Wait for the uploaded image to appear in the media grid
			const mediaGrid = page.locator(".grid.gap-4");
			await expect(mediaGrid.locator("img").first()).toBeVisible({ timeout: 5000 });

			// Should have at least one image in the grid now
			const images = mediaGrid.locator("img");
			const count = await images.count();
			expect(count).toBeGreaterThan(0);
		});
	});

	test.describe("List View", () => {
		test("shows file details in list view", async ({ admin, page }) => {
			// Upload a file first so there's something to show
			await admin.goToMedia();
			await admin.waitForLoading();

			await uploadTestImage(page);
			await page.reload();
			await admin.waitForLoading();

			// Switch to list view
			await page.getByRole("tab", { name: "List view" }).click();

			// Should show table with columns
			await expect(page.locator("th:has-text('Filename')")).toBeVisible();
			await expect(page.locator("th:has-text('Type')")).toBeVisible();
			await expect(page.locator("th:has-text('Size')")).toBeVisible();
		});
	});
});
