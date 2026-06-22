/**
 * Image optimization E2E.
 *
 * The seed creates a published "Post With Image" whose Portable Text body has an
 * image block (rendered by EmDashImage at /posts/post-with-image). This asserts
 * the image flows through Astro's image pipeline (a `/_image` src) and that the
 * wrapped endpoint serves real image bytes from storage -- not a redirect or
 * 404. On the Cloudflare target this exercises the storage-backed endpoint that
 * makes optimization work without an HTTP fetch of the media URL.
 */

import { test, expect } from "../fixtures";

test.describe("image optimization", () => {
	test("renders an optimized image served by the wrapped image endpoint", async ({
		page,
		request,
	}) => {
		const img = page.locator("figure.emdash-image img").first();

		// The workerd dev runner's Vite dep optimizer can transiently 500 a cold
		// route even after warm-up; reload until the page renders. (Dev-only; the
		// deployed Worker has no optimizer.)
		for (let attempt = 0; attempt < 5; attempt++) {
			await page.goto("/posts/post-with-image");
			if (await img.isVisible().catch(() => false)) break;
			await page.waitForTimeout(1000);
		}
		await expect(img).toBeVisible();

		const src = await img.getAttribute("src");
		expect(src, "image src should be optimized via Astro's image endpoint").toContain("/_image");

		// The optimized URL must return real image bytes, not an Access redirect or 404.
		const res = await request.get(src!);
		expect(res.status()).toBe(200);
		expect(res.headers()["content-type"]).toMatch(/^image\//);
	});
});
