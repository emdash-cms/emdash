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
 * In dev mode the built-in console email provider auto-activates,
 * so invite creation sends an email (captured in memory) rather than
 * returning the invite URL directly. We retrieve the URL from the
 * dev emails endpoint using server-side fetch with the PAT.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "../fixtures";
import { addVirtualWebAuthnAuthenticator } from "../fixtures/virtual-authenticator";

// Regex patterns
const ADMIN_URL_PATTERN = /\/_emdash\/admin/;
const INVITE_URL_REGEX = /https?:\/\/[^\s]+\/admin\/invite\/accept\?token=[^\s]+/;
const URL_IN_TEXT_REGEX = /https?:\/\/[^\s]+/;

const SERVER_INFO_PATH = join(tmpdir(), "emdash-pw-server.json");

function getServerInfo(): { baseUrl: string; token: string; sessionCookie: string } {
	return JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8"));
}

/**
 * Create an invite via the API using the PAT from serverInfo.
 * Uses Node.js fetch (not browser) to avoid module isolation issues
 * with the dev email store.
 *
 * When the dev console email provider is active, the invite email is
 * captured in memory. We retrieve it via GET /_emdash/api/dev/emails.
 */
async function createInviteViaApi(email: string, role = 30): Promise<string> {
	const { baseUrl, token, sessionCookie } = getServerInfo();

	// Clear previously captured emails
	await fetch(`${baseUrl}/_emdash/api/dev/emails`, {
		method: "DELETE",
		headers: {
			"X-EmDash-Request": "1",
			Cookie: sessionCookie,
		},
	});

	// Create the invite
	const createRes = await fetch(`${baseUrl}/_emdash/api/auth/invite`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ email, role }),
	});

	if (!createRes.ok) {
		const body = await createRes.text();
		throw new Error(`Invite creation failed (${createRes.status}): ${body}`);
	}

	const createBody = (await createRes.json()) as {
		data?: { inviteUrl?: string };
	};

	// If no email provider, the response includes the URL directly
	if (createBody.data?.inviteUrl) {
		return createBody.data.inviteUrl;
	}

	// Otherwise, retrieve the invite URL from captured dev emails
	const emailsRes = await fetch(`${baseUrl}/_emdash/api/dev/emails`, {
		headers: {
			Authorization: `Bearer ${token}`,
		},
	});

	if (!emailsRes.ok) {
		throw new Error(`Dev emails endpoint failed (${emailsRes.status}): ${await emailsRes.text()}`);
	}

	const emailsBody = (await emailsRes.json()) as {
		data?: { items?: Array<{ message: { text: string } }> };
	};

	const emails = emailsBody.data?.items;
	if (!emails?.length) {
		throw new Error("No emails captured by dev console provider after invite creation");
	}

	const latestEmail = emails[0]!;
	const match = latestEmail.message.text.match(URL_IN_TEXT_REGEX);
	if (!match) {
		throw new Error(`No URL found in invite email text: ${latestEmail.message.text}`);
	}

	return match[0];
}

test.describe("Invite Accept Page", () => {
	test.describe("Error states", () => {
		test("shows error when no token is provided", async ({ admin }) => {
			await admin.page.goto("/_emdash/admin/invite/accept");
			await admin.waitForHydration();

			await expect(admin.page.locator("h1")).toContainText("Invite Error", { timeout: 15000 });
			await expect(admin.page.locator("text=No invite token provided")).toBeVisible();
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

		test("shows back to login link on error", async ({ admin }) => {
			await admin.page.goto("/_emdash/admin/invite/accept");
			await admin.waitForHydration();

			await expect(admin.page.locator("h1")).toContainText("Invite Error", { timeout: 15000 });
			await expect(admin.page.locator("text=Back to login")).toBeVisible();
		});
	});

	test.describe("Valid invite token", () => {
		test("shows registration form with email and role", async ({ admin }) => {
			const inviteUrl = await createInviteViaApi("invite-ui@example.com", 30);
			const token = new URL(inviteUrl).searchParams.get("token")!;

			await admin.page.goto(`/_emdash/admin/invite/accept?token=${token}`);
			await admin.waitForHydration();

			await expect(admin.page.locator("h1")).toContainText("Accept Invite", { timeout: 15000 });
			await expect(admin.page.locator("text=You've been invited!")).toBeVisible();
			await expect(admin.page.getByLabel("Email")).toHaveValue("invite-ui@example.com");
			await expect(admin.page.locator("text=AUTHOR")).toBeVisible();
			await expect(admin.page.locator("text=Create your passkey")).toBeVisible();
			await expect(admin.page.getByRole("button", { name: "Create Account" })).toBeVisible();
		});
	});
});

test.describe("Invite creation via API", () => {
	test("admin can create an invite and get invite URL", async () => {
		const inviteUrl = await createInviteViaApi("api-test@example.com", 20);

		expect(inviteUrl).toMatch(INVITE_URL_REGEX);

		const parsed = new URL(inviteUrl);
		expect(parsed.searchParams.get("token")).toBeTruthy();
	});

	test("invite URL contains the admin invite accept path", async () => {
		const inviteUrl = await createInviteViaApi("prefix-test@example.com");

		expect(inviteUrl).toContain("/admin/invite/accept");
	});

	test("creating invite for existing user returns error", async () => {
		const { baseUrl, token } = getServerInfo();

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
	test.describe.configure({ mode: "serial" });

	test("completes invite registration with virtual authenticator", async ({ admin, page }) => {
		test.setTimeout(120_000);

		// Step 1: Create invite via server-side API
		const inviteUrl = await createInviteViaApi("invited-user@example.com", 30);
		const inviteToken = new URL(inviteUrl).searchParams.get("token")!;

		// Step 2: Set up virtual authenticator
		const removeAuth = await addVirtualWebAuthnAuthenticator(page);

		try {
			// Step 3: Navigate to invite accept page
			await page.goto(`/_emdash/admin/invite/accept?token=${inviteToken}`);
			await admin.waitForHydration();

			// Step 4: Verify the registration form renders
			await expect(page.locator("h1")).toContainText("Accept Invite", { timeout: 15000 });
			await expect(page.locator("text=You've been invited!")).toBeVisible();
			await expect(page.getByLabel("Email")).toHaveValue("invited-user@example.com");
			await expect(page.locator("text=AUTHOR")).toBeVisible();

			// Step 5: Fill in name and click Create Account
			const nameInput = page.getByLabel("Your name (optional)");
			await nameInput.fill("Invited User");

			await page.getByRole("button", { name: "Create Account" }).click();

			// Step 6: Wait for passkey flow to complete and redirect
			await expect(page).toHaveURL(ADMIN_URL_PATTERN, { timeout: 60_000 });

			// Verify no passkey errors appeared
			await expect(page.locator("text=Registration was cancelled or timed out")).toHaveCount(0);
			await expect(page.locator("text=Invalid origin")).toHaveCount(0);
		} finally {
			await removeAuth();
		}
	});

	test("invited user appears in the users list", async ({ admin, page }) => {
		await admin.devBypassAuth();
		await admin.goto("/users");
		await admin.waitForShell();
		await admin.waitForLoading();

		await expect(page.locator("text=invited-user@example.com")).toBeVisible({
			timeout: 15000,
		});
	});
});
