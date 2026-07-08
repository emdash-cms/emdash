/**
 * WordPress Import Wizard E2E Tests
 *
 * Tests the WordPress import page at /import/wordpress.
 * We can't test a full import without a real WP export file, but we
 * verify the wizard loads, shows the expected UI elements, and handles
 * basic validation.
 *
 * The wizard has two primary entry paths:
 * 1. Enter a WordPress site URL (probe + connect)
 * 2. Upload a WXR export file (.xml)
 *
 * Both paths are tested for initial rendering here.
 */

import { test, expect } from "../fixtures";

test.describe("WordPress Import", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Page rendering", () => {
		test("displays the import page with heading and step indicator", async ({ admin, page }) => {
			await admin.goto("/import/wordpress");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Page heading
			await admin.expectPageTitle("Import from WordPress");

			// Subtitle
			await expect(
				page.getByText("Import posts, pages, and custom post types from WordPress"),
			).toBeVisible({ timeout: 10000 });
		});

		test("does not crash or show error state", async ({ admin, page }) => {
			await admin.goto("/import/wordpress");
			await admin.waitForShell();
			await admin.waitForLoading();

			// The page must actually render its heading (a blank page must fail)...
			await admin.expectPageTitle("Import from WordPress");
			// ...and must not show an error/crash state.
			await expect(page.locator("text=Failed to load")).not.toBeVisible();
			await expect(page.locator("text=Something went wrong")).not.toBeVisible();
		});
	});

	test.describe("URL input path", () => {
		test("shows URL input field and Check Site button", async ({ admin, page }) => {
			await admin.goto("/import/wordpress");
			await admin.waitForShell();
			await admin.waitForLoading();

			// URL input section
			await expect(page.locator("text=Enter your WordPress site URL")).toBeVisible({
				timeout: 10000,
			});

			// Input field
			const urlInput = page.locator('input[placeholder*="yoursite.com"]');
			await expect(urlInput).toBeVisible();

			// Check Site button (disabled by default since input is empty)
			const checkButton = page.getByRole("button", { name: "Check Site" });
			await expect(checkButton).toBeVisible();
			await expect(checkButton).toBeDisabled();
		});

		test("Check Site button enables when URL is entered", async ({ admin, page }) => {
			await admin.goto("/import/wordpress");
			await admin.waitForShell();
			await admin.waitForLoading();

			const urlInput = page.locator('input[placeholder*="yoursite.com"]');
			await urlInput.fill("https://example.com");

			const checkButton = page.getByRole("button", { name: "Check Site" });
			await expect(checkButton).toBeEnabled();
		});
	});

	test.describe("File upload path", () => {
		test("shows file upload drop zone with Browse button", async ({ admin, page }) => {
			await admin.goto("/import/wordpress");
			await admin.waitForShell();
			await admin.waitForLoading();

			// "or upload directly" divider
			await expect(page.locator("text=or upload directly")).toBeVisible({ timeout: 10000 });

			// Upload section text
			await expect(page.locator("text=Upload WordPress export file")).toBeVisible();
			await expect(page.locator("text=Drag and drop or click to browse")).toBeVisible();

			// Browse Files button (it's a styled label wrapping a hidden file input)
			await expect(page.locator("text=Browse Files")).toBeVisible();

			// Hidden file input should accept .xml
			const fileInput = page.locator('input[type="file"][accept=".xml"]');
			await expect(fileInput).toBeAttached();
		});
	});
});
