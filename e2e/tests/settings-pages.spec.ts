/**
 * Settings Pages E2E Tests
 *
 * Tests the Social, SEO, and Email settings sub-pages.
 * These are form-based pages that load settings from the API and save them.
 *
 * The primary class of bug we're catching: API response shape mismatches
 * that crash the page on load, or save mutations that silently fail.
 */

import { test, expect } from "../fixtures";

// API patterns
const SETTINGS_API_PATTERN = /\/api\/settings$/;

test.describe("Social Settings", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("page renders with heading and form", async ({ admin, page }) => {
		await admin.goto("/settings/social");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Page heading
		await expect(page.locator("h1")).toContainText("Social Links");

		// Should show the social profiles section
		await expect(page.locator("text=Social Profiles")).toBeVisible({ timeout: 10000 });
	});

	test("displays all social input fields", async ({ admin, page }) => {
		await admin.goto("/settings/social");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Each social field should have a visible input with its label
		for (const label of ["Twitter", "GitHub", "Facebook", "Instagram", "LinkedIn", "YouTube"]) {
			await expect(page.locator(`label:has-text("${label}")`)).toBeVisible({ timeout: 5000 });
		}

		// Save button should exist. Two are rendered (sticky header + bottom-of-form,
		// both submit the same form via `form="social-settings-form"`); use .first()
		// to avoid Playwright strict-mode locator violations.
		await expect(page.locator("button", { hasText: "Save Social Links" }).first()).toBeVisible();
	});

	test("saves a social link and persists across reload", async ({ admin, page }) => {
		await admin.goto("/settings/social");
		await admin.waitForShell();
		await admin.waitForLoading();

		const testHandle = `@e2e-test-${Date.now()}`;

		// Fill the first social input field (Twitter)
		const firstInput = page.locator("form input").first();
		await firstInput.fill(testHandle);

		// Wait for the save response
		const saveResponse = page.waitForResponse(
			(res) =>
				SETTINGS_API_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				res.status() === 200,
			{ timeout: 15000 },
		);

		// Click save. Two buttons match (sticky header + bottom-of-form); either
		// submits the same form, so use .first() for strict-mode compatibility.
		await page.locator("button", { hasText: "Save Social Links" }).first().click();
		await saveResponse;

		// Success banner should appear
		await expect(page.locator("text=Social links saved")).toBeVisible({ timeout: 5000 });

		// Reload the page
		await admin.goto("/settings/social");
		await admin.waitForShell();
		await admin.waitForLoading();

		// The value should persist
		const firstInputAfterReload = page.locator("form input").first();
		await expect(firstInputAfterReload).toHaveValue(testHandle, { timeout: 10000 });
	});
});

test.describe("SEO Settings", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("page renders with heading and form", async ({ admin, page }) => {
		await admin.goto("/settings/seo");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Page heading
		await expect(page.locator("h1")).toContainText("SEO Settings");

		// Should show the SEO section
		await expect(page.locator("text=Search Engine Optimization")).toBeVisible({ timeout: 10000 });
	});

	test("displays expected SEO fields", async ({ admin, page }) => {
		await admin.goto("/settings/seo");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Expected fields from SeoSettings.tsx
		for (const label of [
			"Title Separator",
			"Google Verification",
			"Bing Verification",
			"robots.txt",
		]) {
			await expect(page.locator(`label:has-text("${label}")`)).toBeVisible({ timeout: 5000 });
		}

		// Save button. Two are rendered (sticky header + bottom-of-form, both submit
		// the same form via `form="seo-settings-form"`); use .first() to avoid
		// Playwright strict-mode locator violations.
		await expect(page.locator("button", { hasText: "Save SEO Settings" }).first()).toBeVisible();
	});

	test("saves SEO settings and persists across reload", async ({ admin, page }) => {
		await admin.goto("/settings/seo");
		await admin.waitForShell();
		await admin.waitForLoading();

		const testVerification = `e2e-verify-${Date.now()}`;

		// Fill the Google Verification field
		const googleInput = page
			.locator("label:has-text('Google Verification')")
			.locator("..")
			.locator("input");
		await googleInput.fill(testVerification);

		// Wait for save response
		const saveResponse = page.waitForResponse(
			(res) =>
				SETTINGS_API_PATTERN.test(res.url()) &&
				res.request().method() === "POST" &&
				res.status() === 200,
			{ timeout: 15000 },
		);

		// Click save. Two buttons match (sticky header + bottom-of-form); either
		// submits the same form, so use .first() for strict-mode compatibility.
		await page.locator("button", { hasText: "Save SEO Settings" }).first().click();
		await saveResponse;

		// Success banner
		await expect(page.locator("text=SEO settings saved")).toBeVisible({ timeout: 5000 });

		// Reload
		await admin.goto("/settings/seo");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Value should persist
		const googleInputAfterReload = page
			.locator("label:has-text('Google Verification')")
			.locator("..")
			.locator("input");
		await expect(googleInputAfterReload).toHaveValue(testVerification, { timeout: 10000 });
	});
});

test.describe("Language Switcher", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("settings page shows language select", async ({ admin, page }) => {
		await admin.goto("/settings");
		await admin.waitForShell();

		const languageSelect = page.locator('[aria-label="Language"]');
		await expect(languageSelect).toBeVisible();
	});

	test("switching language updates the UI", async ({ admin, page }) => {
		await admin.goto("/settings");
		await admin.waitForShell();

		// Switch to German
		await page.locator('[aria-label="Language"]').click();
		await page.locator("[role='option']", { hasText: "Deutsch" }).click();

		await expect(page.locator("h1")).toContainText("Einstellungen", { timeout: 5000 });

		// Switch back — the select now shows "Deutsch" as its value
		await page.locator("[role='combobox']", { hasText: "Deutsch" }).click();
		await page.locator("[role='option']", { hasText: "English" }).click();

		await expect(page.locator("h1")).toContainText("Settings", { timeout: 5000 });
	});
});

test.describe("Email Settings", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("page renders with heading and pipeline status", async ({ admin, page }) => {
		await admin.goto("/settings/email");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Page heading
		await expect(page.locator("h1")).toContainText("Email Settings");

		// Should show the Email Pipeline section
		await expect(page.locator("text=Email Pipeline")).toBeVisible({ timeout: 10000 });
	});

	test("shows pipeline section without crashing", async ({ admin, page }) => {
		await admin.goto("/settings/email");
		await admin.waitForShell();
		await admin.waitForLoading();

		// The Email Pipeline section heading should be visible
		await expect(page.getByRole("heading", { name: "Email Pipeline" })).toBeVisible({
			timeout: 10000,
		});
	});
});
