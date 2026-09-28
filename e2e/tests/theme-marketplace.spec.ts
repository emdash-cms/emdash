import { expect, test } from "../fixtures";

test.describe("Legacy theme marketplace routes", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	for (const path of ["/themes/marketplace", "/themes/marketplace/minimal-blog"]) {
		test(`hides ${path}`, async ({ admin, page }) => {
			await admin.goto(path);
			await admin.waitForShell();

			await expect(page.getByRole("heading", { name: "Page Not Found" })).toBeVisible();
			await expect(page.getByText("Marketplace browsing is no longer available.")).toBeVisible();
		});
	}
});
