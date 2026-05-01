/**
 * Edit-mode toolbar toggle E2E tests.
 *
 * Related: #878 — frontend "Edit" toggle reloads the page but reverts to off.
 *
 * The visual-editing toolbar is rendered server-side (via middleware) and
 * driven by an inlined <script>. Clicking the toggle:
 *   1. Writes the `emdash-edit-mode` cookie.
 *   2. Triggers a same-document reload.
 * The server then re-renders the toolbar based on the cookie, producing a
 * checked toggle and `data-edit-mode="true"` for editors with role >= 30.
 *
 * These tests drive the real toggle in a real browser and observe the
 * post-reload rendered state. They are the only tests that meaningfully
 * exercise this end-to-end — the previous unit tests asserted on string
 * literals in the rendered HTML, which would happily pass for any change
 * that produced those substrings (including a no-op or a broken fix).
 *
 * Note on reproduction: in headless Chromium 145, the toggle works on both
 * `location.replace(location.href) + startViewTransition` (the previous
 * pre-fix code) and on `location.reload()` (the fix). The user-reported
 * failure mode in #878 is browser/environment-specific and does not surface
 * in this test runner. The tests below therefore guard the toggle's
 * happy-path behaviour rather than recreating the original failure.
 * If the toggle ever stops working in headless Chromium too, these tests
 * will catch it.
 */

import { test, expect } from "../fixtures";

const TOOLBAR_SEL = "#emdash-toolbar";
const TOGGLE_SEL = "#emdash-edit-toggle";
const TOGGLE_LABEL_SEL = ".emdash-tb-toggle";

async function authenticateAsEditor(page: import("@playwright/test").Page): Promise<void> {
	// dev-bypass creates a ROLE_ADMIN (50) user — comfortably above the
	// `role >= 30` (AUTHOR) gate the request-context middleware checks
	// before injecting the toolbar.
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/");
	await page.waitForLoadState("networkidle");
}

test.describe("Edit-mode toggle (#878)", () => {
	test("toggle on -> server renders edit mode after reload", async ({ page }) => {
		await authenticateAsEditor(page);

		await page.goto("/");
		await page.waitForLoadState("domcontentloaded");

		// Initial state: toolbar present, edit mode off.
		const toolbar = page.locator(TOOLBAR_SEL);
		await expect(toolbar).toBeAttached({ timeout: 10000 });
		await expect(toolbar).toHaveAttribute("data-edit-mode", "false");
		await expect(page.locator(TOGGLE_SEL)).not.toBeChecked();

		// Click the visible label (the underlying checkbox is visually hidden
		// via opacity:0/width:0 — clicking the label is the real user flow).
		await page.locator(TOGGLE_LABEL_SEL).click();

		// The handler reloads. Wait for the navigation to settle, then re-
		// query the toolbar from the new document.
		await page.waitForLoadState("domcontentloaded");

		await expect(page.locator(TOOLBAR_SEL)).toHaveAttribute("data-edit-mode", "true", {
			timeout: 10000,
		});
		await expect(page.locator(TOGGLE_SEL)).toBeChecked();

		// And the cookie crossed the navigation.
		const cookies = await page.context().cookies();
		const editCookie = cookies.find((c) => c.name === "emdash-edit-mode");
		expect(editCookie?.value).toBe("true");
	});

	test("toggle off -> server renders non-edit mode after reload", async ({ page }) => {
		await authenticateAsEditor(page);

		// Pre-set the edit cookie so we land in edit mode.
		await page.context().addCookies([
			{
				name: "emdash-edit-mode",
				value: "true",
				domain: "localhost",
				path: "/",
			},
		]);

		await page.goto("/");
		await page.waitForLoadState("domcontentloaded");

		await expect(page.locator(TOOLBAR_SEL)).toHaveAttribute("data-edit-mode", "true", {
			timeout: 10000,
		});
		await expect(page.locator(TOGGLE_SEL)).toBeChecked();

		await page.locator(TOGGLE_LABEL_SEL).click();
		await page.waitForLoadState("domcontentloaded");

		await expect(page.locator(TOOLBAR_SEL)).toHaveAttribute("data-edit-mode", "false", {
			timeout: 10000,
		});
		await expect(page.locator(TOGGLE_SEL)).not.toBeChecked();

		// Cleared cookie may show as undefined or empty depending on browser.
		const cookies = await page.context().cookies();
		const editCookie = cookies.find((c) => c.name === "emdash-edit-mode");
		expect(editCookie?.value ?? "").toBe("");
	});
});
