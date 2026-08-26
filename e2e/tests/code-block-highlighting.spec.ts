import type { Locator, Page } from "@playwright/test";

import { test, expect } from "../fixtures";

async function expectInside(outer: Locator, inner: Locator) {
	await expect(outer).toBeVisible();
	await expect(inner).toBeVisible();
	const [outerBox, innerBox] = await Promise.all([outer.boundingBox(), inner.boundingBox()]);
	expect(outerBox).not.toBeNull();
	expect(innerBox).not.toBeNull();
	if (!outerBox || !innerBox) return;
	expect(innerBox.x).toBeGreaterThanOrEqual(outerBox.x);
	expect(innerBox.x + innerBox.width).toBeLessThanOrEqual(outerBox.x + outerBox.width);
}
async function emulateCoarsePointer(page: Page) {
	const cdp = await page.context().newCDPSession(page);
	await cdp.send("Emulation.setTouchEmulationEnabled", { enabled: true, maxTouchPoints: 1 });
	await cdp.send("Emulation.setEmulatedMedia", {
		features: [
			{ name: "hover", value: "none" },
			{ name: "pointer", value: "coarse" },
		],
	});
	expect(await page.evaluate(() => matchMedia("(pointer: coarse)").matches)).toBe(true);
	await page.mouse.move(0, 0);
}

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
		const node = admin.page.locator(".emdash-code-block-node").first();
		await node.hover();
		await admin.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		await node.getByRole("button", { name: "Copy code" }).click();
		await expect(node.getByRole("status")).toHaveText("Copied");
		const clipboardText = await admin.page.evaluate(() => navigator.clipboard.readText());
		expect(clipboardText).toContain("const greeting");
		await admin.page.setViewportSize({ width: 200, height: 600 });
		await node.evaluate((element) => {
			element.setAttribute("dir", "rtl");
			element.style.inlineSize = "168px";
		});
		const language = node.getByRole("button", { name: /^Set language/ });
		const copy = node.getByRole("button", { name: "Copy code" });
		await language.focus();
		await admin.page.keyboard.press("ArrowLeft");
		await expect(copy).toBeFocused();
		await language.click();
		await admin.page.getByPlaceholder("Language").fill("very-long-custom-language-name");
		await admin.page.keyboard.press("Enter");
		await expect(
			node.getByRole("button", { name: /very-long-custom-language-name/ }),
		).toBeVisible();
		await expectInside(node, language);
		await expectInside(node, copy);
		await emulateCoarsePointer(admin.page);
		await expect(node.locator(".emdash-code-block-controls")).toHaveCSS("opacity", "1");
	});

	test("uses borderless code surfaces in light and dark appearances", async ({ admin }) => {
		const codeBlock = admin.page.locator(".emdash-code-block").first();

		await admin.page.evaluate(() => document.documentElement.setAttribute("data-mode", "light"));
		await expect(codeBlock).toHaveCSS("background-color", "rgb(247, 247, 245)");
		await expect(codeBlock).toHaveCSS("border-top-width", "0px");

		await admin.page.evaluate(() => document.documentElement.setAttribute("data-mode", "dark"));
		await expect(codeBlock).toHaveCSS("background-color", "rgb(32, 32, 32)");
		await expect(codeBlock).toHaveCSS("border-top-width", "0px");
	});

	test("reveals code controls when focus enters the toolbar", async ({ admin }) => {
		const node = admin.page.locator(".emdash-code-block-node").first();
		const controls = node.locator(".emdash-code-block-controls");
		const language = node.getByRole("button", { name: /^Set language/ });

		await admin.page.mouse.move(0, 0);
		await expect(controls).toHaveCSS("opacity", "0");
		await language.focus();

		await expect(language).toBeFocused();
		await expect(controls).toHaveCSS("opacity", "1");
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
		await expect(codeBlock).toHaveCSS("border-top-width", "0px");
		await page.emulateMedia({ colorScheme: "dark" });
		const darkBackground = await codeBlock.evaluate(
			(element) => getComputedStyle(element).backgroundColor,
		);
		expect(lightBackground).toBe("rgb(247, 247, 245)");
		expect(darkBackground).toBe("rgb(32, 32, 32)");
		await expect(codeBlock).toHaveCSS("border-top-width", "0px");

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
		await expect(codeBlock.locator("code")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
		await expect(codeBlock.locator("code")).toHaveCSS("color", "rgb(245, 245, 245)");
		await expect(codeBlock.locator("code")).toHaveCSS("font-size", "13px");
		expect(await editorHandle?.evaluate((element) => element.isConnected)).toBe(true);
		expect(updateRequests).toBe(0);
	});

	test("reveals inline code controls when focus enters them", async ({ page }) => {
		const node = page.locator(".emdash-inline-code-block").first();
		const controls = node.locator(".emdash-inline-code-block-controls-wrap");
		const language = node.getByRole("button", { name: /^Set language/ });

		await page.mouse.move(0, 0);
		await expect(controls).toHaveCSS("opacity", "0");
		await language.focus();

		await expect(language).toBeFocused();
		await expect(controls).toHaveCSS("opacity", "1");
	});

	test("keeps controls usable in narrow RTL and does not save on copy", async ({ page }) => {
		await page.setViewportSize({ width: 200, height: 600 });
		const node = page.locator(".emdash-inline-code-block").first();
		await node.evaluate((element) => element.setAttribute("dir", "rtl"));
		const language = node.getByRole("button", { name: /^Set language/ });
		const copy = node.getByRole("button", { name: "Copy code" });
		await node.hover();
		await language.focus();
		await page.keyboard.press("Tab");
		await expect(copy).toBeFocused();
		await language.click();
		await expectInside(node, node.locator(".emdash-inline-code-block-popover"));
		const input = node.getByRole("combobox", { name: "Language" });
		await input.fill("very-long-custom-language-name");
		await page.keyboard.press("Enter");
		await expect(
			node.getByRole("button", { name: /very-long-custom-language-name/ }),
		).toBeVisible();
		await expectInside(node, language);
		await expectInside(node, copy);
		let updates = 0;
		page.on("request", (request) => {
			if (request.method() === "PUT" && request.url().includes("/_emdash/api/content/")) updates++;
		});
		await page.waitForTimeout(500);
		await node.locator("code").click();
		await page.keyboard.press("End");
		await page.keyboard.type("x");
		await page.keyboard.press("Shift+Home");
		const selectionBeforeCopy = await page.evaluate(() => document.getSelection()?.toString());
		const codeBeforeCopy = await node.locator("code").innerText();
		expect(selectionBeforeCopy).not.toBe("");
		updates = 0;
		await page.evaluate(() => {
			Object.defineProperty(navigator, "clipboard", {
				configurable: true,
				value: { writeText: () => Promise.reject(new DOMException("Denied", "NotAllowedError")) },
			});
			document.execCommand = (command) => {
				(window as Window & { __legacyCopy?: { command: string; value: string } }).__legacyCopy = {
					command,
					value: (document.activeElement as HTMLTextAreaElement).value,
				};
				return true;
			};
		});
		await copy.click();
		await expect(node.getByRole("status")).toHaveText("Copied");
		expect(
			await page.evaluate(
				() =>
					(window as Window & { __legacyCopy?: { command: string; value: string } }).__legacyCopy,
			),
		).toEqual({ command: "copy", value: codeBeforeCopy });
		expect(await page.evaluate(() => document.getSelection()?.toString())).toBe(
			selectionBeforeCopy,
		);
		expect(
			await page.evaluate(() => document.activeElement?.classList.contains("ProseMirror")),
		).toBe(true);
		await page.waitForTimeout(1000);
		await copy.click();
		await page.waitForTimeout(600);
		await expect(node.getByRole("status")).toHaveText("Copied");
		await page.waitForTimeout(900);
		await expect(node.getByRole("status")).toHaveText("");
		expect(updates).toBe(0);
		await emulateCoarsePointer(page);
		await expect(node.locator(".emdash-inline-code-block-controls-wrap")).toHaveCSS("opacity", "1");
	});
});
