/**
 * API Tokens E2E Tests
 *
 * Tests for the API Tokens settings page:
 * - Page renders with existing tokens
 * - Creating a new token (name, scopes, display)
 * - Token value is only shown once
 * - Revoking a token with confirmation
 */

import { test, expect } from "../fixtures";

// Regex patterns
const MASKED_TOKEN_PATTERN = /^[•]+$/;
const TOKEN_PREFIX_PATTERN = /^ec_/;

test.describe("API Tokens", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("tokens page renders with existing tokens", async ({ admin, page }) => {
		await admin.goto("/settings/api-tokens");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Should show the page title
		await admin.expectPageTitle("API Tokens");

		const tokenList = page.getByRole("region", { name: "API Tokens", exact: true });
		await expect(tokenList).toBeVisible({ timeout: 10000 });

		// The setup token should show its name
		await expect(tokenList.getByText("dev-bypass-token", { exact: true })).toBeVisible();
	});

	test("create a new token with scopes", async ({ admin, page }) => {
		await admin.goto("/settings/api-tokens");
		await admin.waitForShell();
		await admin.waitForLoading();

		const tokenName = `e2e-test-token-${Date.now()}`;

		// Click the "Create Token" button to show the form
		await page.getByRole("button", { name: "Create Token" }).click();

		// The create form should appear with the heading
		await expect(page.locator("text=Create New Token")).toBeVisible({ timeout: 5000 });

		// Fill in the token name
		const nameInput = page.getByLabel("Token Name");
		await nameInput.fill(tokenName);

		// Select at least one scope -- click the label to toggle the checkbox
		await page.locator("label", { hasText: "Content Read" }).click();

		// Select "Media Read" too
		await page.locator("label", { hasText: "Media Read" }).click();

		// Submit the form -- use last() to get the submit button, not the header button
		await page.getByRole("button", { name: "Create Token" }).last().click();

		// Wait for the token created confirmation
		await page.waitForTimeout(2000);

		// The new token banner should appear with the token value
		await expect(page.locator("text=Token created")).toBeVisible({ timeout: 5000 });
		await expect(page.locator(`text=${tokenName}`).first()).toBeVisible();

		// The "won't be shown again" warning should be visible
		await expect(page.locator("text=won't be shown again")).toBeVisible();

		// The token value should be masked by default (dots)
		const tokenDisplay = page.locator("code").filter({ hasText: MASKED_TOKEN_PATTERN });
		await expect(tokenDisplay).toBeVisible();

		// Click the eye icon to reveal the token
		await page.getByLabel("Show token").click();

		// After revealing, the code block should show a real token (starts with "ec_")
		const revealedToken = page.locator("code").filter({ hasText: TOKEN_PREFIX_PATTERN }).first();
		await expect(revealedToken).toBeVisible({ timeout: 3000 });

		// The token should also appear in the list below
		const tokenList = page.getByRole("region", { name: "API Tokens", exact: true });
		await expect(tokenList.getByText(tokenName, { exact: true })).toBeVisible({ timeout: 5000 });
	});

	test("token value is not visible after navigating away and back", async ({ admin, page }) => {
		await admin.goto("/settings/api-tokens");
		await admin.waitForShell();
		await admin.waitForLoading();

		const tokenName = `ephemeral-token-${Date.now()}`;

		// Create a token
		await page.getByRole("button", { name: "Create Token" }).click();
		await expect(page.locator("text=Create New Token")).toBeVisible({ timeout: 5000 });

		await page.getByLabel("Token Name").fill(tokenName);

		// Select "Content Read" scope
		await page.locator("label", { hasText: "Content Read" }).click();

		// Submit -- use last() to get the form submit button, not the header button
		await page.getByRole("button", { name: "Create Token" }).last().click();
		await page.waitForTimeout(2000);

		// Verify the banner is showing
		await expect(page.locator("text=Token created")).toBeVisible({ timeout: 5000 });

		// Navigate away to settings
		await admin.goto("/settings");
		await admin.waitForShell();

		// Navigate back to API tokens
		await admin.goto("/settings/api-tokens");
		await admin.waitForShell();
		await admin.waitForLoading();

		// The "Token created" banner should NOT be visible
		await expect(page.locator("text=Token created")).not.toBeVisible({ timeout: 3000 });

		// But the token should still appear in the list (by name)
		const tokenList = page.getByRole("region", { name: "API Tokens", exact: true });
		await expect(tokenList.getByText(tokenName, { exact: true })).toBeVisible({
			timeout: 5000,
		});
	});

	test("revoke a token with confirmation", async ({ admin, page }) => {
		await admin.goto("/settings/api-tokens");
		await admin.waitForShell();
		await admin.waitForLoading();

		const tokenName = `revoke-me-${Date.now()}`;

		// Create a token to revoke
		await page.getByRole("button", { name: "Create Token" }).click();
		await expect(page.locator("text=Create New Token")).toBeVisible({ timeout: 5000 });

		await page.getByLabel("Token Name").fill(tokenName);

		await page.locator("label", { hasText: "Content Read" }).click();

		await page.getByRole("button", { name: "Create Token" }).last().click();
		await page.waitForTimeout(2000);

		// Dismiss the new token banner
		await page.getByRole("button", { name: "Dismiss", exact: true }).click();
		await expect(page.locator("text=Token created")).not.toBeVisible({ timeout: 3000 });

		const tokenList = page.getByRole("region", { name: "API Tokens", exact: true });
		await expect(tokenList.getByText(tokenName, { exact: true })).toBeVisible({ timeout: 5000 });
		await page.getByRole("button", { name: `Revoke token ${tokenName}`, exact: true }).click();

		const dialog = page.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Revoke?", exact: true })).toBeVisible({
			timeout: 3000,
		});

		// Should have Confirm and Cancel buttons
		await expect(dialog.getByRole("button", { name: "Confirm" })).toBeVisible();
		await expect(dialog.getByRole("button", { name: "Cancel" })).toBeVisible();

		// Click Confirm to revoke
		await dialog.getByRole("button", { name: "Confirm" }).click();
		await page.waitForTimeout(2000);

		// The token should disappear from the list
		await expect(tokenList.getByText(tokenName, { exact: true })).not.toBeVisible({
			timeout: 5000,
		});

		// The dev-bypass-token should still be present (we didn't revoke it)
		await expect(page.locator("text=dev-bypass-token")).toBeVisible();
	});

	test("cancel revoke keeps token in list", async ({ admin, page }) => {
		await admin.goto("/settings/api-tokens");
		await admin.waitForShell();
		await admin.waitForLoading();

		const tokenName = `keep-me-${Date.now()}`;

		// Create a token
		await page.getByRole("button", { name: "Create Token" }).click();
		await expect(page.locator("text=Create New Token")).toBeVisible({ timeout: 5000 });

		await page.getByLabel("Token Name").fill(tokenName);

		await page.locator("label", { hasText: "Content Read" }).click();

		await page.getByRole("button", { name: "Create Token" }).last().click();
		await page.waitForTimeout(2000);

		await page.getByRole("button", { name: "Dismiss", exact: true }).click();

		const tokenList = page.getByRole("region", { name: "API Tokens", exact: true });
		await expect(tokenList.getByText(tokenName, { exact: true })).toBeVisible({ timeout: 5000 });
		await page.getByRole("button", { name: `Revoke token ${tokenName}`, exact: true }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByRole("heading", { name: "Revoke?", exact: true })).toBeVisible({
			timeout: 3000,
		});

		// Click Cancel instead
		await dialog.getByRole("button", { name: "Cancel" }).click();

		// Confirmation UI should disappear
		await expect(dialog).not.toBeVisible({ timeout: 3000 });

		// Token should still be in the list
		await expect(tokenList.getByText(tokenName, { exact: true })).toBeVisible();

		// Trash icon should be back
		await expect(
			page.getByRole("button", { name: `Revoke token ${tokenName}`, exact: true }),
		).toBeVisible();
	});
});
