import { test, expect } from "../fixtures";

test("updates the browser title as the admin page and site title change", async ({
	admin,
	page,
}) => {
	await admin.devBypassAuth();

	const settingsResponse = await page.request.get("/_emdash/api/settings");
	expect(settingsResponse.ok()).toBeTruthy();
	const originalSettings = (await settingsResponse.json()) as { data: { title?: string } };
	const originalTitle = originalSettings.data.title ?? "";

	try {
		await admin.goto("/settings/general");
		await admin.waitForShell();
		await admin.waitForLoading();

		await page.getByLabel("Site Title").fill("Title Test Site");
		await page.getByRole("button", { name: "Save", exact: true }).first().click();
		await expect(page).toHaveTitle("General Settings · Title Test Site");

		await page
			.getByRole("complementary", { name: "Admin navigation" })
			.getByRole("link", { name: "Posts", exact: true })
			.click();
		await expect(page).toHaveTitle("Posts · Title Test Site");

		await page.getByRole("link", { name: "First Post", exact: true }).click();
		await expect(page).toHaveTitle("Edit Post: First Post · Title Test Site");

		await page
			.getByRole("complementary", { name: "Admin navigation" })
			.getByRole("link", { name: "Posts", exact: true })
			.click();
		await expect(page).toHaveTitle("Posts · Title Test Site");

		await admin.goto("/settings/general");
		await admin.waitForShell();
		await admin.waitForLoading();
		await page.getByLabel("Site Title").fill("");
		await page.getByRole("button", { name: "Save", exact: true }).first().click();
		await expect(page).toHaveTitle("General Settings · EmDash");
	} finally {
		await page.request.post("/_emdash/api/settings", {
			headers: { "X-EmDash-Request": "1" },
			data: { title: originalTitle },
		});
	}
});

test("labels standalone login tabs without fetching private site settings", async ({ page }) => {
	await page.goto("/_emdash/admin/login");
	await expect(page).toHaveTitle("Log in · EmDash");
});
