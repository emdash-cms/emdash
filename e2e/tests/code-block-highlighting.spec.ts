import { test, expect } from "../fixtures";

test.describe("Code block highlighting", () => {
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
