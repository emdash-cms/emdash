import { expect, test } from "../fixtures";

test.describe("Registry fixture Block Kit", () => {
	test.skip(
		process.env.EMDASH_E2E_TARGET === "cloudflare",
		"The Node fixture owns the configured registry sandbox journey",
	);

	test.beforeEach(async ({ admin, page }) => {
		await admin.devBypassAuth();
		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/" }]);
	});

	test("renders diagnostics and every runtime Block Kit component in Arabic RTL", async ({
		admin,
		page,
	}, testInfo) => {
		await admin.goto("/plugins/marketplace-test/overview");
		await admin.waitForLoading();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await expect(page.getByRole("heading", { name: "Registry diagnostics" })).toBeVisible();
		await expect(page.getByText("Surface")).toBeVisible();
		await expect(page.getByText("admin-page", { exact: true })).toBeVisible();
		await expect(page.getByRole("link", { name: "Documentation" })).toHaveAttribute(
			"href",
			"https://docs.example.test/plugin",
		);
		const statusImage = page.getByRole("img", { name: "Plugin status" });
		await expect(statusImage).toBeVisible();
		expect(
			await statusImage.evaluate(
				(image) => image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0,
			),
		).toBe(true);
		const diagnosticResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith("/_emdash/api/plugins/marketplace-test/admin") &&
				response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Run diagnostics" }).click();
		expect((await diagnosticResponse).status()).toBe(200);
		await expect(page.getByText("Diagnostics passed", { exact: true })).toBeVisible();

		await admin.goto("/plugins/marketplace-test/components");
		await admin.waitForLoading();
		await expect(page.getByRole("heading", { name: "Block Kit kitchen sink" })).toBeVisible();
		await expect(
			page.getByText("Every supported admin-page block and form element is represented here."),
		).toBeVisible();
		await expect(page.getByText("Locale")).toBeVisible();
		await expect(page.getByText("ar", { exact: true })).toBeVisible();
		await expect(page.getByText("Direction")).toBeVisible();
		await expect(page.getByText("rtl", { exact: true })).toBeVisible();
		await expect(page.getByRole("tab", { name: "Context" })).toBeVisible();
		await testInfo.attach("registry-fixture-components-ar-rtl", {
			body: await page.screenshot({ fullPage: true }),
			contentType: "image/png",
		});
	});

	test("loads the saved-entry panel lazily and runs the confirmed overflow action", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const entryId = serverInfo.contentIds.posts[0]!;
		let panelRequests = 0;
		page.on("request", (request) => {
			if (request.url().includes("/plugin-extensions/marketplace-test/panel/entry-context")) {
				panelRequests++;
			}
		});

		await admin.goto(`/content/posts/${entryId}?locale=en`);
		await admin.waitForLoading();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		expect(panelRequests).toBe(0);

		const panelResponse = page.waitForResponse(
			(response) =>
				response.url().includes("/plugin-extensions/marketplace-test/panel/entry-context") &&
				response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Entry context", exact: true }).click();
		expect((await panelResponse).status()).toBe(200);
		await expect(page.getByText(entryId, { exact: true })).toBeVisible();
		expect(panelRequests).toBe(1);

		await page.getByRole("button", { name: "Plugin actions" }).click();
		await expect(page.getByRole("menuitem", { name: "Invalid action" })).toHaveCount(0);
		await page.getByRole("menuitem", { name: "Refresh entry" }).click();
		const dialog = page.getByRole("alertdialog", { name: "Refresh entry?" });
		await expect(dialog).toBeVisible();
		const actionResponse = page.waitForResponse(
			(response) =>
				response.url().includes("/plugin-extensions/marketplace-test/action/refresh-entry") &&
				response.request().method() === "POST",
		);
		await dialog.getByRole("button", { name: "Refresh", exact: true }).click();
		expect((await actionResponse).status()).toBe(200);
		await expect(page.getByText(`posts/${entryId} refreshed`, { exact: true })).toBeVisible();
	});
});
