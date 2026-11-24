/**
 * Self-signup regression coverage for sites whose initial setup is complete.
 */

import { expect, test } from "../fixtures";
import { addVirtualWebAuthnAuthenticator } from "../fixtures/virtual-authenticator";

const URL_IN_TEXT_REGEX = /https?:\/\/[^\s]+/;

interface CapturedEmail {
	message: { text: string };
}

async function selectConsoleEmailProvider(baseUrl: string, token: string): Promise<void> {
	const response = await fetch(`${baseUrl}/_emdash/api/admin/hooks/exclusive/email:deliver`, {
		method: "PUT",
		headers: {
			"Content-Type": "application/json",
			"X-EmDash-Request": "1",
			Authorization: `Bearer ${token}`,
		},
		body: JSON.stringify({ pluginId: "emdash-console-email" }),
	});
	expect(response.status, await response.text()).toBe(200);
}

async function getSignupUrl(baseUrl: string, token: string): Promise<string> {
	const response = await fetch(`${baseUrl}/_emdash/api/dev/emails`, {
		headers: { Authorization: `Bearer ${token}` },
	});
	if (!response.ok)
		throw new Error(`Dev emails request failed (${response.status}): ${await response.text()}`);
	const body = (await response.json()) as { data?: { items?: CapturedEmail[] } };
	const email = body.data?.items?.[0];
	if (!email) throw new Error("No signup email was captured");
	const match = email.message.text.match(URL_IN_TEXT_REGEX);
	if (!match) throw new Error(`No URL found in signup email: ${email.message.text}`);
	return match[0];
}

test("completes self-signup for an allowed email domain", async ({ browser, serverInfo }) => {
	test.setTimeout(120_000);

	const { baseUrl, token } = serverInfo;
	const domain = `e2e-signup-${Date.now()}.example.com`;
	const email = `someone@${domain}`;
	const headers = {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};

	try {
		await selectConsoleEmailProvider(baseUrl, token);
		await fetch(`${baseUrl}/_emdash/api/dev/emails`, {
			method: "DELETE",
			headers: { "X-EmDash-Request": "1", Cookie: serverInfo.sessionCookie },
		});

		const domainResponse = await fetch(`${baseUrl}/_emdash/api/admin/allowed-domains`, {
			method: "POST",
			headers,
			body: JSON.stringify({ domain, defaultRole: 10 }),
		});
		expect(domainResponse.status, await domainResponse.text()).toBe(201);

		const context = await browser.newContext({ baseURL: baseUrl });
		try {
			const page = await context.newPage();
			const removeAuthenticator = await addVirtualWebAuthnAuthenticator(page);
			try {
				await page.goto("/_emdash/admin/signup");
				await page.getByLabel("Email address").fill(email);
				await page.getByRole("button", { name: "Continue" }).click();
				await expect(
					page.getByRole("heading", { level: 2, name: "Check your email" }),
				).toBeVisible();

				const signupUrl = await getSignupUrl(baseUrl, token);
				await page.goto(signupUrl);
				await expect(page.getByRole("heading", { name: "Email verified!" })).toBeVisible({
					timeout: 15_000,
				});
				await expect(page.getByText("You'll be signing up as SUBSCRIBER")).toBeVisible();
				await page.getByLabel("Your name (optional)").fill("Signup User");

				const options = page.waitForResponse((response) => {
					const pathname = new URL(response.url()).pathname;
					return (
						pathname === "/_emdash/api/setup/admin" ||
						pathname === "/_emdash/api/auth/signup/register-options"
					);
				});
				const completion = page.waitForResponse(
					(response) => new URL(response.url()).pathname === "/_emdash/api/auth/signup/complete",
				);
				await page.getByRole("button", { name: "Create passkey" }).click();
				expect((await options).status()).toBe(200);
				expect((await completion).status()).toBe(200);
				await expect(page.getByRole("heading", { name: "Passkey created" })).toBeVisible();
				await page.getByRole("button", { name: "Open the dashboard" }).click();

				await expect(page).toHaveURL(/\/_emdash\/admin\/?$/, { timeout: 60_000 });
				const session = await page.request.get("/_emdash/api/auth/me");
				expect(session.status()).toBe(200);
				const sessionBody = (await session.json()) as { data?: { email?: string } };
				expect(sessionBody.data?.email).toBe(email);
			} finally {
				await removeAuthenticator();
			}
		} finally {
			await context.close();
		}
	} finally {
		await fetch(`${baseUrl}/_emdash/api/admin/allowed-domains/${encodeURIComponent(domain)}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
	}
});
