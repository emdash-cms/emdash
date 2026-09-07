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
		await expect(settings.getByRole("button", { name: "Close image settings" })).toHaveCount(1);
		await expect(settings.getByRole("button", { name: "Close settings" })).toHaveCount(0);
		await expect
			.poll(() =>
				settings.evaluate((element) => {
					const bounds = element.getBoundingClientRect();
					return bounds.left >= 0 && bounds.right <= window.innerWidth;
				}),
			)
			.toBe(true);
		const panel = settings
			.getByRole("heading", { name: "Image settings" })
			.locator("xpath=../../..");
		expect(await panel.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(
			true,
		);

		await page.setViewportSize({ width: 368, height: 800 });
		const removeImage = settings.getByRole("button", { name: "Remove image" });
		const restingBackground = await removeImage.evaluate(
			(element) => getComputedStyle(element).backgroundColor,
		);
		expect(restingBackground).not.toBe(
			await removeImage.evaluate(
				(element) => getComputedStyle(element.parentElement!).backgroundColor,
			),
		);
		await removeImage.hover();
		await expect
			.poll(() => removeImage.evaluate((element) => getComputedStyle(element).backgroundColor))
			.not.toBe(restingBackground);

		const replaceImage = settings.getByRole("button", { name: "Replace image" });
		await replaceImage.focus();
		await expect(replaceImage).toBeFocused();
		await expect
			.poll(() =>
				replaceImage.evaluate((element) => {
					let current: HTMLElement | null = element;
					while (current) {
						if (getComputedStyle(current).opacity === "0") return false;
						current = current.parentElement;
					}
					return true;
				}),
			)
			.toBe(true);
		await page.keyboard.press("Enter");
		const replacementPicker = page.getByRole("dialog", { name: "Replace image" });
		await expect(replacementPicker).toBeVisible();
		await replacementPicker.getByRole("button", { name: "Close" }).click();

		await settings.getByRole("textbox", { name: "Alt text" }).fill("Updated diagram");
		await settings.getByRole("combobox", { name: "Alignment" }).click();
		await page.getByRole("option", { name: "Wide" }).click();
		await settings.getByRole("button", { name: "Apply" }).click();

		const updatedImage = page.getByRole("img", { name: "Updated diagram" });
		await updatedImage.click();
		await page.getByRole("button", { name: "Image settings" }).click();
		await expect(settings.getByRole("textbox", { name: "Alt text" })).toHaveValue(
			"Updated diagram",
		);
		await expect(settings.getByRole("combobox", { name: "Alignment" })).toContainText("Wide");

		await settings.getByRole("textbox", { name: "Alt text" }).fill("Discarded change");
		await settings.getByRole("button", { name: "Cancel" }).click();
		await updatedImage.click();
		await page.getByRole("button", { name: "Image settings" }).click();
		await expect(settings.getByRole("textbox", { name: "Alt text" })).toHaveValue(
			"Updated diagram",
		);
	});
});
