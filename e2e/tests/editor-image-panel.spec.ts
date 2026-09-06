import { resolve } from "node:path";

import { test, expect } from "../fixtures";

const EXTERNAL_IMAGE_URL = "http://media.example.test/editor-panel.png";

test.describe("Editor image panel", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("keeps image settings within the mobile sidebar", async ({ admin, page }) => {
		await page.route(EXTERNAL_IMAGE_URL, (route) =>
			route.fulfill({
				path: resolve("e2e/fixtures/assets/test-image.png"),
				contentType: "image/png",
			}),
		);
		await admin.goToNewContent("posts");
		await admin.waitForLoading();

		await page.getByRole("button", { name: "Insert Image" }).click();
		const picker = page.getByRole("dialog", { name: "Select image" });
		await picker.getByRole("tab", { name: "From URL" }).click();
		await picker.getByLabel("Image URL").fill(EXTERNAL_IMAGE_URL);
		await picker.getByRole("button", { name: "Use URL" }).click();
		const insertButton = picker.getByRole("button", { name: "Insert image" });
		await expect(insertButton).toBeEnabled();
		await insertButton.click();

		const image = page.getByRole("img", { name: "editor-panel.png" });
		await expect(image).toBeVisible();
		await page.setViewportSize({ width: 200, height: 800 });
		await image.click();
		await page.getByRole("button", { name: "Image settings" }).click();

		const settings = page.getByRole("navigation", { name: "Settings" });
		await expect(settings).toBeVisible();
		await expect
			.poll(() =>
				settings.evaluate((element) => {
					const bounds = element.getBoundingClientRect();
					return bounds.left >= 0 && bounds.right <= window.innerWidth;
				}),
			)
			.toBe(true);
		const panel = settings
			.getByRole("heading", { name: "Image Settings" })
			.locator("xpath=../../..");
		expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
			true,
		);
	});
});
