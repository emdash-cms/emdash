/**
 * Authentication E2E Tests
 *
 * Tests for authentication features:
 * - Login page UI
 * - Dev bypass authentication
 * - Session persistence
 * - Logout
 * - Protected routes redirect to login
 * - User management (admin only)
 * - Security settings (passkey management)
 *
 * Runs against an isolated fixture with seeded data.
 */

import { test, expect } from "../fixtures";

// Regex patterns
const LOGIN_URL_PATTERN = /\/login/;
const ADMIN_URL_PATTERN = /\/_emdash\/admin\/?$/;
const USERS_URL_PATTERN = /\/users/;
const SECURITY_SETTINGS_URL_PATTERN = /\/settings\/security/;
const LOGIN_OR_ADMIN_URL_PATTERN = /\/(login|admin)/;
const SECURITY_MENUITEM_REGEX = /Security/i;
const ADD_PASSKEY_REGEX = /Add Passkey/i;
const SIGN_HEADING_REGEX = /sign/i;

test.describe("Authentication", () => {
	test.describe("Login Page", () => {
		test("displays login page with passkey button", async ({ admin }) => {
			await admin.goto("/login");

			// Should show login page
			await expect(admin.page.locator("h1")).toContainText("Sign in");

			// Should have passkey login button
			await expect(admin.page.locator('button:has-text("Sign in with Passkey")')).toBeVisible();
		});

		test("signup link is hidden when no allowed domains", async ({ admin }) => {
			await admin.goto("/login");

			// No allowed domains are seeded, so signup should not be visible
			await expect(admin.page.locator('a:has-text("Sign up")')).not.toBeVisible();
		});

		test("admin shell is not storable by shared caches", async ({ request }) => {
			// Regression: the admin shell had no Cache-Control header, so shared
			// caches applying RFC 9111 heuristic freshness (e.g. Cloudflare's
			// Workers Cache) could store an authenticated 200 and replay it to
			// anonymous visitors instead of the login redirect.
			const res = await request.get("/_emdash/admin/login");
			expect(res.status()).toBe(200);
			expect(res.headers()["cache-control"]).toBe("private, no-store");
		});
	});

	test.describe("Protected Routes", () => {
		test("unauthenticated access redirects to login", async ({ admin }) => {
			// Clear cookies to ensure no session
			await admin.page.context().clearCookies();

			// Try to access dashboard without auth
			await admin.goto("/");

			// Should redirect to login (setup is already done via global-setup)
			await expect(admin.page).toHaveURL(LOGIN_URL_PATTERN);
		});
	});

	test.describe("Dev Bypass Authentication", () => {
		test("dev bypass creates session and allows access", async ({ admin }) => {
			// Use dev bypass to authenticate
			await admin.devBypassAuth();

			// Now navigate to admin
			await admin.goto("/");

			// Should see dashboard shell (sidebar with navigation)
			await admin.waitForShell();

			// Should be on admin URL (not redirected to login)
			await expect(admin.page).toHaveURL(ADMIN_URL_PATTERN);
		});

		test("session persists across page loads", async ({ admin }) => {
			await admin.devBypassAuth();
			await admin.goto("/");
			await admin.waitForShell();

			// Navigate to another page via sidebar link
			await admin.page.click('a:has-text("Users")');
			await admin.waitForShell();

			// Should still be authenticated and see users page
			await expect(admin.page).toHaveURL(USERS_URL_PATTERN);
			await admin.expectPageTitle("Users");
		});
	});

	test.describe("Logout", () => {
		test("logout clears session and redirects to login", async ({ admin }) => {
			// Authenticate first
			await admin.devBypassAuth();
			await admin.goto("/");
			await admin.waitForShell();

			// Call logout via API (POST with required headers)
			await admin.page.evaluate(async () => {
				await fetch("/_emdash/api/auth/logout", {
					method: "POST",
					headers: { "X-EmDash-Request": "1" },
				});
			});

			// Try to access admin again
			await admin.page.goto("/_emdash/admin/");
			await admin.page.waitForURL(LOGIN_OR_ADMIN_URL_PATTERN, { timeout: 10000 });

			// Should redirect to login
			await expect(admin.page).toHaveURL(LOGIN_URL_PATTERN);
		});
	});

	test.describe("User Menu", () => {
		test("shows user menu in header", async ({ admin }) => {
			await admin.devBypassAuth();
			await admin.goto("/");
			await admin.waitForShell();

			// Click the user menu trigger (shows "Dev Admin" text)
			await admin.page.getByText("Dev Admin").click();

			// Should show menu options
			await expect(admin.page.locator("text=Log out")).toBeVisible();
			await expect(admin.page.locator("text=Security Settings")).toBeVisible();
			await expect(admin.page.locator("text=Settings").last()).toBeVisible();
		});

		test("security settings link navigates correctly", async ({ admin }) => {
			await admin.devBypassAuth();
			await admin.goto("/");
			await admin.waitForShell();

			// Open user menu
			await admin.page.getByText("Dev Admin").click();

			// Click security settings (if present in menu)
			const securityLink = admin.page.getByRole("menuitem", { name: SECURITY_MENUITEM_REGEX });
			if (await securityLink.isVisible({ timeout: 2000 }).catch(() => false)) {
				await securityLink.click();
				await expect(admin.page).toHaveURL(SECURITY_SETTINGS_URL_PATTERN);
			}
		});
	});
});

