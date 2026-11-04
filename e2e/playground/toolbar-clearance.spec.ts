import { expect, test } from "@playwright/test";

const ADMIN_URL_PATTERN = /\/_emdash\/admin\/?$/;
const DARK_CLASS = /\bdark\b/;

test.use({ viewport: { width: 375, height: 812 } });

test("lets the end of the page scroll clear of the toolbar", async ({ page }) => {
	await page.goto("/playground");
	await page.waitForURL(ADMIN_URL_PATTERN, { timeout: 240_000 });
	const toolbar = page.locator("#emdash-playground-toolbar");
	await expect(toolbar).toBeVisible();

	await expect
		.poll(() => page.evaluate(() => document.documentElement.scrollHeight - innerHeight))
		.toBe(0);

	await page.goto("/");
	const darkTheme = page.getByRole("group", { name: "Color theme" }).getByRole("button", {
		name: "Dark",
	});
	await expect
		.poll(async () => {
			await page.evaluate(() =>
				window.scrollTo({ top: document.documentElement.scrollHeight, behavior: "instant" }),
			);
			const button = await darkTheme.boundingBox({ timeout: 5_000 });
			const bar = await toolbar.boundingBox({ timeout: 5_000 });
			return button && bar ? button.y + button.height <= bar.y : false;
		})
		.toBe(true);

	await darkTheme.click();
	await expect(page.locator("html")).toHaveClass(DARK_CLASS);
});
