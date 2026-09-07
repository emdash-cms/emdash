/**
 * Keyboard Shortcuts & Panel Dismiss E2E Tests
 *
 * Tests that keyboard shortcuts (Escape to close, Cmd+S to save) work
 * correctly in slide-out panels, and that the Shell sidebar auto-closes
 * on viewport resize.
 *
 * These verify the useStableCallback pattern — event listeners must
 * remain functional across re-renders without churn.
 */

import { test, expect } from "../fixtures";

test.describe("Keyboard Shortcuts", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Media Detail Panel", () => {
		test("Escape closes the media detail panel", async ({ admin, page }) => {
			await admin.goToMedia();
			await admin.waitForLoading();

			// Seed data includes uploaded media — click the first grid item (a button)
			const mediaItem = page.locator("[data-media-grid] button").first();
			await expect(mediaItem).toBeVisible({ timeout: 10000 });
			await mediaItem.click();

			// Panel should be visible
			const panel = page.locator("text=Media Details");
			await expect(panel).toBeVisible({ timeout: 5000 });

			// Press Escape
			await page.keyboard.press("Escape");

			// Panel should be closed
			await expect(panel).not.toBeVisible({ timeout: 3000 });
		});

		test("Cmd+S saves media detail changes", async ({ admin, page }) => {
			await admin.goToMedia();
			await admin.waitForLoading();

			// Click the first media item
			const mediaItem = page.locator("[data-media-grid] button").first();
			await expect(mediaItem).toBeVisible({ timeout: 10000 });
			await mediaItem.click();

			await expect(page.locator("text=Media Details")).toBeVisible({ timeout: 5000 });

			// Change alt text (only visible for images)
			const altInput = page.getByLabel("Alt Text");
			if (await altInput.isVisible({ timeout: 2000 }).catch(() => false)) {
				await altInput.fill(`E2E Alt ${Date.now()}`);

				// Listen for the update API call
				const saveResponse = page.waitForResponse(
					(res) =>
						res.url().includes("/api/media/") &&
						res.request().method() === "PUT" &&
						res.status() === 200,
					{ timeout: 10000 },
				);

				// Press Cmd+S (Control on Linux/CI)
				const modifier = process.platform === "darwin" ? "Meta" : "Control";
				await page.keyboard.press(`${modifier}+s`);

				// Should trigger the save
				await saveResponse;
			}
		});
	});

	test.describe("User Detail Panel", () => {
		test("Escape closes the user detail panel", async ({ admin, page }) => {
			await admin.goto("/users");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Click a user row to open the detail panel
			const userRow = page.locator("table tbody tr").first();
			await expect(userRow).toBeVisible({ timeout: 10000 });
			await userRow.click();

			// Panel should appear
			const panel = page.locator("text=User Details");
			await expect(panel).toBeVisible({ timeout: 5000 });

			// Press Escape
			await page.keyboard.press("Escape");

			// Panel should be closed
			await expect(panel).not.toBeVisible({ timeout: 3000 });
		});
	});

	test.describe("Shell Sidebar", () => {
		test("sidebar becomes mobile sheet when viewport shrinks below md breakpoint", async ({
			admin,
			page,
		}) => {
			await admin.goToDashboard();

			// Start at desktop width — sidebar should be visible as aside
			await page.setViewportSize({ width: 1280, height: 720 });
			const sidebar = page.locator('aside[aria-label="Admin navigation"]');
			await expect(sidebar).toBeVisible();

			// Shrink below kumo's mobile breakpoint (768px) — sidebar becomes a dialog sheet
			await page.setViewportSize({ width: 600, height: 720 });

			// The aside element should no longer be in the viewport
			await expect(sidebar).not.toBeInViewport({ timeout: 3000 });
		});
	});
});
