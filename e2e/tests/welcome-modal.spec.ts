import { test, expect } from "../fixtures";

const ADMIN_ROOT_PATTERN = /\/_emdash\/admin\/?$/;
const CURRENT_USER_PATTERN = "**/_emdash/api/auth/me";
const LONG_FIRST_NAME = "Alexanderthegreatestname";
const MAX_LINE_BOX_OVERLAP_RATIO = 0.1;

test("wrapped welcome title lines do not collide", async ({ page }) => {
	await page.route(CURRENT_USER_PATTERN, async (route) => {
		if (route.request().method() !== "GET") {
			await route.continue();
			return;
		}

		await route.fulfill({
			status: 200,
			contentType: "application/json",
			body: JSON.stringify({
				success: true,
				data: {
					id: "welcome-test-user",
					email: "welcome-test@emdash.local",
					name: LONG_FIRST_NAME,
					role: 50,
					isFirstLogin: true,
				},
			}),
		});
	});

	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/_emdash/admin");
	await page.waitForURL(ADMIN_ROOT_PATTERN, { timeout: 30_000 });
	await page.waitForSelector("astro-island:not([ssr])", { timeout: 30_000 });

	const title = page.getByRole("heading", {
		name: `Welcome to EmDash, ${LONG_FIRST_NAME}!`,
	});
	await expect(title).toBeVisible({ timeout: 30_000 });

	const lineRects = await title.evaluate((element) => {
		const range = document.createRange();
		range.selectNodeContents(element);
		return Array.from(range.getClientRects(), ({ top, bottom, height }) => ({
			top,
			bottom,
			height,
		}));
	});

	expect(lineRects.length).toBeGreaterThanOrEqual(2);
	for (let i = 0; i < lineRects.length - 1; i++) {
		const currentLine = lineRects[i]!;
		const nextLine = lineRects[i + 1]!;
		const overlap = Math.max(0, currentLine.bottom - nextLine.top);
		expect(overlap / currentLine.height).toBeLessThanOrEqual(MAX_LINE_BOX_OVERLAP_RATIO);
	}
});
