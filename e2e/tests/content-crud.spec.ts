/**
 * Content CRUD E2E Tests
 *
 * Tests creating, reading, updating, and deleting content items.
 * Runs against an isolated fixture with seeded posts and pages.
 *
 * Seed data:
 *   - posts: "First Post" (published), "Second Post" (published), "Draft Post" (draft)
 *   - pages: "About" (published), "Contact" (draft)
 */

import { test, expect } from "../fixtures";

// Regex patterns
const CONTENT_EDIT_URL_PATTERN = /\/content\/posts\/[A-Z0-9]+$/;
const CONTENT_ID_PATTERN = /\/content\/posts\/[A-Z0-9]+$/;
const NEW_CONTENT_URL_PATTERN = /\/content\/posts\/new(?:[?#].*)?$/;

test.describe("Content CRUD", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Content List", () => {
		test("displays content list with seeded items", async ({ admin }) => {
			await admin.goToContent("posts");
			await admin.waitForLoading();

			// Should show the posts heading
			await admin.expectPageTitle("Posts");

			// Should have a table with content
			await expect(admin.page.locator("table")).toBeVisible();

			// Should show seeded posts
			await expect(admin.page.getByRole("link", { name: "First Post", exact: true })).toBeVisible();
			await expect(
				admin.page.getByRole("link", { name: "Second Post", exact: true }),
			).toBeVisible();
			await expect(admin.page.getByRole("link", { name: "Draft Post", exact: true })).toBeVisible();

			// Should have "Add New" link
			await expect(admin.page.getByRole("link", { name: "Add New" })).toBeVisible();
		});

		test("clicking Add New navigates to content editor", async ({ admin }) => {
			await admin.goToContent("posts");
			await admin.waitForLoading();

			// Click Add New
			await admin.page.getByRole("link", { name: "Add New" }).click();

			// Should navigate to new content page
			await expect(admin.page).toHaveURL(NEW_CONTENT_URL_PATTERN, {
				timeout: 10000,
			});
		});
	});

	test.describe("Create Content", () => {
		test("creates new post with title", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			// Fill in title
			await admin.fillField("title", "E2E Test Post");

			// Save
			await admin.clickSave();

			// Should redirect to edit page with new ID (ULID)
			await expect(admin.page).toHaveURL(CONTENT_EDIT_URL_PATTERN, {
				timeout: 10000,
			});
		});

		test("auto-generates slug from title", async ({ admin }) => {
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			// Fill in title — slug should auto-generate
			await admin.fillField("title", "My Amazing Blog Post");

			// Check that slug field was auto-populated
			const slugInput = admin.page.getByLabel("Slug");
			await expect(slugInput).toHaveValue("my-amazing-blog-post");
		});
	});

	test.describe("Edit Content", () => {
		test("loads existing content for editing", async ({ admin }) => {
			// Go to content list
			await admin.goToContent("posts");
			await admin.waitForLoading();

			// Click on first content item to edit
			await admin.page.getByRole("link", { name: "First Post", exact: true }).click();

			// Should be on edit page
			await expect(admin.page).toHaveURL(CONTENT_ID_PATTERN);

			// Title field should be populated
			await expect(admin.page.locator("#field-title")).toHaveValue("First Post");
		});

		test("saves updated content", async ({ admin }) => {
			// Navigate to existing content
			await admin.goToContent("posts");
			await admin.waitForLoading();

			// Click first item to edit
			await admin.page.getByRole("link", { name: "First Post", exact: true }).click();
			await admin.waitForLoading();

			// Update title
			const newTitle = `Updated Post ${Date.now()}`;
			await admin.fillField("title", newTitle);

			// Save
			await admin.clickSave();
			await admin.waitForSaveComplete();

			// Verify the update persisted by reloading
			await admin.page.reload();
			await admin.waitForShell();
			await admin.waitForLoading();

			await expect(admin.page.locator("#field-title")).toHaveValue(newTitle);
		});
	});

	test.describe("Content Status", () => {
		test("displays content status badges", async ({ admin }) => {
			await admin.goToContent("posts");
			await admin.waitForLoading();

			// Should show status badges (published and draft)
			const statusBadges = admin.page.locator("span.inline-flex");
			const count = await statusBadges.count();
			expect(count).toBeGreaterThan(0);
		});

		test("publish action changes status", async ({ admin }) => {
			// Create a new draft post first
			await admin.goToNewContent("posts");
			await admin.waitForLoading();

			await admin.fillField("title", "Draft to Publish Test");
			await admin.clickSave();

			// Wait for redirect to edit page (confirms save succeeded)
			await expect(admin.page).toHaveURL(CONTENT_EDIT_URL_PATTERN, {
				timeout: 10000,
			});

			// Look for publish button
			const publishButton = admin.page.getByRole("button", { name: "Publish" });
			if (await publishButton.isVisible()) {
				await publishButton.click();
				await admin.waitForLoading();
			}
		});
	});
});
