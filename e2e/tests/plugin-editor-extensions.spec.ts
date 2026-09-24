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

		const title = admin.page.locator("#field-title");
		await title.fill("Saved before plugin action");
		await admin.clickSave();
		await admin.waitForSaveComplete();
		await expect(title).toHaveValue("Saved before plugin action");

		const panelResponse = admin.page.waitForResponse(
			(response) =>
				response.url().includes("/plugin-extensions/editor-extensions-test/panel/entry-health") &&
				response.request().method() === "POST",
		);
		await admin.page.getByRole("button", { name: "Plugin content health", exact: true }).click();
		const loadedPanelResponse = await panelResponse;
		expect(loadedPanelResponse.status(), await loadedPanelResponse.text()).toBe(200);
		await expect(admin.page.getByRole("button", { name: "Translate draft" })).toBeVisible();
		await expect(admin.page.getByText(entryId, { exact: true })).toBeVisible();

		const refreshedPanelResponse = admin.page.waitForResponse(
			(response) =>
				response.url().includes("/plugin-extensions/editor-extensions-test/panel/entry-health") &&
				response.request().method() === "POST",
		);
		await title.fill("Saved while plugin panel open");
		await admin.clickSave();
		await admin.waitForSaveComplete();
		expect((await refreshedPanelResponse).status()).toBe(200);
		await expect(
			admin.page.getByRole("button", { name: "Plugin content health", exact: true }),
		).toHaveAttribute("aria-expanded", "true");
		await expect(admin.page.getByRole("button", { name: "Translate draft" })).toBeVisible();

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

	test("previews and applies an explicit unsaved draft patch without saving", async ({
		admin,
		serverInfo,
	}, testInfo) => {
		const entryId = serverInfo.contentIds.posts[0]!;
		await admin.page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/" }]);
		await admin.goto(`/content/posts/${entryId}?locale=en`);
		await admin.waitForLoading();
		const extensionRequests: Array<Record<string, unknown>> = [];
		admin.page.on("request", (request) => {
			if (request.url().includes("/plugin-extensions/editor-extensions-test/panel/entry-health")) {
				extensionRequests.push(request.postDataJSON() as Record<string, unknown>);
			}
		});
		await admin.page.getByRole("button", { name: "Plugin content health", exact: true }).click();
		await expect(admin.page.getByRole("button", { name: "Translate draft" })).toBeVisible();
		expect(extensionRequests).toEqual([{ type: "panel_load" }]);

		const title = admin.page.locator("#field-title");
		const body = admin.page.locator('#field-body [contenteditable="true"]');
		await title.fill("Unsaved title");
		await body.fill("Unsaved body");
		expect(extensionRequests).toHaveLength(1);

		const patchResponsePromise = admin.page.waitForResponse((response) =>
			response.url().includes("/plugin-extensions/editor-extensions-test/panel/entry-health"),
		);
		await admin.page.getByRole("button", { name: "Translate draft" }).click();
		const patchResponse = await patchResponsePromise;
		expect(extensionRequests[1]).toMatchObject({
			type: "block_action",
			action_id: "translate-draft",
			draft: { fields: { title: "Unsaved title", body: expect.any(Array) } },
		});
		if (patchResponse.status() !== 200) {
			const retry = await admin.page.request.post(patchResponse.url(), {
				headers: { "X-EmDash-Request": "1" },
				data: extensionRequests[1],
			});
			throw new Error(await retry.text());
		}
		expect(patchResponse.status()).toBe(200);
		const preview = admin.page.getByRole("dialog", { name: "Review proposed changes" });
		await expect(preview).toBeVisible();
		await expect(preview.getByText("Unsaved title", { exact: true })).toBeVisible();
		await expect(preview.getByText("Unsaved title translated", { exact: true })).toBeVisible();
		await admin.page.screenshot({
			path: testInfo.outputPath("editor-draft-preview-rtl.png"),
			fullPage: true,
		});
		expect(extensionRequests).toHaveLength(2);
		await preview.getByRole("button", { name: "Apply changes" }).click();
		await expect(title).toHaveValue("Unsaved title translated");
		await expect(admin.page.locator('form button[type="submit"]').first()).toBeEnabled();
	});

	test("rejects a draft result after an intervening edit", async ({
		admin,
		serverInfo,
	}, testInfo) => {
		const entryId = serverInfo.contentIds.posts[0]!;
		await admin.page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/" }]);
		await admin.goto(`/content/posts/${entryId}?locale=en`);
		await admin.waitForLoading();
		await admin.page.getByRole("button", { name: "Plugin content health", exact: true }).click();
		const title = admin.page.locator("#field-title");
		await title.fill("Before slow translation");
		const slowResponsePromise = admin.page.waitForResponse((response) =>
			response.url().includes("/plugin-extensions/editor-extensions-test/panel/entry-health"),
		);
		await admin.page.getByRole("button", { name: "Translate slowly" }).click();
		await title.fill("Typed while plugin worked");
		const slowResponse = await slowResponsePromise;
		expect(slowResponse.status()).toBe(200);
		await expect(
			admin.page.getByText("Plugin changes were not applied", { exact: true }),
		).toBeVisible();
		await expect(title).toHaveValue("Typed while plugin worked");
		await expect(admin.page.getByRole("dialog", { name: "Review proposed changes" })).toHaveCount(
			0,
		);
		await admin.page.screenshot({
			path: testInfo.outputPath("editor-draft-stale-rtl.png"),
			fullPage: true,
		});
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
