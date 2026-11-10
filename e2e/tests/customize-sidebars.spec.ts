/**
 * Personal sidebar layouts are saved on the shared dev user, so every test
 * clears the layout before and after it runs.
 */

import type { Page } from "@playwright/test";

import { test, expect } from "../fixtures";

async function clearLayout(page: Page) {
	const response = await page.request.post("/_emdash/api/auth/me", {
		headers: { "X-EmDash-Request": "1" },
		data: { action: "setAdminLayout", adminLayout: null },
	});
	expect(response.ok()).toBe(true);
}

async function storedLayout(page: Page) {
	const response = await page.request.get("/_emdash/api/auth/me");
	const body = (await response.json()) as {
		data: { adminLayout: { editor: { order: string[] }; nav: { hidden: string[] } } | null };
	};
	return body.data.adminLayout;
}

test.describe("Settings → Sidebars", () => {
	test.beforeEach(async ({ admin, page }) => {
		await admin.devBypassAuth();
		await clearLayout(page);
	});

	test.afterEach(async ({ page }) => {
		await clearLayout(page);
	});

	test("hides a navigation entry for the user and keeps it hidden after a reload", async ({
		admin,
		page,
	}) => {
		await admin.goto("/");
		await admin.waitForShell();
		const nav = page.locator('aside[aria-label="Admin navigation"]');
		await expect(nav.getByRole("link", { name: "Widgets" })).toBeVisible();

		await nav.getByRole("link", { name: "Customize sidebar" }).click();
		await expect(page).toHaveURL(/\/settings\/sidebars$/);

		const widgets = page.getByRole("switch", { name: "Show Widgets" });
		await expect(widgets).toBeEnabled();
		const saved = page.waitForResponse(
			(res) => res.url().endsWith("/_emdash/api/auth/me") && res.request().method() === "POST",
		);
		await widgets.click();
		await expect(nav.getByRole("link", { name: "Widgets" })).toHaveCount(0);
		expect((await saved).ok()).toBe(true);

		await page.reload();
		await admin.waitForShell();
		await expect(page.getByRole("switch", { name: "Show Widgets" })).not.toBeChecked();
		await expect(nav.getByRole("link", { name: "Widgets" })).toHaveCount(0);
		await expect(nav.getByRole("link", { name: "Menus" })).toBeVisible();
	});

	test("orders the editor sidebar on new and existing entries", async ({ admin, page }) => {
		await admin.goto("/settings/sidebars?tab=editor");
		await admin.waitForShell();
		await expect(page.getByRole("tab", { name: "Editor sidebar" })).toHaveAttribute(
			"aria-selected",
			"true",
		);

		const handle = page.getByRole("button", { name: "Reorder Bylines" });
		await expect(handle).toBeEnabled();
		await handle.focus();
		await page.keyboard.press("Alt+ArrowUp");
		await page.keyboard.press("Alt+ArrowUp");
		await expect(handle).toBeFocused();
		await expect
			.poll(async () => (await storedLayout(page))?.editor.order.slice(0, 3))
			.toEqual(["publish", "bylines", "url-language"]);

		const sections = page.locator("[data-settings-section]");
		const order = () =>
			sections.evaluateAll((elements) =>
				elements.map((element) => element.getAttribute("data-settings-section")),
			);

		await admin.goToNewContent("posts");
		await expect(sections.first()).toBeVisible();
		const newEntry = await order();
		expect(newEntry.indexOf("bylines")).toBeLessThan(newEntry.indexOf("url-language"));

		const id = await admin.createContent("posts", { title: `Sidebar order ${Date.now()}` });
		await admin.goToEditContent("posts", id);
		await expect(sections.first()).toBeVisible();
		expect((await order()).slice(0, 3)).toEqual(["publish", "bylines", "url-language"]);
	});

	test("opens the Editor sidebar tab from the editor without reloading the page", async ({
		admin,
		page,
	}) => {
		const id = await admin.createContent("posts", { title: `Customize link ${Date.now()}` });
		await admin.goToEditContent("posts", id);
		await page.evaluate(() => {
			(window as unknown as { sidebarsMarker: string }).sidebarsMarker = "kept";
		});

		await page
			.locator('aside[aria-label="Settings"]')
			.getByRole("link", { name: "Customize sidebar" })
			.click();

		await expect(page).toHaveURL(/\/settings\/sidebars\?tab=editor$/);
		await expect(page.getByRole("tab", { name: "Editor sidebar" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		expect(
			await page.evaluate(() => (window as unknown as { sidebarsMarker?: string }).sidebarsMarker),
		).toBe("kept");
	});
});
