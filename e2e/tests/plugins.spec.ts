/**
 * Plugins Manager E2E Tests
 *
 * Tests the plugins manager admin page at /plugins-manager.
 * Verifies that the page renders, displays plugin info, and
 * supports enable/disable toggling.
 *
 * This test exists because the plugins page previously crashed due to
 * incorrect API response envelope unwrapping (fetchPlugins returned
 * { items: [...] } instead of [...]) -- a bug that component tests
 * never caught because they mock fetchPlugins at the module level.
 *
 * The e2e fixture configures a color plugin (id: "color", version: "0.0.1").
 */

import { test, expect } from "../fixtures";

test.describe("Plugins Manager", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Page rendering", () => {
		test("displays the plugins page with at least one plugin", async ({ admin, page }) => {
			await admin.goto("/plugins-manager");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Page title
			await admin.expectPageTitle("Plugins");

			// Should show the plugin count
			await expect(page.locator("text=/\\d+ plugin/")).toBeVisible({ timeout: 10000 });

			// Should have at least one plugin card (the color plugin from the fixture)
			const pluginCards = page.locator(".rounded-lg.border.bg-kumo-base");
			await expect(pluginCards.first()).toBeVisible({ timeout: 10000 });
		});

		test("does not show a crash or error state", async ({ admin, page }) => {
			await admin.goto("/plugins-manager");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Regression guard: the page must actually render its content (a blank
			// page must fail this) and must not fall back to the error state that
			// prompted this test.
			await expect(page.locator("text=/\\d+ plugin/")).toBeVisible({ timeout: 10000 });
			await expect(page.locator("text=Failed to load plugins")).not.toBeVisible();
		});
	});

	test.describe("Plugin card info", () => {
		test("shows plugin name, version, and toggle", async ({ admin, page }) => {
			await admin.goto("/plugins-manager");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Find the color plugin card
			const colorCard = page
				.locator(".rounded-lg.border.bg-kumo-base", { hasText: "color" })
				.first();
			await expect(colorCard).toBeVisible({ timeout: 10000 });

			// Plugin name
			await expect(colorCard.locator("h3")).toContainText("color");

			// Version badge
			await expect(colorCard.locator("text=v0.0.1")).toBeVisible();

			// Enable/disable switch
			const toggle = colorCard.locator("button[role='switch']");
			await expect(toggle).toBeVisible();
		});
	});

	test.describe("Enable / disable toggle", () => {
		test.skip("can disable a plugin and see the Disabled badge", async ({ admin, page }) => {
			// TODO: Enable/disable only works for marketplace plugins, not config plugins.
			await admin.goto("/plugins-manager");
			await admin.waitForShell();
			await admin.waitForLoading();

			const colorCard = page
				.locator(".rounded-lg.border.bg-kumo-base", { hasText: "color" })
				.first();
			await expect(colorCard).toBeVisible({ timeout: 10000 });

			const toggle = colorCard.locator("button[role='switch']");
			await expect(toggle).toBeVisible({ timeout: 5000 });

			// If the plugin is currently disabled, enable it first
			const isChecked = await toggle.getAttribute("aria-checked");
			if (isChecked !== "true") {
				await toggle.click();
				await page.waitForTimeout(2000);
				await admin.waitForLoading();
			}

			// Now disable the plugin
			await toggle.click();
			await page.waitForTimeout(2000);
			await admin.waitForLoading();

			// The "Disabled" badge should appear on the card
			await expect(colorCard.getByText("Disabled")).toBeVisible({ timeout: 10000 });

			// The toggle should now be unchecked
			await expect(toggle).toHaveAttribute("aria-checked", "false");
		});

		test.skip("can re-enable a disabled plugin", async ({ admin, page }) => {
			// TODO: Enable/disable only works for marketplace plugins, not config plugins.
			await admin.goto("/plugins-manager");
			await admin.waitForShell();
			await admin.waitForLoading();

			const colorCard = page
				.locator(".rounded-lg.border.bg-kumo-base", { hasText: "color" })
				.first();
			await expect(colorCard).toBeVisible({ timeout: 10000 });

			const toggle = colorCard.locator("button[role='switch']");
			await expect(toggle).toBeVisible({ timeout: 5000 });

			// Ensure the plugin is disabled first
			const isChecked = await toggle.getAttribute("aria-checked");
			if (isChecked === "true") {
				await toggle.click();
				await page.waitForTimeout(2000);
				await admin.waitForLoading();
			}

			// Verify it shows "Disabled"
			await expect(colorCard.getByText("Disabled")).toBeVisible({ timeout: 10000 });

			// Re-enable it
			await toggle.click();
			await page.waitForTimeout(2000);
			await admin.waitForLoading();

			// The "Disabled" badge should be gone
			await expect(colorCard.getByText("Disabled")).not.toBeVisible({ timeout: 10000 });

			// Toggle should be checked again
			await expect(toggle).toHaveAttribute("aria-checked", "true");
		});
	});

	test.describe("Expand details", () => {
		test("expand button reveals details section", async ({ admin, page }) => {
			await admin.goto("/plugins-manager");
			await admin.waitForShell();
			await admin.waitForLoading();

			const colorCard = page
				.locator(".rounded-lg.border.bg-kumo-base", { hasText: "color" })
				.first();
			await expect(colorCard).toBeVisible({ timeout: 10000 });

			// Find and click the expand button
			const expandBtn = colorCard.locator("button[aria-label='Expand details']");
			await expect(expandBtn).toBeVisible();
			await expandBtn.click();

			// The details section should now be visible (it has a border-t class)
			const detailsSection = colorCard.locator(".border-t.px-4");
			await expect(detailsSection).toBeVisible({ timeout: 5000 });

			// Collapse button should now be present
			await expect(colorCard.locator("button[aria-label='Collapse details']")).toBeVisible();
		});

		test("collapse button hides the details section", async ({ admin, page }) => {
			await admin.goto("/plugins-manager");
			await admin.waitForShell();
			await admin.waitForLoading();

			const colorCard = page
				.locator(".rounded-lg.border.bg-kumo-base", { hasText: "color" })
				.first();
			await expect(colorCard).toBeVisible({ timeout: 10000 });

			// Expand first
			await colorCard.locator("button[aria-label='Expand details']").click();
			const detailsSection = colorCard.locator(".border-t.px-4");
			await expect(detailsSection).toBeVisible({ timeout: 5000 });

			// Now collapse
			await colorCard.locator("button[aria-label='Collapse details']").click();

			// Details should be hidden
			await expect(detailsSection).not.toBeVisible({ timeout: 5000 });

			// Expand button should be back
			await expect(colorCard.locator("button[aria-label='Expand details']")).toBeVisible();
		});
	});

	test.describe("API integration", () => {
		test("plugins API returns the correct envelope shape", async ({ page, serverInfo }) => {
			// Directly verify the API response shape that caused the original bug.
			// fetchPlugins expected { data: { items: [...] } } but was getting
			// the items at a different nesting level.
			const res = await page.request.get("/_emdash/api/admin/plugins", {
				headers: {
					"X-EmDash-Request": "1",
					Authorization: `Bearer ${serverInfo.token}`,
				},
			});

			expect(res.ok()).toBe(true);
			const body = await res.json();

			// The response should have { data: { items: [...] } }
			expect(body.data).toBeDefined();
			expect(body.data.items).toBeDefined();
			expect(Array.isArray(body.data.items)).toBe(true);
			expect(body.data.items.length).toBeGreaterThan(0);

			// Each plugin should have the expected shape
			const plugin = body.data.items[0];
			expect(plugin.id).toBeDefined();
			expect(plugin.name).toBeDefined();
			expect(plugin.version).toBeDefined();
			expect(typeof plugin.enabled).toBe("boolean");
			expect(Array.isArray(plugin.capabilities)).toBe(true);
		});
	});
});
