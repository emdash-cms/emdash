import { test, expect } from "../fixtures";

test("public post pages render as UTF-8", async ({ page }) => {
	await page.goto("/posts/first-post");

	await expect(page.locator("#title")).toHaveText("First Post");
	expect(await page.evaluate(() => document.characterSet)).toBe("UTF-8");
});
