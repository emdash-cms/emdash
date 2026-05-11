/**
 * Form Data Loss Prevention E2E Tests
 *
 * Verifies fixes from PR #133 — background refetches, false save states,
 * and stale taxonomy selections no longer cause silent data loss.
 *
 * Seed data:
 *   - posts: "First Post" (published), with categories taxonomy
 *   - categories taxonomy: "News", "Tutorials", "Opinion"
 *   - sections: "Hero Section" (slug: hero)
 */

import { test, expect } from "../fixtures";

test.describe("Form Data Loss Prevention", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("settings edits survive window blur/focus", async ({ admin, page }) => {
		await admin.goto("/settings/general");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Edit the tagline field
		const taglineInput = page.getByLabel("Tagline");
		await taglineInput.fill("My edited tagline");

		// Simulate window blur + focus (triggers React Query refetches for stale queries)
		await page.evaluate(() => {
			window.dispatchEvent(new Event("blur"));
			window.dispatchEvent(new Event("focus"));
		});

		// Wait for any potential refetch to complete
		await page.waitForTimeout(1000);

		// The edit should persist (staleTime: Infinity prevents refetch from overwriting)
		await expect(taglineInput).toHaveValue("My edited tagline");
	});

	test("section editor edits survive window blur/focus", async ({ admin, page }) => {
		await admin.goto("/sections/hero");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Edit the title field
		const titleInput = page.getByLabel("Title");
		const originalTitle = await titleInput.inputValue();
		const editedTitle = `Edited ${Date.now()}`;
		await titleInput.fill(editedTitle);

		// Simulate window blur + focus (triggers React Query refetches without staleTime)
		await page.evaluate(() => {
			window.dispatchEvent(new Event("blur"));
			window.dispatchEvent(new Event("focus"));
		});

		// Small wait for any potential refetch to complete
		await page.waitForTimeout(1000);

		// Edits should still be there (staleTime: Infinity prevents overwrite)
		await expect(titleInput).toHaveValue(editedTitle);

		// Save button should show "Save" (dirty), not "Saved" (clean).
		// Editor pages render two SaveButtons (header + bottom-of-form); both
		// reflect the same state so we just check the first.
		await expect(page.getByRole("button", { name: "Save" }).first()).toBeEnabled();

		// Restore original value to avoid side effects on other tests
		await titleInput.fill(originalTitle);
	});

	test("section editor save failure keeps form dirty", async ({ admin, page }) => {
		await admin.goto("/sections/hero");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Edit the title field so the form is dirty
		const titleInput = page.getByLabel("Title");
		const originalTitle = await titleInput.inputValue();
		await titleInput.fill(`Error test ${Date.now()}`);

		// Intercept the section update API call and force a failure
		await page.route("**/api/sections/hero", (route) => {
			if (route.request().method() === "PUT" || route.request().method() === "PATCH") {
				return route.fulfill({
					status: 500,
					contentType: "application/json",
					body: JSON.stringify({ error: { code: "SERVER_ERROR", message: "Simulated failure" } }),
				});
			}
			return route.continue();
		});

		// Click save (first match -- editor pages have two SaveButtons,
		// both submit the same form).
		const saveButton = page.getByRole("button", { name: "Save" }).first();
		await saveButton.click();

		// Wait for the error to be processed
		await page.waitForTimeout(1000);

		// The Save button should still be enabled (form is still dirty)
		// It should NOT show "Saved" — the mutation failed
		await expect(page.getByRole("button", { name: "Save" }).first()).toBeEnabled();

		// Remove the route intercept and restore title
		await page.unroute("**/api/sections/hero");
		await titleInput.fill(originalTitle);
	});

	test("taxonomy checkboxes clear when all terms are removed", async ({
		admin,
		page,
		serverInfo,
	}) => {
		// Navigate to a published post that we can assign terms to
		const postId = serverInfo.contentIds["posts"]?.[0];
		if (!postId) {
			test.skip();
			return;
		}

		await admin.goToEditContent("posts", postId);
		await admin.waitForLoading();

		// Wait for the taxonomy sidebar to load
		const taxonomyHeading = page.locator("h3", { hasText: "Taxonomies" });
		await expect(taxonomyHeading).toBeVisible({ timeout: 10000 });

		// Find the category checkboxes
		const newsCheckbox = page.getByRole("checkbox", { name: "News" });
		const tutorialsCheckbox = page.getByRole("checkbox", { name: "Tutorials" });

		// Check two categories
		await newsCheckbox.check();
		await page.waitForTimeout(500); // Wait for auto-save
		await tutorialsCheckbox.check();
		await page.waitForTimeout(500); // Wait for auto-save

		// Verify both are checked
		await expect(newsCheckbox).toBeChecked();
		await expect(tutorialsCheckbox).toBeChecked();

		// Now uncheck both — this is the bug scenario from PR #133
		await newsCheckbox.uncheck();
		await page.waitForTimeout(500);
		await tutorialsCheckbox.uncheck();
		await page.waitForTimeout(500);

		// All checkboxes should be unchecked (the old bug would leave stale checks)
		await expect(newsCheckbox).not.toBeChecked();
		await expect(tutorialsCheckbox).not.toBeChecked();
		await expect(page.getByRole("checkbox", { name: "Opinion" })).not.toBeChecked();

		// Reload to verify server state matches
		await page.reload();
		await admin.waitForShell();
		await admin.waitForLoading();

		// After reload, all should still be unchecked
		await expect(taxonomyHeading).toBeVisible({ timeout: 10000 });
		await expect(page.getByRole("checkbox", { name: "News" })).not.toBeChecked();
		await expect(page.getByRole("checkbox", { name: "Tutorials" })).not.toBeChecked();
		await expect(page.getByRole("checkbox", { name: "Opinion" })).not.toBeChecked();
	});
});
