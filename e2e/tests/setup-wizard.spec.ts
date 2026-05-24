/**
 * Setup Wizard E2E Tests
 *
 * Tests the first-run onboarding experience when the database is empty.
 * Uses the dev-reset endpoint to clear setup state before each test.
 *
 * Note: The full setup flow requires passkey registration which can't be
 * automated in browser tests. These tests cover the site and admin steps
 * only. The "setup complete → redirect" test uses dev-bypass to simulate
 * a completed setup.
 */

import { test, expect } from "../fixtures";
import { refreshServerPatAfterDevBypass } from "../fixtures/refresh-server-pat";

const BASE_URL = "http://localhost:4444";
const ADMIN_DASHBOARD_PATTERN = /\/_emdash\/admin\/?$/;

async function resetSetup(): Promise<void> {
	const res = await fetch(`${BASE_URL}/_emdash/api/setup/dev-reset`, {
		method: "POST",
		headers: { "X-EmDash-Request": "1", Origin: BASE_URL },
	});
	if (!res.ok) {
		throw new Error(`dev-reset failed (${res.status}): ${await res.text()}`);
	}
}

async function restoreSetup(): Promise<void> {
	await refreshServerPatAfterDevBypass(BASE_URL);
}

test.describe("Setup Wizard", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeEach(async () => {
		await resetSetup();
	});

	test.afterAll(async () => {
		await restoreSetup();
	});

	test("redirects to setup wizard when database is empty", async ({ admin }) => {
		await admin.goto("/");
		await admin.expectSetupPage();
	});

	test("displays site step with form fields", async ({ admin }) => {
		await admin.goToSetup();

		await expect(admin.page.locator("text=Set up your site")).toBeVisible();
		await expect(admin.page.getByLabel("Site Title")).toBeVisible();
		await expect(admin.page.getByLabel("Tagline")).toBeVisible();
		await expect(admin.page.getByRole("button", { name: "Continue" })).toBeVisible();
	});

	test("shows validation error when title is empty", async ({ admin }) => {
		await admin.goToSetup();

		await admin.page.getByRole("button", { name: "Continue" }).click();

		await expect(admin.page.locator("text=Site title is required")).toBeVisible();
	});

	test("advances to admin step after filling site info", async ({ admin }) => {
		await admin.goToSetup();

		await admin.page.getByLabel("Site Title").fill("My Test Site");
		await admin.page.getByLabel("Tagline").fill("A site for testing");
		await admin.page.getByRole("button", { name: "Continue" }).click();

		await expect(admin.page.locator("text=Create your account")).toBeVisible();
		await expect(admin.page.getByLabel("Your Email")).toBeVisible();
		await expect(admin.page.getByLabel("Your Name")).toBeVisible();
	});

	test("advances to passkey step after filling admin info", async ({ admin }) => {
		await admin.goToSetup();

		// Complete site step
		await admin.page.getByLabel("Site Title").fill("My Test Site");
		await admin.page.getByRole("button", { name: "Continue" }).click();
		await expect(admin.page.locator("text=Create your account")).toBeVisible();

		// Complete admin step
		await admin.page.getByLabel("Your Email").fill("test@example.com");
		await admin.page.getByLabel("Your Name").fill("Test User");
		await admin.page.getByRole("button", { name: "Continue" }).click();

		await expect(admin.page.locator("text=Secure your account")).toBeVisible();
		await expect(admin.page.locator("text=Choose how to sign in")).toBeVisible();
	});

	test("setup wizard not accessible after setup complete", async ({ admin }) => {
		// Complete setup and authenticate via dev-bypass through the browser
		await admin.devBypassAuth();

		await admin.goToSetup();

		// Should redirect to dashboard (setup already complete)
		await admin.page.waitForURL(ADMIN_DASHBOARD_PATTERN, { timeout: 10000 });
	});
});
