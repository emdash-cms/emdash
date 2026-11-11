/**
 * Signed-in users other than the dev-bypass admin, made through the real invite flow: the admin
 * invites an email with a role, and the invitee registers a passkey on a virtual authenticator.
 * Chromium only, because the authenticator is added over CDP.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type Browser, type BrowserContext, expect } from "@playwright/test";

import { addVirtualWebAuthnAuthenticator } from "./virtual-authenticator";

const SERVER_INFO_PATH = join(tmpdir(), "emdash-pw-server.json");
const URL_IN_TEXT_REGEX = /https?:\/\/[^\s]+/;
const ADMIN_URL_PATTERN = /\/_emdash\/admin\/?$/;

/** Role levels, as `@emdash-cms/auth` defines them. */
export const Role = {
	SUBSCRIBER: 10,
	CONTRIBUTOR: 20,
	AUTHOR: 30,
	EDITOR: 40,
	ADMIN: 50,
} as const;

function getServerInfo(): { baseUrl: string; token: string; sessionCookie: string } {
	return JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8"));
}

/**
 * Creates an invite with the admin's API token and returns the invite URL from the email the dev
 * console provider captured. Runs in Node.js, not the browser, so it reads the same email store
 * the server writes.
 */
export async function createInvite(email: string, role: number = Role.AUTHOR): Promise<string> {
	const { baseUrl, token, sessionCookie } = getServerInfo();

	await fetch(`${baseUrl}/_emdash/api/dev/emails`, {
		method: "DELETE",
		headers: { "X-EmDash-Request": "1", Cookie: sessionCookie },
	});

	// The shared fixture also registers a sandboxed email delivery provider.
	const selectionRes = await fetch(`${baseUrl}/_emdash/api/admin/hooks/exclusive/email:deliver`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ pluginId: "emdash-console-email" }),
	});
	expect(selectionRes.status, await selectionRes.text()).toBe(200);

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
		throw new Error(`Invite creation failed (${createRes.status}): ${await createRes.text()}`);
	}
	const createBody: { data?: { inviteUrl?: string } } = JSON.parse(await createRes.text());
	// Without an email provider, the response carries the URL itself.
	if (createBody.data?.inviteUrl) return createBody.data.inviteUrl;

	const emailsRes = await fetch(`${baseUrl}/_emdash/api/dev/emails`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!emailsRes.ok) {
		throw new Error(`Dev emails endpoint failed (${emailsRes.status}): ${await emailsRes.text()}`);
	}
	const emailsBody: { data?: { items?: Array<{ message: { text: string } }> } } = JSON.parse(
		await emailsRes.text(),
	);
	const latestEmail = emailsBody.data?.items?.[0];
	if (!latestEmail) {
		throw new Error("No emails captured by dev console provider after invite creation");
	}
	const match = latestEmail.message.text.match(URL_IN_TEXT_REGEX);
	if (!match) throw new Error(`No URL found in invite email text: ${latestEmail.message.text}`);
	return match[0];
}

export interface CreateUserOptions {
	role: number;
	name: string;
	/** Defaults to a unique address. */
	email?: string;
}

/**
 * Invites a user, registers their passkey and returns their browser context, signed in, with its
 * one page on the dashboard. The first-login welcome dialog is still open there.
 */
export async function createUser(
	browser: Browser,
	{ role, name, email = `user-${crypto.randomUUID()}@example.com` }: CreateUserOptions,
): Promise<BrowserContext> {
	const inviteUrl = await createInvite(email, role);
	const inviteToken = new URL(inviteUrl).searchParams.get("token")!;

	const context = await browser.newContext({ baseURL: getServerInfo().baseUrl });
	try {
		const page = await context.newPage();
		const removeAuthenticator = await addVirtualWebAuthnAuthenticator(page);
		try {
			await page.goto(`/_emdash/admin/invite/accept?token=${inviteToken}`);
			await expect(page.locator("h1")).toContainText("Accept Invite", { timeout: 15_000 });
			await expect(page.getByLabel("Email")).toHaveValue(email);
			await page.getByLabel("Your name (optional)").fill(name);

			const completion = page.waitForResponse(
				(response) => new URL(response.url()).pathname === "/_emdash/api/auth/invite/complete",
			);
			await page.getByRole("button", { name: "Create passkey" }).click();
			expect((await completion).status()).toBe(200);

			await expect(page.getByRole("heading", { name: "Passkey created" })).toBeVisible();
			await page.getByRole("button", { name: "Open the dashboard" }).click();
			await expect(page).toHaveURL(ADMIN_URL_PATTERN, { timeout: 60_000 });
		} finally {
			await removeAuthenticator();
		}
		return context;
	} catch (error) {
		await context.close();
		throw error;
	}
}
