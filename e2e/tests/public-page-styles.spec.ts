import type { Page } from "@playwright/test";

import { test, expect } from "../fixtures";

async function openPostWithCommentForm(page: Page) {
	const field = page.locator(".ec-comment-form-field").first();

	// The workerd dev runner's Vite dep optimizer can transiently 500 a cold
	// route even after warm-up; reload until the page renders. (Dev-only; the
	// deployed Worker has no optimizer.)
	for (let attempt = 0; attempt < 5; attempt++) {
		await page.goto("/posts/first-post");
		if (await field.isVisible().catch(() => false)) break;
		await page.waitForTimeout(1000);
	}

	return field;
}

test("a component's scoped styles apply on a public content page", async ({ page }) => {
	const field = await openPostWithCommentForm(page);

	await expect(field).toHaveCSS("display", "flex");
});

test("the comment form doesn't widen a right-to-left page", async ({ page }) => {
	await expect(await openPostWithCommentForm(page)).toBeVisible();

	const width = await page.locator("html").evaluate((html) => {
		html.dir = "rtl";
		// Chromium leaves off-page absolutely positioned content out of the
		// scroll width unless that content has a positioned ancestor.
		document.body.style.position = "relative";
		return { scroll: html.scrollWidth, client: html.clientWidth };
	});

	expect(width.scroll).toBe(width.client);
});
