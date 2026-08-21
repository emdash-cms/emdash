import { test, expect } from "../fixtures";

test.describe("Admin code block highlighting", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
		await admin.goToContent("posts");
		await admin.waitForLoading();
		await admin.page.getByRole("link", { name: "Post With Code", exact: true }).click();
		await admin.waitForLoading();
	});

	test("highlights supported languages and leaves unsupported languages plain", async ({
		admin,
	}) => {
		const codeBlocks = admin.page.locator(".emdash-code-block");
		await expect(codeBlocks).toHaveCount(2);
		await expect(codeBlocks.nth(0).locator('span[class*="hljs-"]')).not.toHaveCount(0);
		await expect(codeBlocks.nth(1).locator('span[class*="hljs-"]')).toHaveCount(0);
	});
});

test("keeps public code block rendering unchanged", async ({ page }) => {
	await page.goto("/posts/post-with-code");

	await expect(page.locator(".emdash-code pre.language-javascript")).toBeVisible();
	await expect(page.locator(".emdash-code pre.language-astro")).toBeVisible();
	await expect(page.locator('span[class*="hljs-"]')).toHaveCount(0);
});

test.describe("Inline code block highlighting", () => {
	test.beforeEach(async ({ admin, page }) => {
		await admin.devBypassAuth();
		await page.context().addCookies([
			{
				name: "emdash-edit-mode",
				value: "true",
				domain: "localhost",
				path: "/",
			},
		]);
		await page.goto("/posts/post-with-code");
		await expect(page.locator(".emdash-inline-editor")).toBeVisible({ timeout: 15000 });
	});

	test("highlights supported languages and leaves unsupported languages plain", async ({
		page,
	}) => {
		const codeBlocks = page.locator(".emdash-inline-code-block .emdash-code-block");
		await expect(codeBlocks).toHaveCount(2);
		await expect(codeBlocks.nth(0).locator('span[class*="hljs-"]')).not.toHaveCount(0);
		await expect(codeBlocks.nth(1).locator('span[class*="hljs-"]')).toHaveCount(0);
	});

	test("updates system and site theme colors without remounting or saving", async ({ page }) => {
		const editor = page.locator(".emdash-inline-editor");
		const editorHandle = await editor.elementHandle();
		const codeBlock = page.locator(".emdash-inline-code-block .emdash-code-block").first();
		let updateRequests = 0;
		page.on("request", (request) => {
			if (request.method() === "PUT" && request.url().includes("/_emdash/api/content/")) {
				updateRequests += 1;
			}
		});

		await page.emulateMedia({ colorScheme: "light" });
		const lightBackground = await codeBlock.evaluate(
			(element) => getComputedStyle(element).backgroundColor,
		);
		await page.emulateMedia({ colorScheme: "dark" });
		const darkBackground = await codeBlock.evaluate(
			(element) => getComputedStyle(element).backgroundColor,
		);
		expect(lightBackground).not.toBe(darkBackground);

		await page.evaluate(() => {
			document.documentElement.style.setProperty(
				"--emdash-inline-code-background",
				"rgb(25, 35, 45)",
			);
			document.documentElement.style.setProperty(
				"--emdash-inline-code-foreground",
				"rgb(245, 245, 245)",
			);
		});

		await expect(codeBlock).toHaveCSS("background-color", "rgb(25, 35, 45)");
		await expect(codeBlock).toHaveCSS("color", "rgb(245, 245, 245)");
		expect(await editorHandle?.evaluate((element) => element.isConnected)).toBe(true);
		expect(updateRequests).toBe(0);
	});
});
