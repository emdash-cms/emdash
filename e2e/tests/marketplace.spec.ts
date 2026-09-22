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

		const uninstallResponse = await page.request.post(
			`/_emdash/api/admin/plugins/registry/${encodeURIComponent(installed!.id)}/uninstall`,
			{
				headers: { "X-EmDash-Request": "1" },
				data: { deleteData: true },
			},
		);
		expect(uninstallResponse.status()).toBe(200);
		await expect(uninstallResponse.json()).resolves.toMatchObject({
			success: true,
			data: { pluginId: installed!.id, dataDeleted: true },
		});
	});
});
