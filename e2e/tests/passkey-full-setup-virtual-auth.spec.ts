/**
 * End-to-end passkey registration with a CDP virtual authenticator (no human).
 * Runs against the default fixture URL (http://localhost:4444).
 *
 * If this fails, the passkey stack (options → create → verify) is broken on localhost.
 */

import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "../fixtures";
import { addVirtualWebAuthnAuthenticator } from "../fixtures/virtual-authenticator";

const ADMIN_AFTER_SETUP_URL = /\/_emdash\/admin(\/login)?/;

const SERVER_INFO_PATH = join(tmpdir(), "emdash-pw-server.json");

function fixtureBaseUrl(): string {
	return JSON.parse(readFileSync(SERVER_INFO_PATH, "utf-8")).baseUrl as string;
}

async function resetSetup(): Promise<void> {
	const base = fixtureBaseUrl();
	const res = await fetch(`${base}/_emdash/api/setup/dev-reset`, {
		method: "POST",
		headers: { "X-EmDash-Request": "1", Origin: base },
	});
	if (!res.ok) throw new Error(`dev-reset failed: ${res.status}`);
}

async function restoreFixtureSetup(): Promise<void> {
	const base = fixtureBaseUrl();
	const res = await fetch(`${base}/_emdash/api/setup/dev-bypass?token=1`);
	if (!res.ok) throw new Error(`dev-bypass restore failed: ${res.status}`);
}

test.describe("Setup wizard passkey with virtual authenticator (localhost)", () => {
	test.describe.configure({ mode: "serial" });

	test.beforeEach(async () => {
		await resetSetup();
	});

	test.afterAll(async () => {
		await restoreFixtureSetup();
	});

	test("completes full setup including passkey registration", async ({ admin, page }) => {
		test.setTimeout(120_000);
		const removeAuth = await addVirtualWebAuthnAuthenticator(page);

		try {
			await admin.goToSetup();

			await page.getByLabel("Site Title").fill("Virtual Auth Site");
			await page.getByRole("button", { name: "Continue" }).click();
			await expect(page.locator("text=Create your account")).toBeVisible();

			await page.getByLabel("Your Email").fill("virtual-auth@example.com");
			await page.getByLabel("Your Name").fill("Virtual Auth User");
			await page.getByRole("button", { name: "Continue" }).click();

			await expect(page.locator("text=Set up your passkey")).toBeVisible();
			await page.getByRole("button", { name: "Create Passkey" }).click();

			// admin-verify creates the user but does not set a session; wizard sends user to /_emdash/admin and auth redirects to login.
			await expect(page).toHaveURL(ADMIN_AFTER_SETUP_URL, { timeout: 60_000 });
			await expect(page.locator("text=Set up your passkey")).toHaveCount(0);
			await expect(page.locator("text=Registration was cancelled or timed out")).toHaveCount(0);
			await expect(page.locator("text=Invalid origin")).toHaveCount(0);
		} finally {
			await removeAuth();
		}
	});
});
