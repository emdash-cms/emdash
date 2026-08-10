import { test, expect } from "../fixtures";

test("a component's scoped styles apply on a public content page", async ({ page }) => {
	await page.goto("/posts/first-post");

	await expect(page.locator(".ec-comment-form-field").first()).toHaveCSS("display", "flex");
});
