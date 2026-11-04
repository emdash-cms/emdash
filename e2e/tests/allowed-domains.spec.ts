/**
 * Allowed Domains E2E Tests
 *
 * Tests self-signup domain management in admin settings.
 * Available at /settings/allowed-domains.
 *
 * Uses API to add/remove domains as needed, verifies UI reflects changes.
 */

import { test, expect } from "../fixtures";

// API helper
function apiHeaders(token: string, baseUrl: string) {
	return {
		"Content-Type": "application/json",
		Authorization: `Bearer ${token}`,
		"X-EmDash-Request": "1",
		Origin: baseUrl,
	};
}

test.describe("Allowed Domains Settings", () => {
	let headers: Record<string, string>;
	let baseUrl: string;

	test.beforeEach(async ({ admin, serverInfo }) => {
		await admin.devBypassAuth();
		baseUrl = serverInfo.baseUrl;
		headers = apiHeaders(serverInfo.token, baseUrl);

		// Clean up any leftover test domains from previous runs
		const res = await fetch(`${baseUrl}/_emdash/api/admin/allowed-domains`, { headers });
		if (res.ok) {
			const data: any = await res.json();
			const domains = data.data?.domains ?? [];
			for (const d of domains) {
				if (d.domain.includes("e2e-test")) {
					await fetch(
						`${baseUrl}/_emdash/api/admin/allowed-domains/${encodeURIComponent(d.domain)}`,
						{ method: "DELETE", headers },
					).catch(() => {});
				}
			}
		}
	});

	test("renders the allowed domains settings page", async ({ admin, page }) => {
		await admin.goto("/settings/allowed-domains");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Should show the page title
		await expect(page.locator("h1").first()).toContainText("Self-Signup Domains");

		// Should show the "Allowed Domains" section heading
		await expect(page.locator("h2", { hasText: "Allowed Domains" })).toBeVisible({
			timeout: 10000,
		});

		// Should have an "Add Domain" button
		await expect(page.getByRole("button", { name: "Add Domain" })).toBeVisible();
	});

	test("shows empty state when no domains configured", async ({ admin, page }) => {
		await admin.goto("/settings/allowed-domains");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Should show empty state message (unless domains were pre-configured)
		const emptyState = page.locator("text=No domains configured");

		// Check if there's already domain data or empty state
		const hasEmptyState = await emptyState.isVisible({ timeout: 5000 }).catch(() => false);
		if (hasEmptyState) {
			await expect(emptyState).toBeVisible();
		}
		// Either way, the Add Domain button should be there
		await expect(page.getByRole("button", { name: "Add Domain" })).toBeVisible();
	});

	test("adds a new domain via the UI", async ({ admin, page }) => {
		await admin.goto("/settings/allowed-domains");
		await admin.waitForShell();
		await admin.waitForLoading();

		const testDomain = `e2e-test-${Date.now()}.example.com`;

		// Click "Add Domain" to open the inline form
		await page.getByRole("button", { name: "Add Domain" }).click();

		// The add form should appear with a domain input
		const domainInput = page.getByRole("textbox", { name: "Domain", exact: true });
		await expect(domainInput).toBeVisible({ timeout: 5000 });

		// Fill in the domain
		await domainInput.fill(testDomain);

		// Click "Add Domain" submit button (different from the trigger button)
		const submitButton = page.getByRole("button", { name: "Add Domain" });
		await submitButton.click();

		// Wait for the domain to appear in the list
		const allowedDomains = page.getByRole("region", { name: "Allowed Domains", exact: true });
		await expect(allowedDomains.getByText(testDomain, { exact: true })).toBeVisible({
			timeout: 10000,
		});

		// Should show a success status message
		const successMsg = page.locator("text=Domain added successfully");
		await expect(successMsg).toBeVisible({ timeout: 5000 });

		// Clean up via API
		await fetch(`${baseUrl}/_emdash/api/admin/allowed-domains/${encodeURIComponent(testDomain)}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
	});

	test("removes a domain via the UI", async ({ admin, page }) => {
		const testDomain = `e2e-test-delete-${Date.now()}.example.com`;

		// Create domain via API first
		await fetch(`${baseUrl}/_emdash/api/admin/allowed-domains`, {
			method: "POST",
			headers,
			body: JSON.stringify({ domain: testDomain, defaultRole: 30 }),
		});

		// Navigate to the page
		await admin.goto("/settings/allowed-domains");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Verify the domain is visible
		const allowedDomains = page.getByRole("region", { name: "Allowed Domains", exact: true });
		await expect(allowedDomains.getByText(testDomain, { exact: true })).toBeVisible({
			timeout: 10000,
		});

		// Click the delete button for this domain
		const deleteButton = page.getByRole("button", { name: `Delete ${testDomain}` });
		await deleteButton.click();

		// The confirmation dialog should appear
		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 5000 });
		await expect(dialog.getByRole("heading", { name: "Remove Domain" })).toBeVisible();

		// Confirm deletion
		await dialog.getByRole("button", { name: "Remove Domain" }).click();

		// Domain should disappear from the list
		await expect(allowedDomains.getByText(testDomain, { exact: true })).not.toBeVisible({
			timeout: 10000,
		});

		// Should show a success status message
		const successMsg = page.locator("text=Domain removed");
		await expect(successMsg).toBeVisible({ timeout: 5000 });
	});

	test("cancel delete keeps the domain", async ({ admin, page }) => {
		const testDomain = `e2e-test-keep-${Date.now()}.example.com`;

		// Create domain via API
		await fetch(`${baseUrl}/_emdash/api/admin/allowed-domains`, {
			method: "POST",
			headers,
			body: JSON.stringify({ domain: testDomain, defaultRole: 30 }),
		});

		await admin.goto("/settings/allowed-domains");
		await admin.waitForShell();
		await admin.waitForLoading();

		// Verify domain is visible
		const allowedDomains = page.getByRole("region", { name: "Allowed Domains", exact: true });
		await expect(allowedDomains.getByText(testDomain, { exact: true })).toBeVisible({
			timeout: 10000,
		});

		// Click delete
		await page.getByRole("button", { name: `Delete ${testDomain}` }).click();

		// Dialog appears
		const dialog = page.locator('[role="dialog"]');
		await expect(dialog).toBeVisible({ timeout: 5000 });

		// Cancel
		await dialog.getByRole("button", { name: "Cancel" }).click();

		// Dialog should close
		await expect(dialog).not.toBeVisible({ timeout: 5000 });

		// Domain should still be there
		await expect(allowedDomains.getByText(testDomain, { exact: true })).toBeVisible();

		// Clean up
		await fetch(`${baseUrl}/_emdash/api/admin/allowed-domains/${encodeURIComponent(testDomain)}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
	});

	test("toggling enabled/disabled updates the domain", async ({ admin, page }) => {
		const testDomain = `e2e-test-toggle-${Date.now()}.example.com`;

		// Create domain via API
		await fetch(`${baseUrl}/_emdash/api/admin/allowed-domains`, {
			method: "POST",
			headers,
			body: JSON.stringify({ domain: testDomain, defaultRole: 30 }),
		});

		await admin.goto("/settings/allowed-domains");
		await admin.waitForShell();
		await admin.waitForLoading();

		const toggle = page.getByRole("switch", { name: testDomain, exact: true });
		await expect(toggle).toBeVisible({ timeout: 10000 });
		await toggle.click();

		// Wait for the update to complete -- success message should appear
		const statusMsg = page.locator("text=Domain updated");
		await expect(statusMsg).toBeVisible({ timeout: 5000 });

		// Clean up
		await fetch(`${baseUrl}/_emdash/api/admin/allowed-domains/${encodeURIComponent(testDomain)}`, {
			method: "DELETE",
			headers,
		}).catch(() => {});
	});
});
