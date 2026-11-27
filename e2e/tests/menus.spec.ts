/**
 * Menus E2E Tests
 *
 * Tests creating, editing, and managing navigation menus.
 * Runs against an isolated fixture — starts with no menus.
 */

import { test, expect } from "../fixtures";

test.describe("Menus", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Menu List", () => {
		test("displays menus page", async ({ admin }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Should show menus heading
			await admin.expectPageTitle("Menus");

			// Should have Create Menu button
			await expect(admin.page.getByRole("button", { name: "Create Menu" }).first()).toBeVisible();
		});

		test("shows empty state when no menus", async ({ admin }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Should show empty state message
			await expect(admin.page.locator("text=No menus yet")).toBeVisible();
		});

		test("opens a menu editor by clicking its title", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			const menuName = `title-link-${Date.now()}`;
			const menuLabel = "Title Link Menu";
			await admin.createMenu(menuName, menuLabel);
			await admin.goToMenus();
			await admin.waitForLoading();

			await page.getByRole("link", { name: menuLabel }).click();
			await expect(page).toHaveURL(new RegExp(`/menus/${menuName}(\\?|$)`));
		});
	});

	test.describe("Create Menu", () => {
		test("opens create menu dialog", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Click create menu button
			await page.getByRole("button", { name: "Create Menu" }).first().click();

			// Dialog should appear
			await expect(page.getByRole("dialog", { name: "Create menu" })).toBeVisible();
		});

		test("creates a new menu", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			const menuName = `test-menu-${Date.now()}`;
			const menuLabel = "E2E Test Menu";

			// Create menu
			await admin.createMenu(menuName, menuLabel);

			// Should redirect to menu editor (URL may include ?locale=... in i18n mode)
			await expect(page).toHaveURL(new RegExp(`/menus/${menuName}(\\?|$)`));

			// Should show the menu label
			await expect(page.locator("h1")).toContainText(menuLabel);
		});

		test("cancels menu creation", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Open dialog
			await page.getByRole("button", { name: "Create Menu" }).first().click();
			const dialog = page.getByRole("dialog", { name: "Create menu" });
			await expect(dialog).toBeVisible();

			// Click cancel
			await dialog.getByRole("button", { name: "Cancel" }).click();

			// Dialog should close
			await expect(dialog).not.toBeVisible();
		});
	});

	test.describe("Edit Menu", () => {
		test("shows empty items state for new menu", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Create a new empty menu
			const menuName = `empty-menu-${Date.now()}`;
			await admin.createMenu(menuName, "Empty Menu");

			// Should show empty state
			await expect(page.locator("text=No menu items yet")).toBeVisible();
		});

		test("adds custom link to menu", async ({ admin }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Create a new menu
			const menuName = `links-menu-${Date.now()}`;
			await admin.createMenu(menuName, "Links Menu");

			// Add a custom link
			await admin.addMenuLink("Home", "https://example.com");

			// Should show the new item and its URL in the menu editor
			const row = admin.menuItemRow("Home");
			await expect(row).toBeVisible();
			await expect(row).toContainText("https://example.com");
		});

		test("adds multiple menu items", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Create a new menu
			const menuName = `multi-menu-${Date.now()}`;
			await admin.createMenu(menuName, "Multi Menu");

			// Add multiple links, one dialog each
			await admin.addMenuLink("Home", "https://example.com");
			await admin.addMenuLink("About", "https://example.com/about");
			await admin.addMenuLink("Contact", "https://example.com/contact");

			// All URLs should be visible (unique to the menu items)
			const list = page.getByRole("list", { name: "Menu items" });
			await expect(list.getByText("https://example.com", { exact: true })).toBeVisible();
			await expect(list.getByText("https://example.com/about")).toBeVisible();
			await expect(list.getByText("https://example.com/contact")).toBeVisible();
		});

		test("adds several items in one dialog", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			const menuName = `batch-menu-${Date.now()}`;
			await admin.createMenu(menuName, "Batch Menu");

			await admin.addMenuLinks([
				{ label: "Home", url: "https://example.com" },
				{ label: "About", url: "https://example.com/about" },
				{ label: "Contact", url: "https://example.com/contact" },
			]);

			await expect(page.getByText("Added 3 items")).toBeVisible();
			await expect(admin.menuItemLabels()).toHaveText(["Home", "About", "Contact"]);
		});

		test("reorders and nests items from the row actions menu", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			const menuName = `reorder-menu-${Date.now()}`;
			await admin.createMenu(menuName, "Reorder Menu");
			await admin.addMenuLinks([
				{ label: "Home", url: "https://example.com" },
				{ label: "About", url: "https://example.com/about" },
				{ label: "Contact", url: "https://example.com/contact" },
			]);
			await expect(admin.menuItemLabels()).toHaveText(["Home", "About", "Contact"]);

			const saved = page.waitForResponse(
				(response) =>
					response.url().includes(`/menus/${menuName}/reorder`) &&
					response.request().method() === "POST",
			);
			await admin.chooseMenuAction("Home", "Move down");
			await expect(admin.menuItemLabels()).toHaveText(["About", "Home", "Contact"]);
			expect((await saved).ok()).toBe(true);

			const nested = page.waitForResponse(
				(response) =>
					response.url().includes(`/menus/${menuName}/reorder`) &&
					response.request().method() === "POST",
			);
			await admin.chooseMenuAction("Contact", "Indent");
			expect((await nested).ok()).toBe(true);

			await page.reload();
			await admin.waitForShell();
			await expect(admin.menuItemLabels()).toHaveText(["About", "Home", "Contact"]);
			await admin.page.getByRole("button", { name: "Actions for Contact", exact: true }).click();
			await expect(page.getByRole("menuitem", { name: "Outdent", exact: true })).toBeEnabled();
			await expect(page.getByRole("menuitem", { name: "Indent", exact: true })).toBeDisabled();
		});

		test("deletes menu item", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Create menu with item
			const menuName = `delete-item-${Date.now()}`;
			await admin.createMenu(menuName, "Delete Item Menu");
			await admin.addMenuLink("To Delete", "https://example.com");

			// Verify item exists
			const row = admin.menuItemRow("To Delete");
			await expect(row).toBeVisible();

			await admin.chooseMenuAction("To Delete", "Delete");

			const dialog = page.getByRole("dialog", { name: "Delete menu item?" });
			await dialog.getByRole("button", { name: "Delete" }).click();
			await expect(dialog).not.toBeVisible();

			// Item should be removed
			await admin.waitForLoading();
			await expect(row).not.toBeVisible();
		});
	});

	test.describe("Delete Menu", () => {
		test("deletes a menu from list", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Create a menu to delete
			const menuName = `to-delete-${Date.now()}`;
			const menuLabel = "To Delete Menu";
			await admin.createMenu(menuName, menuLabel);

			// Go back to list
			await admin.goToMenus();
			await admin.waitForLoading();

			// Menu should be in list
			const menuLink = page.getByRole("link", { name: menuLabel });
			await expect(menuLink).toBeVisible();

			await admin.deleteMenu(menuLabel);

			// Menu should be removed
			await admin.waitForLoading();
			await expect(menuLink).not.toBeVisible();
		});

		test("cancel delete keeps menu", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Create a menu
			const menuName = `keep-menu-${Date.now()}`;
			const menuLabel = "Keep This Menu";
			await admin.createMenu(menuName, menuLabel);

			// Go back to list
			await admin.goToMenus();
			await admin.waitForLoading();

			await admin.chooseMenuAction(menuLabel, "Delete");

			// Cancel deletion
			const dialog = page.getByRole("dialog", { name: "Delete menu" });
			await dialog.getByRole("button", { name: "Cancel" }).click();
			await expect(dialog).not.toBeVisible();

			// Menu should still be there
			await expect(page.getByRole("link", { name: menuLabel })).toBeVisible();
		});
	});
});
