/**
 * Widgets E2E Tests
 *
 * Tests widget area management at /widgets.
 * Covers creating widget areas, adding widgets, and deleting areas.
 *
 * The fixture starts with no widget areas, so tests create their own.
 */

import { test, expect } from "../fixtures";

// API helper
function apiHeaders(token: string, baseUrl: string) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};
}

test.describe("Widgets", () => {
	let headers: Record<string, string>;
	let baseUrl: string;
	let createdAreaNames: string[];

	test.beforeEach(async ({ admin, serverInfo }) => {
		createdAreaNames = [];
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);
	});

	test.afterEach(async () => {
		for (const areaName of createdAreaNames) {
			const response = await fetch(`${baseUrl}/_emdash/api/widget-areas/${areaName}`, {
				method: "DELETE",
				headers,
			});
			if (!response.ok && response.status !== 404) {
				throw new Error(`Failed to clean up widget area ${areaName}: ${response.status}`);
			}
		}
	});

	test.describe("Widget Areas Page", () => {
		test("renders the widgets page", async ({ admin, page }) => {
			await admin.goto("/widgets");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Should show the page title
			await expect(page.locator("h1").first()).toContainText("Widgets");

			// Should show the "Add Widget Area" button
			await expect(
				page.getByRole("main").locator("header").getByRole("button", { name: "Add widget area" }),
			).toBeVisible();

			// Should show the available widgets palette
			await expect(page.locator("h2", { hasText: "Available Widgets" })).toBeVisible({
				timeout: 10000,
			});
		});

		test("shows empty state when no widget areas exist", async ({ admin, page }) => {
			// Clean up any existing areas first
			const res = await fetch(`${baseUrl}/_emdash/api/widget-areas`, { headers });
			if (res.ok) {
				const data: any = await res.json();
				const areas = data.data?.areas ?? [];
				for (const area of areas) {
					await fetch(`${baseUrl}/_emdash/api/widget-areas/${area.name}`, {
						method: "DELETE",
						headers,
					}).catch(() => {});
				}
			}

			await admin.goto("/widgets");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Should show empty state
			await expect(page.locator("text=No widget areas yet")).toBeVisible({ timeout: 10000 });
		});

		test("shows built-in widget types in the palette", async ({ admin, page }) => {
			await admin.goto("/widgets");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Should show Content Block and Menu in the palette
			await expect(page.locator("text=Content Block").first()).toBeVisible({ timeout: 10000 });
			await expect(page.locator("text=Menu").first()).toBeVisible();
		});
	});

	test.describe("Create Widget Area", () => {
		test("opens and closes the create widget area dialog", async ({ admin, page }) => {
			await admin.goto("/widgets");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Click "Add Widget Area"
			await page
				.getByRole("main")
				.locator("header")
				.getByRole("button", { name: "Add widget area" })
				.click();

			// Dialog should appear
			const dialog = page.getByRole("dialog", { name: "Create Widget Area" });
			await expect(dialog).toBeVisible({ timeout: 5000 });

			// Should have Name, Label, Description fields
			await expect(dialog.getByLabel("Name")).toBeVisible();
			await expect(dialog.getByLabel("Label")).toBeVisible();

			// Cancel should close the dialog
			await dialog.getByRole("button", { name: "Cancel" }).click();
			await expect(dialog).not.toBeVisible({ timeout: 5000 });
		});

		test("creates a new widget area", async ({ admin, page }) => {
			const areaName = `e2e-area-${Date.now()}`;
			const areaLabel = `E2E Test Area ${areaName}`;
			createdAreaNames.push(areaName);

			await admin.goto("/widgets");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Open create dialog
			await page
				.getByRole("main")
				.locator("header")
				.getByRole("button", { name: "Add widget area" })
				.click();

			const dialog = page.getByRole("dialog", { name: "Create Widget Area" });
			await expect(dialog).toBeVisible({ timeout: 5000 });

			// Fill form
			await dialog.getByLabel("Name").fill(areaName);
			await dialog.getByLabel("Label").fill(areaLabel);
			await dialog.getByLabel("Description").fill("Area for E2E testing");

			// Submit
			await dialog.getByRole("button", { name: "Create" }).click();

			// Dialog should close
			await expect(dialog).not.toBeVisible({ timeout: 10000 });

			// New area should appear in the list
			await expect(page.getByRole("heading", { name: areaLabel, exact: true })).toBeVisible({
				timeout: 10000,
			});
		});
	});

	test.describe("Add Widget to Area", () => {
		test("adds a content widget to an area via API and verifies in UI", async ({ admin, page }) => {
			const areaName = `e2e-widget-${Date.now()}`;
			const areaLabel = `Widget Test Area ${areaName}`;
			createdAreaNames.push(areaName);

			// Create area via API
			await fetch(`${baseUrl}/_emdash/api/widget-areas`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: areaName, label: areaLabel }),
			});

			// Add a content widget via API
			await fetch(`${baseUrl}/_emdash/api/widget-areas/${areaName}/widgets`, {
				method: "POST",
				headers,
				body: JSON.stringify({ type: "content", title: "Test Content Widget" }),
			});

			// Navigate to widgets page
			await admin.goto("/widgets");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Area should be visible
			await expect(page.getByRole("heading", { name: areaLabel, exact: true })).toBeVisible({
				timeout: 10000,
			});

			// Widget should be visible in the area
			await expect(page.locator("text=Test Content Widget").first()).toBeVisible({
				timeout: 10000,
			});
		});

		test("deletes a widget from an area", async ({ admin, page }) => {
			const areaName = `e2e-del-widget-${Date.now()}`;
			const areaLabel = `Delete Widget Area ${areaName}`;
			const requestedWidgetTitle = `Widget To Delete ${areaName}`;
			createdAreaNames.push(areaName);

			// Create area and widget via API
			await fetch(`${baseUrl}/_emdash/api/widget-areas`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: areaName, label: areaLabel }),
			});

			const widgetRes = await fetch(`${baseUrl}/_emdash/api/widget-areas/${areaName}/widgets`, {
				method: "POST",
				headers,
				body: JSON.stringify({ type: "content", title: requestedWidgetTitle }),
			});
			const widgetData: any = await widgetRes.json();
			const widgetTitle = widgetData.data?.widget?.title ?? requestedWidgetTitle;

			// Navigate to widgets page
			await admin.goto("/widgets");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Widget should be visible
			await expect(
				page.getByRole("button", { name: `Edit settings for ${widgetTitle}` }),
			).toBeVisible({ timeout: 10000 });

			// Click the delete button on the widget
			const deleteButton = page.getByRole("button", { name: `Delete ${widgetTitle}` });
			await expect(deleteButton).toBeVisible();
			await deleteButton.click();
			const confirmDialog = page.getByRole("alertdialog", { name: `Delete ${widgetTitle}?` });
			await expect(confirmDialog).toBeVisible();
			await confirmDialog.getByRole("button", { name: "Delete", exact: true }).click();

			await expect(
				page.getByRole("button", { name: `Edit settings for ${widgetTitle}` }),
			).toHaveCount(0, { timeout: 10000 });
		});
	});

	test.describe("Delete Widget Area", () => {
		test("deletes a widget area with confirmation", async ({ admin, page }) => {
			const areaName = `e2e-del-area-${Date.now()}`;
			const areaLabel = `Area To Delete ${areaName}`;
			createdAreaNames.push(areaName);

			// Create area via API
			await fetch(`${baseUrl}/_emdash/api/widget-areas`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: areaName, label: areaLabel }),
			});

			await admin.goto("/widgets");
			await admin.waitForShell();
			await admin.waitForLoading();

			// Area should be visible
			await expect(page.getByRole("heading", { name: areaLabel, exact: true })).toBeVisible({
				timeout: 10000,
			});

			// Click the delete button on the area header
			const deleteAreaButton = page.getByRole("button", {
				name: `Delete ${areaLabel} widget area`,
			});
			await deleteAreaButton.click();

			// ConfirmDialog should appear
			const confirmDialog = page.getByRole("alertdialog", {
				name: `Delete ${areaLabel} widget area?`,
			});
			await expect(confirmDialog).toBeVisible({ timeout: 5000 });

			// Confirm deletion
			await confirmDialog.getByRole("button", { name: "Delete" }).click();

			// Area should disappear
			await expect(page.getByRole("heading", { name: areaLabel, exact: true })).toHaveCount(0, {
				timeout: 10000,
			});
		});

		test("cancel delete keeps the widget area", async ({ admin, page }) => {
			const areaName = `e2e-keep-area-${Date.now()}`;
			const areaLabel = `Area To Keep ${areaName}`;
			createdAreaNames.push(areaName);

			// Create area via API
			await fetch(`${baseUrl}/_emdash/api/widget-areas`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: areaName, label: areaLabel }),
			});

			await admin.goto("/widgets");
			await admin.waitForShell();
			await admin.waitForLoading();

			await expect(page.getByRole("heading", { name: areaLabel, exact: true })).toBeVisible({
				timeout: 10000,
			});

			// Click delete
			await page.getByRole("button", { name: `Delete ${areaLabel} widget area` }).click();

			// Dialog appears
			const confirmDialog = page.getByRole("alertdialog", {
				name: `Delete ${areaLabel} widget area?`,
			});
			await expect(confirmDialog).toBeVisible({ timeout: 5000 });

			// Cancel
			await confirmDialog.getByRole("button", { name: "Cancel" }).click();

			// Dialog closes
			await expect(confirmDialog).not.toBeVisible({ timeout: 5000 });

			// Area should still be there
			await expect(page.getByRole("heading", { name: areaLabel, exact: true })).toBeVisible();
		});
	});
});
