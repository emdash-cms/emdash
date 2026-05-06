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
	});

	test.describe("Create Menu", () => {
		test("opens create menu dialog", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Click create menu button
			await page.getByRole("button", { name: "Create Menu" }).first().click();

			// Dialog should appear
			await expect(page.locator('[role="dialog"]')).toBeVisible();
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

			// Click cancel
			await page.click('button:has-text("Cancel")');

			// Dialog should close
			await expect(page.locator('[role="dialog"]')).not.toBeVisible();
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

		test("adds custom link to menu", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Create a new menu
			const menuName = `links-menu-${Date.now()}`;
			await admin.createMenu(menuName, "Links Menu");

			// Add a custom link
			await admin.addMenuLink("Home", "https://example.com");

			// Should show the new item in the menu editor
			const main = page.locator("main");
			await expect(main.locator("text=Home")).toBeVisible();
			await expect(main.locator("text=https://example.com")).toBeVisible();
		});

		test("adds multiple menu items", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Create a new menu
			const menuName = `multi-menu-${Date.now()}`;
			await admin.createMenu(menuName, "Multi Menu");

			// Add multiple links
			await admin.addMenuLink("Home", "https://example.com");
			await admin.addMenuLink("About", "https://example.com/about");
			await admin.addMenuLink("Contact", "https://example.com/contact");

			// All URLs should be visible (unique to the menu items)
			await expect(page.locator("text=https://example.com").first()).toBeVisible();
			await expect(page.locator("text=https://example.com/about")).toBeVisible();
			await expect(page.locator("text=https://example.com/contact")).toBeVisible();
		});

		test("deletes menu item", async ({ admin, page }) => {
			await admin.goToMenus();
			await admin.waitForLoading();

			// Create menu with item
			const menuName = `delete-item-${Date.now()}`;
			await admin.createMenu(menuName, "Delete Item Menu");
			await admin.addMenuLink("To Delete", "https://example.com");

			// Verify item exists
			await expect(page.locator("text=To Delete")).toBeVisible();

			// Click the trash icon button (last button in the menu item row)
			const itemRow = page.locator(".border.rounded-lg").filter({ hasText: "To Delete" });
			await itemRow.locator("button").last().click();

			// Item should be removed
			await admin.waitForLoading();
			await expect(page.locator("text=To Delete")).not.toBeVisible();
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
			await expect(page.locator(`text=${menuLabel}`).first()).toBeVisible();

			// Click trash icon on the menu card (last button in the card row)
			const menuCard = page.locator(".rounded-lg").filter({ hasText: menuLabel }).first();
			await menuCard.getByRole("button").last().click();

			// Confirm deletion in alert dialog
			await page.getByRole("button", { name: "Delete" }).click();

			// Menu should be removed
			await admin.waitForLoading();
			await expect(page.locator(`text=${menuLabel}`)).not.toBeVisible();
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

			// Click trash icon
			const menuCard = page.locator(".rounded-lg").filter({ hasText: menuLabel }).first();
			await menuCard.getByRole("button").last().click();

			// Cancel deletion
			await page.getByRole("button", { name: "Cancel" }).click();

			// Menu should still be there
			await expect(page.locator(`text=${menuLabel}`).first()).toBeVisible();
		});
	});
});
