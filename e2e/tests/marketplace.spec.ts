import { expect, test } from "../fixtures";

test.describe("Registry cutover", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("shows registry as the only plugin discovery path", async ({ admin, page }) => {
		await admin.goto("/");
		await admin.waitForShell();

		await expect(page.getByRole("link", { name: "Registry" })).toHaveAttribute(
			"href",
			"/_emdash/admin/plugins/registry",
		);
		await expect(page.getByRole("link", { name: "Marketplace", exact: true })).toHaveCount(0);
		await expect(page.getByRole("link", { name: "Themes", exact: true })).toHaveCount(0);
	});

	test("does not expose the legacy marketplace browse route", async ({ admin, page }) => {
		await admin.goto("/plugins/marketplace");
		await admin.waitForShell();

		await expect(page.getByRole("heading", { name: "Page Not Found" })).toBeVisible();
		await expect(page.getByText("Marketplace browsing is no longer available.")).toBeVisible();
	});

	test("shows marketplace migration guidance only on the admin dashboard", async ({
		admin,
		page,
	}) => {
		await admin.goto("/");
		await admin.waitForShell();

		await expect(page.getByText("Marketplace configuration is deprecated")).toBeVisible();
		await expect(page.getByRole("link", { name: "Migration guide" })).toHaveAttribute(
			"href",
			"https://docs.emdashcms.com/plugins/migrate-from-marketplace/",
		);

		await admin.goto("/plugins/registry");
		await expect(page.getByText("Marketplace configuration is deprecated")).toHaveCount(0);
	});

	test("does not expose legacy marketplace plugin details", async ({ admin, page }) => {
		await admin.goto("/plugins/marketplace/seo-toolkit");
		await admin.waitForShell();

		await expect(page.getByRole("heading", { name: "Page Not Found" })).toBeVisible();
		await expect(
			page.getByText(
				"Marketplace browsing is no longer available. Manage installed plugins from Plugins.",
			),
		).toBeVisible();
	});
});
