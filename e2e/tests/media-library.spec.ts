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
const BROWSE_FILES_LABEL = "Browse files to upload";

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
	await page.getByRole("button", { name: UPLOAD_BUTTON_REGEX }).first().click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();

	const uploadResponse = page.waitForResponse(
		(res) =>
			MEDIA_API_RESPONSE_PATTERN.test(res.url()) &&
			res.request().method() === "POST" &&
			res.status() === 200,
		{ timeout: 10000 },
	);
	await dialog.getByLabel(BROWSE_FILES_LABEL).setInputFiles(testImagePath);
	await uploadResponse;
	await expect(dialog.getByText("Complete", { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
}

async function createFolder(page: Page, name: string) {
	await page.getByRole("button", { name: "Add new folder" }).click();
	const dialog = page.getByRole("dialog", { name: "Add new folder" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Create" }).click();
	await expect(dialog).not.toBeVisible();
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
			const mediaGrid = page.locator("[data-media-grid]");
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

	test("keeps media intact while organizing it in folders", async ({ admin, page }) => {
		const folderName = `Product photos ${Date.now()}`;
		const renamedFolder = `${folderName} archive`;
		await admin.goToMedia();
		await admin.waitForLoading();
		await uploadTestImage(page);
		await createFolder(page, folderName);
		await createFolder(page, `Press ${Date.now()}`);

		const mediaGrid = page.locator("[data-media-grid]");
		const originalImage = mediaGrid.locator("img").first();
		await expect(originalImage).toBeVisible();
		const originalSrc = await originalImage.getAttribute("src");
		await mediaGrid.locator("button").first().click();

		const details = page.getByRole("dialog", { name: "Media Details" });
		await details.getByRole("combobox", { name: "Location" }).click();
		await page.getByRole("option", { name: folderName }).click();
		await details.getByRole("button", { name: "Save" }).click();
		await expect(details).not.toBeVisible();
		await expect(page.getByRole("heading", { name: "Media Library" })).toBeFocused();

		await page.getByRole("link", { name: `Open folder ${folderName}` }).click();
		await expect(page).toHaveURL(/\/media\?folder=/);
		await expect(mediaGrid.locator("img").first()).toHaveAttribute("src", originalSrc!);
		await page.setViewportSize({ width: 320, height: 800 });
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page.reload();
		await expect(mediaGrid.locator("img").first()).toHaveAttribute("src", originalSrc!);
		await page.goBack();
		await expect(page).toHaveURL(/\/media\/?$/);

		const search = page.getByRole("searchbox", { name: "Search media" });
		await search.fill(folderName);
		await page.getByRole("link", { name: `Open folder ${folderName}` }).click();
		await expect(search).toHaveValue("");
		await search.fill(folderName);
		await page.getByRole("button", { name: `Edit folder ${folderName}` }).click();

		const editDialog = page.getByRole("dialog", { name: "Edit folder" });
		await editDialog.getByLabel("Name").fill(renamedFolder);
		await editDialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText(renamedFolder).first()).toBeVisible();

		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/_emdash" }]);
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "en", domain: "localhost", path: "/_emdash" }]);
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

		await search.fill(renamedFolder);
		await page.getByRole("button", { name: `Edit folder ${renamedFolder}` }).click();
		await editDialog.getByRole("button", { name: "Delete folder" }).click();
		const confirm = page.getByRole("dialog", { name: `Delete “${renamedFolder}”?` });
		await confirm.getByRole("button", { name: "Delete folder" }).click();

		await expect(page).toHaveURL(/\/media\/?$/);
		await page.getByRole("button", { name: "Clear search" }).click();
		await expect(mediaGrid.locator("img").first()).toHaveAttribute("src", originalSrc!);
	});
});