test.describe("User Management", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("users page shows user list", async ({ admin }) => {
		await admin.goto("/users");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Should show users page
		await admin.expectPageTitle("Users");

		// Should show at least the dev user
		await expect(admin.page.locator("text=dev@emdash.local")).toBeVisible();
	});

	test("shows invite user button", async ({ admin }) => {
		await admin.goto("/users");
		await admin.waitForShell();

		// Should have invite button
		await expect(admin.page.locator('button:has-text("Invite User")')).toBeVisible();
	});

	test("invite user modal opens and closes", async ({ admin }) => {
		await admin.goto("/users");
		await admin.waitForShell();

		// Click invite button
		await admin.page.locator('button:has-text("Invite User")').click();

		// Should show modal
		await expect(admin.page.locator('input[type="email"]')).toBeVisible();
		await expect(admin.page.locator('button:has-text("Send Invite")')).toBeVisible();

		// Close modal
		await admin.page.keyboard.press("Escape");

		// Modal should close
		await expect(admin.page.locator('[role="dialog"]')).not.toBeVisible();
	});

	test("can click user to see details", async ({ admin }) => {
		await admin.goto("/users");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Click on user email link
		await admin.page.locator("text=dev@emdash.local").first().click();

		// Should show detail panel with user info
		await expect(admin.page.locator("text=Dev Admin").first()).toBeVisible();
	});
});

test.describe("Security Settings", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("shows security settings page", async ({ admin }) => {
		await admin.goto("/settings/security");
		await admin.waitForShell();
		await admin.waitForLoading();

		await expect(admin.page.locator("text=Passkeys").first()).toBeVisible();
	});

	test("shows add passkey button", async ({ admin }) => {
		await admin.goto("/settings/security");
		await admin.waitForShell();
		await admin.waitForLoading();

		await expect(admin.page.getByRole("button", { name: ADD_PASSKEY_REGEX })).toBeVisible();
	});
});

test.describe("Signup Page", () => {
	test("displays signup page", async ({ admin }) => {
		// Navigate directly (not through admin which has auth)
		await admin.page.goto("/_emdash/admin/signup");

		// Wait for the React app to hydrate and render a heading with sign-related content.
		// The SPA may render the login page if signup is disabled, so accept either.
		await expect(
			admin.page.getByRole("heading", { level: 1, name: SIGN_HEADING_REGEX }),
		).toBeVisible({
			timeout: 15000,
		});
	});
});
