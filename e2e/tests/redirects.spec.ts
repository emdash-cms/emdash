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

	test.describe("Group filtering", () => {
		test("shows groups and filters by an exact group name", async ({ admin, page, serverInfo }) => {
			const { baseUrl, token } = serverInfo;
			const headers = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${token}`,
				"X-EmDash-Request": "1",
				Origin: baseUrl,
			};
			const redirects = [
				{
					source: "/issue-2287-legacy",
					destination: "/issue-2287-legacy-destination",
					groupName: "legacy-import-2024",
				},
				{
					source: "/issue-2287-legacy-extra",
					destination: "/issue-2287-legacy-extra-destination",
					groupName: "legacy-import-2024-extra",
				},
				{
					source: "/issue-2287-other",
					destination: "/issue-2287-other-destination",
					groupName: "other-group",
				},
				{
					source: "/issue-2287-ungrouped",
					destination: "/issue-2287-ungrouped-destination",
					groupName: null,
				},
			];
			const ids: string[] = [];

			try {
				for (const redirect of redirects) {
					const response = await page.request.post(`${baseUrl}/_emdash/api/redirects`, {
						headers,
						data: redirect,
					});
					expect(response.ok()).toBe(true);
					const body = await response.json();
					ids.push(body.data.id);
				}

				await admin.goto("/redirects");
				await admin.waitForShell();
				await admin.waitForLoading();

				for (const redirect of redirects) {
					await expect(page.getByText(redirect.source, { exact: true })).toBeVisible();
				}
				await expect(page.getByText("legacy-import-2024", { exact: true })).toBeVisible();
				await expect(page.getByText("legacy-import-2024-extra", { exact: true })).toBeVisible();
				await expect(page.getByText("other-group", { exact: true })).toBeVisible();
				await expect(page.getByText("No group", { exact: true }).first()).toBeAttached();

				const groupFilter = page.getByRole("textbox", { name: "Filter by group" });
				await groupFilter.fill("  legacy-import-2024  ");

				await expect(page.getByText("/issue-2287-legacy", { exact: true })).toBeVisible();
				await expect(page.getByText("/issue-2287-legacy-extra", { exact: true })).not.toBeVisible();
				await expect(page.getByText("/issue-2287-other", { exact: true })).not.toBeVisible();
				await expect(page.getByText("/issue-2287-ungrouped", { exact: true })).not.toBeVisible();

				const search = page.getByRole("searchbox", { name: "Search source or destination..." });
				await search.fill("issue-2287-other");
				await expect(page.getByText("No redirects match these filters")).toBeVisible();
				await search.fill("");
				await expect(page.getByText("/issue-2287-legacy", { exact: true })).toBeVisible();

				await groupFilter.fill("group-that-does-not-exist");
				await expect(page.getByText("No redirects match these filters")).toBeVisible();

				await groupFilter.fill("  ");
				await expect(page.getByText("/issue-2287-ungrouped", { exact: true })).toBeVisible();
				await groupFilter.fill("");
				await expect(page.getByText("/issue-2287-legacy", { exact: true })).toBeVisible();
				await expect(page.getByText("/issue-2287-ungrouped", { exact: true })).toBeVisible();
			} finally {
				for (const id of ids) {
					await page.request.delete(`${baseUrl}/_emdash/api/redirects/${id}`, { headers });
				}
			}
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
