import { expect, test } from "../fixtures";

test.describe("Sandboxed plugin editor extensions", () => {
	test.skip(
		process.env.EMDASH_E2E_TARGET === "cloudflare",
		"The Node fixture owns the configured standard-plugin UI journey",
	);

	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("loads a saved-entry panel lazily and confirms an action in RTL", async ({
		admin,
		serverInfo,
	}) => {
		const entryId = serverInfo.contentIds.posts[0]!;
		await admin.page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/" }]);
		await admin.goto(`/content/posts/${entryId}?locale=en`);
		await admin.waitForLoading();
		await expect(admin.page.locator("html")).toHaveAttribute("dir", "rtl");

		const panelResponse = admin.page.waitForResponse(
			(response) =>
				response.url().includes("/plugin-extensions/editor-extensions-test/panel/entry-health") &&
				response.request().method() === "POST",
		);
		await admin.page.getByRole("button", { name: "Plugin content health", exact: true }).click();
		const loadedPanelResponse = await panelResponse;
		expect(loadedPanelResponse.status(), await loadedPanelResponse.text()).toBe(200);
		await expect(admin.page.getByText("Saved content only", { exact: true })).toBeVisible();
		await expect(admin.page.getByText(entryId, { exact: true })).toBeVisible();

		await admin.page.getByRole("button", { name: "Recheck saved entry" }).click();
		const dialog = admin.page.getByRole("alertdialog", { name: "Recheck saved entry?" });
		await expect(dialog).toBeVisible();
		const actionResponse = admin.page.waitForResponse(
			(response) =>
				response.url().includes("/plugin-extensions/editor-extensions-test/action/entry-recheck") &&
				response.request().method() === "POST",
		);
		await dialog.getByRole("button", { name: "Recheck", exact: true }).click();
		expect((await actionResponse).status()).toBe(200);
		await expect(admin.page.getByText("Saved entry rechecked", { exact: true })).toBeVisible();
	});

	test("does not expose saved-entry extensions while creating content", async ({ admin }) => {
		await admin.goto("/content/posts/new");
		await admin.waitForLoading();
		await expect(
			admin.page.getByRole("button", { name: "Plugin content health", exact: true }),
		).toHaveCount(0);
		await expect(admin.page.getByRole("button", { name: "Recheck saved entry" })).toHaveCount(0);
	});
});
