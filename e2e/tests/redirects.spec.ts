/**
 * Redirects E2E Tests
 *
 * Tests creating, editing, and deleting URL redirects,
 * plus the 404 tracking tab.
 */

import { test, expect } from "../fixtures";

test.describe("Redirects", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Empty state", () => {
		test("displays redirects page with empty state", async ({ admin, page }) => {
			await admin.goto("/redirects");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Should show the page heading
			await admin.expectPageTitle("Redirects");

			// Should have the "New Redirect" button
			await expect(page.getByRole("button", { name: "New Redirect" })).toBeVisible();

			// Should show empty state text
			await expect(page.locator("text=No redirects yet")).toBeVisible();
		});
	});

	test.describe("CRUD", () => {
		test("creates a redirect", async ({ admin, page }) => {
			await admin.goto("/redirects");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Open create dialog
			await page.getByRole("button", { name: "New Redirect" }).click();
			await expect(page.locator('[role="dialog"]')).toBeVisible();

			// Fill form
			const dialog = page.locator('[role="dialog"]');
			await dialog.locator('input[placeholder*="old-page"]').fill("/old-page");
			await dialog.locator('input[placeholder*="new-page"]').fill("/new-page");

			// Status code defaults to 301 -- leave it

			// Submit
			await dialog.getByRole("button", { name: "Create" }).click();

			// Dialog should close
			await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 10000 });

			// Redirect should appear in the list
			await expect(page.locator("text=/old-page").first()).toBeVisible();
			await expect(page.locator("text=/new-page").first()).toBeVisible();
		});

		test("edits a redirect", async ({ admin, page }) => {
			await admin.goto("/redirects");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Create a redirect first
			await page.getByRole("button", { name: "New Redirect" }).click();
			const createDialog = page.locator('[role="dialog"]');
			await createDialog.locator('input[placeholder*="old-page"]').fill("/edit-source");
			await createDialog.locator('input[placeholder*="new-page"]').fill("/edit-dest-original");
			await createDialog.getByRole("button", { name: "Create" }).click();
			await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 10000 });

			// Wait for the redirect to appear
			await expect(page.locator("text=/edit-source").first()).toBeVisible();

			// Click the edit button on that row (use .first() to avoid ancestor div ambiguity).
			// Kumo 2.x renders <Button title> as a Tooltip popup rather than a DOM
			// title attribute; aria-label is on the button itself.
			await page.locator('button[aria-label^="Edit redirect"]').first().click();

			// Edit dialog should open
			await expect(page.locator('[role="dialog"]')).toBeVisible();

			// Change the destination
			const editDialog = page.locator('[role="dialog"]');
			const destInput = editDialog.locator('input[placeholder*="new-page"]');
			await destInput.clear();
			await destInput.fill("/edit-dest-updated");

			// Save
			await editDialog.getByRole("button", { name: "Save" }).click();
			await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 10000 });

			// Verify the updated destination is shown
			await expect(page.locator("text=/edit-dest-updated").first()).toBeVisible();
			await expect(page.locator("text=/edit-dest-original")).not.toBeVisible();
		});

		test("deletes a redirect", async ({ admin, page }) => {
			await admin.goto("/redirects");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Create a redirect to delete
			await page.getByRole("button", { name: "New Redirect" }).click();
			const dialog = page.locator('[role="dialog"]');
			await dialog.locator('input[placeholder*="old-page"]').fill("/to-delete");
			await dialog.locator('input[placeholder*="new-page"]').fill("/deleted-dest");
			await dialog.getByRole("button", { name: "Create" }).click();
			await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 10000 });

			// Wait for it to appear
			await expect(page.locator("text=/to-delete").first()).toBeVisible();

			// Click the delete button on that row (use .first() to avoid ancestor div ambiguity).
			// See note above re: Kumo 2.x Button title -> Tooltip.
			await page.locator('button[aria-label^="Delete redirect"]').first().click();

			// Confirm deletion in the ConfirmDialog
			await expect(page.locator('[role="dialog"]')).toBeVisible();
			await page.getByRole("button", { name: "Delete" }).click();

			// Dialog should close
			await expect(page.locator('[role="dialog"]')).not.toBeVisible({ timeout: 10000 });

			// Redirect should be gone
			await expect(page.locator("text=/to-delete")).not.toBeVisible();
		});
	});

	test.describe("404 Tracking", () => {
		test("renders the 404 errors tab", async ({ admin, page }) => {
			await admin.goto("/redirects");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Click the "404 Errors" tab
			await page.locator("button", { hasText: "404 Errors" }).click();

			// Should show the empty state for 404s
			await expect(page.locator("text=No 404 errors recorded yet")).toBeVisible({
				timeout: 10000,
			});
		});
	});
});
