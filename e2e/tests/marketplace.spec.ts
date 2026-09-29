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

	test("verifies a registry plugin before showing installation consent", async ({
		admin,
		page,
	}) => {
		test.setTimeout(90_000);
		await page.addInitScript(() => {
			localStorage.setItem(
				"emdash:did-handle:did:plc:delegated00000000000000",
				JSON.stringify({
					resolution: { status: "missing" },
					expiresAt: Date.now() + 60_000,
				}),
			);
		});
		await admin.goto("/plugins/registry/did:plc:delegated00000000000000/gallery");
		await admin.waitForShell();

		await expect(page.getByRole("heading", { name: "Gallery" })).toBeVisible({ timeout: 15_000 });
		await page.getByLabel("Version").click();
		await page.getByRole("option", { name: "1.2.3" }).click();
		const verificationResponse = page.waitForResponse(
			(response) =>
				response.url().endsWith("/_emdash/api/admin/plugins/registry/verify") &&
				response.request().method() === "POST",
		);
		await page.getByRole("button", { name: "Install", exact: true }).click();

		const response = await verificationResponse;
		expect(response.status()).toBe(200);
		await expect(response.json()).resolves.toMatchObject({
			success: true,
			data: {
				version: "1.2.3",
				verification: {
					profileCid: "bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe",
					provenance: "absent-optional",
				},
			},
		});
		const dialog = page.getByRole("dialog", { name: "Capability consent" });
		await expect(dialog.getByRole("heading", { name: "Review Verified Plugin" })).toBeVisible();
		await expect(
			dialog.getByText(
				"The signed publisher records and package are valid. Build provenance was not provided.",
			),
		).toBeVisible();
		await expect(
			dialog.getByText("bafyreigh2akiscaildc4mscz4uzpcbap5jxg26eecmrf6cmnvkzkjmoixe"),
		).toBeHidden();

		const installResponse = page.waitForResponse(
			(candidate) =>
				candidate.url().endsWith("/_emdash/api/admin/plugins/registry/install") &&
				candidate.request().method() === "POST",
		);
		await dialog.getByRole("button", { name: "Accept & Install" }).click();
		expect((await installResponse).status()).toBe(201);
		await expect(dialog).toBeHidden();
		await expect(page.getByRole("button", { name: "Installed" })).toBeDisabled();

		const pluginsResponse = await page.request.get("/_emdash/api/admin/plugins");
		expect(pluginsResponse.status()).toBe(200);
		const plugins = (await pluginsResponse.json()) as {
			data: {
				items: Array<{
					id: string;
					source?: string;
					registryPublisherDid?: string;
					registrySlug?: string;
				}>;
			};
		};
		const installed = plugins.data.items.find(
			(item) =>
				item.source === "registry" &&
				item.registryPublisherDid === "did:plc:delegated00000000000000" &&
				item.registrySlug === "gallery",
		);
		expect(installed).toBeDefined();

		const pluginPath = encodeURIComponent(installed!.id);
		await admin.goto(`/plugins/${pluginPath}/overview`);
		await admin.waitForLoading();
		await expect(page.getByRole("heading", { name: "Installed Gallery 1.2.3" })).toBeVisible();
		const hello = await page.request.get(`/_emdash/api/plugins/${pluginPath}/hello`);
		await expect(hello.json()).resolves.toMatchObject({ data: { version: "1.2.3" } });

		await admin.goto("/plugins-manager");
		await admin.waitForLoading();
		const card = page.locator(".rounded-lg.border.bg-kumo-base", { hasText: "Gallery" }).first();
		await expect(card).toBeVisible();
		await card.getByRole("switch", { name: "Disable plugin" }).click();
		await expect(card.getByText("Disabled", { exact: true })).toBeVisible();
		expect((await page.request.get(`/_emdash/api/plugins/${pluginPath}/hello`)).status()).toBe(404);
		await card.getByRole("switch", { name: "Enable plugin" }).click();
		await expect(card.getByText("Disabled", { exact: true })).toHaveCount(0);
		const reenabledHello = await page.request.get(`/_emdash/api/plugins/${pluginPath}/hello`);
		expect(reenabledHello.status(), await reenabledHello.text()).toBe(200);

		await page.getByRole("button", { name: "Check for updates" }).click();
		await card.getByRole("button", { name: "Update to v1.3.0" }).click();
		const updateDialog = page.getByRole("dialog", { name: "Capability consent" });
		await expect(
			updateDialog.getByRole("heading", { name: "Review Verified Update" }),
		).toBeVisible();
		await expect(updateDialog.getByText(/media/i).first()).toBeVisible();
		await updateDialog.getByRole("button", { name: "Accept & Update" }).click();
		await expect(page.getByText("Plugin updated", { exact: true })).toBeVisible();
		await expect(card.getByText("v1.3.0", { exact: true })).toBeVisible();

		await admin.goto(`/plugins/${pluginPath}/overview`);
		await admin.waitForLoading();
		await expect(page.getByRole("heading", { name: "Installed Gallery 1.3.0" })).toBeVisible();

		await admin.goto("/plugins-manager");
		await admin.waitForLoading();
		const updatedCard = page
			.locator(".rounded-lg.border.bg-kumo-base", { hasText: "Gallery" })
			.first();
		await updatedCard.getByRole("button", { name: "Expand details" }).click();
		await updatedCard.getByRole("button", { name: "Uninstall", exact: true }).click();
		const uninstallDialog = page.getByRole("dialog", { name: "Uninstall confirmation" });
		await uninstallDialog.getByText("Also delete plugin storage data").click();
		await uninstallDialog.getByRole("button", { name: "Uninstall", exact: true }).click();
		await expect(page.getByText("Plugin uninstalled", { exact: true })).toBeVisible();
		await expect(updatedCard).toHaveCount(0);
	});
});
