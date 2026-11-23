import type { Page } from "@playwright/test";

import { test, expect } from "../fixtures";

const LIGHT_URL = "https://media.example.test/logo-light.png";
const DARK_URL = "https://media.example.test/logo-dark.png";
const CONTENT_EDIT_URL_PATTERN = /\/content\/posts\/[^/]+$/;

const ONE_PIXEL_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
	"base64",
);

async function pickFromUrl(page: Page, dialogName: string, url: string) {
	const picker = page.getByRole("dialog", { name: dialogName });
	await picker.getByRole("tab", { name: "From URL" }).click();
	await picker.getByLabel("Image URL").fill(url);
	await picker.getByRole("button", { name: "Use URL" }).click();
	await picker.getByRole("button", { name: "Select", exact: true }).click();
	await expect(picker).toBeHidden();
}

test.describe("Plugin block dark variant", () => {
	test.beforeEach(async ({ admin, page }) => {
		await page.route("https://media.example.test/**", (route) =>
			route.fulfill({ status: 200, contentType: "image/png", body: ONE_PIXEL_PNG }),
		);
		await admin.devBypassAuth();
	});

	test("stores the variant beside the logo and renders both images", async ({ admin, page }) => {
		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		await admin.fillField("title", "Plugin block dark variant");

		await page.getByRole("textbox", { name: "Body" }).click();
		await page.keyboard.type("/Brand");
		await page.getByRole("button", { name: "Brand logo" }).click();

		const form = page.getByRole("dialog", { name: "Insert Brand logo" });
		await expect(form.getByRole("button", { name: "Add dark mode variant" })).toHaveCount(0);

		await form.getByRole("button", { name: "Select media" }).first().click();
		await pickFromUrl(page, "Select Logo", LIGHT_URL);

		await form.getByRole("button", { name: "Add dark mode variant" }).click();
		await pickFromUrl(page, "Select Logo (dark mode)", DARK_URL);
		await expect(form.getByRole("button", { name: "Replace Logo (dark mode)" })).toBeVisible();

		await form.getByRole("button", { name: "Insert", exact: true }).click();
		await admin.clickSave();
		await expect(page).toHaveURL(CONTENT_EDIT_URL_PATTERN, { timeout: 10000 });

		await page.getByRole("button", { name: "Publish now", exact: true }).click();
		await page
			.getByRole("dialog", { name: "Publish now?" })
			.getByRole("button", { name: "Publish now", exact: true })
			.click();
		await expect(page.getByText("Live version", { exact: true })).toBeVisible({ timeout: 10000 });

		await page.emulateMedia({ colorScheme: "dark" });
		await page.goto("/posts/plugin-block-dark-variant");
		const light = page.locator(`figure.brand-logo img.emdash-image--light[src="${LIGHT_URL}"]`);
		const dark = page.locator(`figure.brand-logo img.emdash-image--dark[src="${DARK_URL}"]`);
		await expect(dark).toBeVisible();
		await expect(light).toHaveCSS("display", "none");
	});

	test("removing the logo removes its dark variant", async ({ admin, page, serverInfo }) => {
		const response = await fetch(`${serverInfo.baseUrl}/_emdash/api/content/posts`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${serverInfo.token}`,
				"Content-Type": "application/json",
				"X-EmDash-Request": "1",
				Origin: serverInfo.baseUrl,
			},
			body: JSON.stringify({
				slug: "plugin-block-remove-logo",
				data: {
					title: "Plugin block remove logo",
					body: [
						{
							_type: "brandLogo",
							_key: "logo1",
							logo: LIGHT_URL,
							logo_dark: DARK_URL,
							alt: "Logo",
						},
					],
				},
			}),
		});
		expect(response.ok).toBe(true);
		const created = (await response.json()) as { data?: { item?: { id: string } } };
		const id = created.data?.item?.id;
		expect(id).toBeTruthy();

		await admin.goToEditContent("posts", id!);
		await admin.waitForLoading();
		await page.getByRole("button", { name: "Edit", exact: true }).click();

		const form = page.getByRole("dialog", { name: "Edit Brand logo" });
		await expect(form.getByRole("button", { name: "Replace Logo (dark mode)" })).toBeVisible();
		await form.getByRole("button", { name: "Remove Logo", exact: true }).click();

		await expect(form.getByRole("button", { name: "Replace Logo (dark mode)" })).toHaveCount(0);
		await expect(form.getByRole("button", { name: "Add dark mode variant" })).toHaveCount(0);
		await expect(form.getByRole("button", { name: "Select media" }).first()).toBeVisible();
	});
});
