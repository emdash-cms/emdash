/**
 * Device Authorization E2E Tests
 *
 * Tests the device authorization page at /device. This is a standalone page
 * (no Shell wrapper) used for OAuth device flow -- the user enters a code
 * shown by `emdash login` in their terminal.
 *
 * The page checks authentication and redirects to login if not authenticated.
 * For these tests we bypass auth first, then navigate directly.
 */

import { test, expect } from "../fixtures";

// Regex patterns
const DEVICE_AUTHORIZE_PATTERN = /\/api\/oauth\/device\/authorize$/;

test.describe("Device Authorization", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Page rendering", () => {
		test("renders the device authorization page with heading", async ({ admin }) => {
			// Navigate directly -- device page is standalone (no Shell)
			await admin.page.goto("/_emdash/admin/device");
			await admin.waitForHydration();

			// Page heading
			await expect(admin.page.locator("h1")).toContainText("Authorize Device", {
				timeout: 15000,
			});

			// Subtitle
			await expect(admin.page.locator("text=Enter the code from your terminal")).toBeVisible();
		});

		test("shows user info badge for authenticated user", async ({ admin }) => {
			await admin.page.goto("/_emdash/admin/device");

			// Wait for the auth check to complete (shows "Checking authentication..." first)
			// then the user badge appears with role info.
			await expect(admin.page.getByText("Dev Admin")).toBeVisible({ timeout: 15000 });
			await expect(admin.page.getByText("Admin", { exact: true })).toBeVisible();
		});
	});

	test.describe("Code input", () => {
		test("shows device code input field", async ({ admin }) => {
			await admin.page.goto("/_emdash/admin/device");
			await admin.waitForHydration();

			// Wait for the input to appear (after auth check completes)
			const codeInput = admin.page.locator("#user-code");
			await expect(codeInput).toBeVisible({ timeout: 15000 });

			// Input should have the expected placeholder
			await expect(codeInput).toHaveAttribute("placeholder", "XXXX-XXXX");
		});

		test("Authorize button is disabled until a valid pending code is entered", async ({
			admin,
		}) => {
			await admin.page.goto("/_emdash/admin/device");
			await admin.waitForHydration();

			const codeInput = admin.page.locator("#user-code");
			await expect(codeInput).toBeVisible({ timeout: 15000 });

			// Both buttons should be disabled with empty input
			const authorizeBtn = admin.page.getByRole("button", { name: "Authorize" });
			const denyBtn = admin.page.getByRole("button", { name: "Deny" });
			await expect(authorizeBtn).toBeDisabled();
			await expect(denyBtn).toBeDisabled();

			// Type a partial code (less than 8 chars) -- still disabled
			await codeInput.fill("ABCD");
			await expect(authorizeBtn).toBeDisabled();

			// A full code that matches no pending request can be denied but not approved
			await codeInput.fill("ZZZZ-9999");
			await expect(
				admin.page.getByText("This code is invalid or has already been used."),
			).toBeVisible({
				timeout: 10000,
			});
			await expect(authorizeBtn).toBeDisabled();
			await expect(denyBtn).toBeEnabled();
		});

		test("auto-formats code with hyphen after 4 characters", async ({ admin }) => {
			await admin.page.goto("/_emdash/admin/device");
			await admin.waitForHydration();

			const codeInput = admin.page.locator("#user-code");
			await expect(codeInput).toBeVisible({ timeout: 15000 });

			// Type 5 characters without hyphen -- should auto-insert
			await codeInput.pressSequentially("ABCDE");

			// Value should be "ABCD-E" (hyphen auto-inserted after 4th char)
			await expect(codeInput).toHaveValue("ABCD-E");
		});
	});

	test.describe("Requested scopes", () => {
		test("lists the requested scopes before approval and approves the code", async ({
			admin,
			serverInfo,
		}) => {
			const res = await fetch(`${serverInfo.baseUrl}/_emdash/api/oauth/device/code`, {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"X-EmDash-Request": "1",
					Origin: serverInfo.baseUrl,
				},
				body: JSON.stringify({ client_id: "emdash-cli", scope: "content:read admin" }),
			});
			expect(res.ok).toBe(true);
			const { data }: any = await res.json();

			await admin.page.goto(`/_emdash/admin/device?code=${data.user_code}`);
			await admin.waitForHydration();

			const granted = admin.page.getByRole("region", {
				name: "This device is requesting permission to use:",
			});
			await expect(granted.getByText("Content Read", { exact: true })).toBeVisible({
				timeout: 15000,
			});
			await expect(granted.getByText("Admin", { exact: true })).toBeVisible();

			const authorizeBtn = admin.page.getByRole("button", { name: "Authorize" });
			await expect(authorizeBtn).toBeEnabled();

			const authResponse = admin.page.waitForResponse(
				(r) => DEVICE_AUTHORIZE_PATTERN.test(r.url()) && r.request().method() === "POST",
				{ timeout: 15000 },
			);
			await authorizeBtn.click();
			await authResponse;

			await expect(admin.page.getByText("Device authorized")).toBeVisible({ timeout: 10000 });
		});
	});

	test.describe("URL pre-population", () => {
		test("pre-populates code from URL query parameter", async ({ admin }) => {
			await admin.page.goto("/_emdash/admin/device?code=TEST-CODE");
			await admin.waitForHydration();

			const codeInput = admin.page.locator("#user-code");
			await expect(codeInput).toBeVisible({ timeout: 15000 });

			// Should be pre-filled from the query param
			await expect(codeInput).toHaveValue("TEST-CODE");
		});
	});
});
