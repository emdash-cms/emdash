/**
 * Invite Flow E2E Tests
 *
 * Tests the full user invitation lifecycle:
 * - Invite accept page error states (missing token, invalid token)
 * - Admin creating an invite via API
 * - Full invite → passkey registration → user creation flow
 *   using a CDP virtual WebAuthn authenticator
 *
 * The invite accept page (/_emdash/admin/invite/accept) is a public
 * route — auth middleware allows unauthenticated access.
 *
 * These tests select the dev console email provider to capture invite
 * messages in memory rather than returning the invite URL directly.
 * We retrieve the URL from the dev emails endpoint using server-side
 * fetch with the PAT.
 */

import { AdminPage, expect, test } from "../fixtures";
import { createInvite, createUser, Role } from "../fixtures/users";

// Regex patterns
const ADMIN_URL_PATTERN = /\/_emdash\/admin\/?$/;
const INVITE_URL_REGEX = /https?:\/\/[^\s]+\/admin\/invite\/accept\?token=[^\s]+/;
const PASSKEY_ACTION_REGEX = /^(Create passkey|Use another device|Use a security key)$/;

test.describe("Invite Accept Page", () => {
	test.describe("Error states", () => {
		test("shows error when no token is provided", async ({ admin }) => {
			await admin.page.goto("/_emdash/admin/invite/accept");
			await admin.waitForHydration();

			await expect(admin.page.locator("h1")).toContainText("Invite Error", { timeout: 15000 });
			await expect(admin.page.locator("text=No invite token provided")).toBeVisible();
			await expect(admin.page.locator("text=Back to login")).toBeVisible();
		});

		test("shows error for invalid token", async ({ admin }) => {
			await admin.page.goto("/_emdash/admin/invite/accept?token=bogus-token-12345");
			await admin.waitForHydration();

			await expect(admin.page.locator("h1")).toContainText("Invite Error", { timeout: 15000 });

			// The error step renders an h2 with an error title and a
			// "Back to login" link regardless of the specific error code.
			await expect(admin.page.locator("h2")).toBeVisible({ timeout: 15000 });
			await expect(admin.page.locator("text=Back to login")).toBeVisible();
		});
	});

	test.describe("Valid invite token", () => {
		test("shows registration form with email and role", async ({ admin }) => {
			const inviteUrl = await createInvite("invite-ui@example.com", Role.AUTHOR);
			const token = new URL(inviteUrl).searchParams.get("token")!;

			await admin.page.goto(`/_emdash/admin/invite/accept?token=${token}`);
			await admin.waitForHydration();

			await expect(admin.page.locator("h1")).toContainText("Accept Invite", { timeout: 15000 });
			await expect(admin.page.locator("text=You've been invited!")).toBeVisible();
			await expect(admin.page.getByLabel("Email")).toHaveValue("invite-ui@example.com");
			await expect(admin.page.locator("text=AUTHOR")).toBeVisible();
			await expect(
				admin.page.getByRole("heading", {
					name: "With a passkey, you don’t need to remember complex passwords",
				}),
			).toBeVisible();
			await expect(
				admin.page.getByRole("button", { name: PASSKEY_ACTION_REGEX }).first(),
			).toBeVisible();
		});
	});
});

test.describe("Invite creation via API", () => {
	test("admin can create an invite and get invite URL", async () => {
		const inviteUrl = await createInvite("api-test@example.com", Role.CONTRIBUTOR);

		expect(inviteUrl).toMatch(INVITE_URL_REGEX);

		const parsed = new URL(inviteUrl);
		expect(parsed.searchParams.get("token")).toBeTruthy();
	});

	test("invite URL contains the admin invite accept path", async () => {
		const inviteUrl = await createInvite("prefix-test@example.com");

		expect(inviteUrl).toContain("/admin/invite/accept");
	});

	test("creating invite for existing user returns error", async ({ serverInfo }) => {
		const { baseUrl, token } = serverInfo;

		const res = await fetch(`${baseUrl}/_emdash/api/auth/invite`, {
			method: "POST",
			headers: {
				"Content-Type": "application/json",
				"X-EmDash-Request": "1",
				Authorization: `Bearer ${token}`,
			},
			body: JSON.stringify({ email: "dev@emdash.local", role: 30 }),
		});

		expect(res.status).toBe(409);
	});
});

test.describe("Full invite flow with passkey registration", () => {
	test("completes invite registration with virtual authenticator", async ({ browser }) => {
		test.setTimeout(120_000);

		const context = await createUser(browser, { role: Role.AUTHOR, name: "Invited User" });
		try {
			const page = context.pages()[0]!;
			const admin = new AdminPage(page);

			await expect(page).toHaveURL(ADMIN_URL_PATTERN);
			const welcomeDialog = page.getByRole("dialog", { name: /Welcome to EmDash/ });
			await expect(welcomeDialog).toBeVisible({ timeout: 15_000 });
			await welcomeDialog.getByRole("button", { name: "Get Started" }).click();
			await expect(welcomeDialog).not.toBeVisible();
			await admin.waitForShell();
			await expect(page.getByRole("button", { name: /Invited User/ })).toBeVisible();

			// Verify no passkey errors appeared
			await expect(page.locator("text=Registration was cancelled or timed out")).toHaveCount(0);
			await expect(page.locator("text=Invalid origin")).toHaveCount(0);
		} finally {
			await context.close();
		}
	});
});
