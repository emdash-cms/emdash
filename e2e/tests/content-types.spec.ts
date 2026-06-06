/**
 * Content Types / Schema Editor E2E Tests
 *
 * Tests listing, viewing, creating, editing fields, and deleting content types.
 * Runs against an isolated fixture with seeded posts and pages collections.
 *
 * Seed data (from fixture/.emdash/seed.json):
 *   - posts: title (string, required), body (portableText), excerpt (text), theme_color (string)
 *   - pages: title (string, required), body (portableText)
 */

import { test, expect } from "../fixtures";

// Regex patterns (module scope per lint rules)
const CONTENT_TYPES_SLUG_PATTERN = /\/content-types\/posts$/;

// Fixed test slug -- sequential tests (workers: 1) share state.
// Use a fixed value so cross-test dependencies work reliably.
const TEST_SLUG = "e2e_test_articles";
const TEST_LABEL_SINGULAR = "Article";
const TEST_LABEL_PLURAL = `${TEST_LABEL_SINGULAR}s`;

test.describe("Content Types", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Content Types List", () => {
		test("displays seeded collections in a table", async ({ admin }) => {
			await admin.goto("/content-types");
			await admin.waitForLoading();

			// Page title
			await admin.expectPageTitle("Content Types");

			// Should show the table
			await expect(admin.page.locator("table")).toBeVisible();

			// Seeded collections should appear as links in the table (scope to table to avoid sidebar)
			const table = admin.page.locator("table");
			await expect(table.getByRole("link", { name: "Posts", exact: true })).toBeVisible();
			await expect(table.getByRole("link", { name: "Pages", exact: true })).toBeVisible();
		});

		test("shows slug column for each collection", async ({ admin }) => {
			await admin.goto("/content-types");
			await admin.waitForLoading();

			// Slug values rendered as <code> elements inside the table
			await expect(admin.page.locator("table code", { hasText: "posts" })).toBeVisible();
			await expect(admin.page.locator("table code", { hasText: "pages" })).toBeVisible();
		});

		test("has a New Content Type button", async ({ admin }) => {
			await admin.goto("/content-types");
			await admin.waitForLoading();

			await expect(admin.page.getByRole("link", { name: "New Content Type" })).toBeVisible();
		});
	});

	test.describe("View Content Type", () => {
		test("clicking a collection shows its field list", async ({ admin }) => {
			await admin.goto("/content-types");
			await admin.waitForLoading();

			// Click into the posts collection (scope to table to avoid sidebar link)
			await admin.page.locator("table").getByRole("link", { name: "Posts", exact: true }).click();

			// Should navigate to the editor page
			await expect(admin.page).toHaveURL(CONTENT_TYPES_SLUG_PATTERN, {
				timeout: 10000,
			});

			// Page heading should show the collection label
			await admin.expectPageTitle("Posts");

			// Should show system fields section
			await expect(admin.page.getByText("System Fields")).toBeVisible();

			// Should show custom fields section
			await expect(admin.page.getByText("Custom Fields", { exact: true })).toBeVisible();
		});

		test("shows expected custom fields for posts", async ({ admin }) => {
			await admin.goto("/content-types/posts");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Custom field labels
			await expect(admin.page.getByText("Title").first()).toBeVisible();
			await expect(admin.page.getByText("Body").first()).toBeVisible();
			await expect(admin.page.getByText("Excerpt").first()).toBeVisible();

			// Field slugs rendered as <code> elements
			await expect(admin.page.locator("code", { hasText: "title" }).first()).toBeVisible();
			await expect(admin.page.locator("code", { hasText: "body" }).first()).toBeVisible();
			await expect(admin.page.locator("code", { hasText: "excerpt" }).first()).toBeVisible();
		});

		test("shows system fields for a collection", async ({ admin }) => {
			await admin.goto("/content-types/posts");
			await admin.waitForShell();
			await admin.waitForLoading();

			// System field slugs
			for (const slug of ["id", "slug", "status", "created_at", "updated_at", "published_at"]) {
				await expect(admin.page.locator("code", { hasText: slug }).first()).toBeVisible();
			}
		});
	});

	test.describe("Save Content Type Settings", () => {
		test("toggling a feature and saving persists across reloads", async ({ admin }) => {
			await admin.goto("/content-types/posts");
			await admin.waitForShell();
			await admin.waitForLoading();

			const toggleLabel = admin.page.locator("label", { hasText: "Enable comments" });
			const saveButton = admin.page.getByRole("button", { name: "Save Changes" });

			// On initial load there are no unsaved changes
			await expect(saveButton).toBeDisabled();

			// Flip the toggle -- Save should enable
			await toggleLabel.click();
			await expect(saveButton).toBeEnabled();

			// Save: the PUT must return 200 and no failure toast should render
			const savePut = admin.page.waitForResponse(
				(res) =>
					res.url().includes("/api/schema/collections/posts") && res.request().method() === "PUT",
				{ timeout: 10000 },
			);
			await saveButton.click();
			expect((await savePut).status()).toBe(200);
			await expect(admin.page.getByText("Failed to save")).not.toBeVisible();

			// Reload -- the saved change is reflected server-side, so the editor
			// loads with no unsaved diff
			await admin.page.reload();
			await admin.waitForShell();
			await admin.waitForLoading();
			await expect(saveButton).toBeDisabled();

			// Restore the original toggle state so the shared DB used by other E2E
			// tests (e.g. comments.spec.ts) isn't left with commentsEnabled flipped.
			await toggleLabel.click();
			await expect(saveButton).toBeEnabled();
			const restorePut = admin.page.waitForResponse(
				(res) =>
					res.url().includes("/api/schema/collections/posts") && res.request().method() === "PUT",
				{ timeout: 10000 },
			);
			await saveButton.click();
			expect((await restorePut).status()).toBe(200);
			await expect(admin.page.getByText("Failed to save")).not.toBeVisible();
			await admin.page.reload();
			await admin.waitForShell();
			await admin.waitForLoading();
			await expect(saveButton).toBeDisabled();
		});
	});

	test.describe("Create Content Type", () => {
		test("creates a new content type and redirects to editor", async ({ admin }) => {
			await admin.goto("/content-types/new");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Page heading
			await admin.expectPageTitle("New Content Type");

			// Fill in the singular label -- this auto-generates plural label and slug
			const singularInput = admin.page.getByLabel("Label (Singular)");
			await singularInput.fill(TEST_LABEL_SINGULAR);

			// Verify auto-generated plural label
			const pluralInput = admin.page.getByLabel("Label (Plural)");
			await expect(pluralInput).toHaveValue(TEST_LABEL_PLURAL);

			// Override slug with our unique test slug
			const slugInput = admin.page.getByLabel("Slug");
			await slugInput.fill(TEST_SLUG);

			// Submit
			await admin.page.getByRole("button", { name: "Create Content Type" }).click();

			// Should redirect to the new collection's editor page
			await expect(admin.page).toHaveURL(new RegExp(`/content-types/${TEST_SLUG}$`), {
				timeout: 15000,
			});

			// Heading should show the plural label
			await admin.expectPageTitle(TEST_LABEL_PLURAL);
		});

		test("new collection appears in the content types list", async ({ admin }) => {
			await admin.goto("/content-types");
			await admin.waitForLoading();

			// The collection we created in the previous test should appear (scope to table)
			await expect(
				admin.page.locator("table").getByRole("link", { name: TEST_LABEL_PLURAL, exact: true }),
			).toBeVisible({ timeout: 10000 });

			await expect(admin.page.locator("table code", { hasText: TEST_SLUG })).toBeVisible();
		});
	});

	test.describe("Add Field to Content Type", () => {
		test("adds a text field to the test collection", async ({ admin }) => {
			await admin.goto(`/content-types/${TEST_SLUG}`);
			await admin.waitForShell();
			await admin.waitForLoading();

			// Wait for the collection editor to fully load
			await admin.expectPageTitle(TEST_LABEL_PLURAL);

			// Click "Add Field" button
			await admin.page.getByRole("button", { name: "Add Field" }).first().click();

			// The field editor dialog should open -- first step is type selection
			const dialog = admin.page.locator('[role="dialog"]');
			await expect(dialog).toBeVisible({ timeout: 5000 });

			// Select "Short Text" field type
			await dialog.getByText("Short Text").click();

			// Now on the config step -- fill in label (slug auto-generates)
			await dialog.getByLabel("Label").fill("Summary");

			// Verify slug was auto-generated
			await expect(dialog.getByLabel("Slug")).toHaveValue("summary");

			// Click save
			await dialog.getByRole("button", { name: "Add Field" }).click();

			// Dialog should close
			await expect(dialog).not.toBeVisible({ timeout: 10000 });

			// The new field should appear in the field list
			await admin.waitForLoading();
			await expect(admin.page.getByText("Summary", { exact: true })).toBeVisible({
				timeout: 10000,
			});
			await expect(admin.page.locator("code", { hasText: "summary" })).toBeVisible();
		});
	});

	test.describe("Delete Content Type", () => {
		test("deletes the test-created collection", async ({ admin }) => {
			await admin.goto("/content-types");
			await admin.waitForLoading();

			// Verify the test collection exists before deletion
			await expect(admin.page.locator("table code", { hasText: TEST_SLUG })).toBeVisible({
				timeout: 10000,
			});

			// Find the row for the test collection and click its delete button
			const row = admin.page.locator("tr").filter({ hasText: TEST_LABEL_PLURAL });
			await row.getByRole("button", { name: `Delete ${TEST_LABEL_PLURAL}` }).click();

			// Confirm deletion in the dialog
			const dialog = admin.page.locator('[role="dialog"]');
			await expect(dialog).toBeVisible({ timeout: 5000 });
			await dialog.getByRole("button", { name: "Delete" }).click();

			// Collection should disappear from the list
			await admin.waitForLoading();
			await expect(admin.page.locator("table code", { hasText: TEST_SLUG })).not.toBeVisible({
				timeout: 10000,
			});
		});
	});
});
