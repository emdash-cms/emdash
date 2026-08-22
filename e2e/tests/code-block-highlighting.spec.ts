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

	test("uses borderless code surfaces in light and dark appearances", async ({ admin }) => {
		const codeBlock = admin.page.locator(".emdash-code-block").first();

		await admin.page.evaluate(() => document.documentElement.setAttribute("data-mode", "light"));
		await expect(codeBlock).toHaveCSS("background-color", "rgb(247, 247, 245)");
		await expect(codeBlock).toHaveCSS("border-top-width", "0px");

		await admin.page.evaluate(() => document.documentElement.setAttribute("data-mode", "dark"));
		await expect(codeBlock).toHaveCSS("background-color", "rgb(32, 32, 32)");
		await expect(codeBlock).toHaveCSS("border-top-width", "0px");
	});

	test("shows aligned two-action controls and applies their actions", async ({ admin }) => {
		const codeBlockNode = admin.page.locator(".emdash-code-block-node").first();
		const controls = codeBlockNode.getByRole("toolbar", { name: "Code block actions" });
		const languageButton = controls.getByRole("button", { name: /^Set language/ });
		const copyButton = controls.getByRole("button", { name: "Copy code" });
		let updateRequests = 0;
		admin.page.on("request", (request) => {
			if (request.method() === "PUT" && request.url().includes("/_emdash/api/content/")) {
				updateRequests += 1;
			}
		});
		await admin.page.waitForTimeout(2200);
		updateRequests = 0;

		await admin.page.mouse.move(0, 0);
		await expect(controls).toHaveCSS("opacity", "0");
		await languageButton.focus();
		await expect(controls).toHaveCSS("opacity", "1");
		await codeBlockNode.hover();
		await expect(controls).toHaveCSS("opacity", "1");
		await expect(controls.getByRole("button")).toHaveCount(2);
		await expect(languageButton).toHaveCSS("font-size", "14px");
		await expect(copyButton).toHaveCSS("font-size", "14px");
		await expect(copyButton).toHaveAttribute("data-kumo-component", "Toolbar.Button");

		const nodeBox = await codeBlockNode.boundingBox();
		const controlsBox = await controls.boundingBox();
		const languageBox = await languageButton.boundingBox();
		const codeText = await codeBlockNode.locator("code").evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			const rects = [...range.getClientRects()];
			return { top: rects[0]?.top, bottom: rects.at(-1)?.bottom };
		});
		expect(nodeBox).not.toBeNull();
		expect(controlsBox).not.toBeNull();
		expect(languageBox?.height).toBe(36);
		expect(controlsBox?.y).toBeCloseTo((nodeBox?.y ?? 0) + 4, 0);
		expect(controlsBox?.x).toBeCloseTo(
			(nodeBox?.x ?? 0) + (nodeBox?.width ?? 0) - (controlsBox?.width ?? 0) - 4,
			0,
		);
		expect(codeText.top ?? 0).toBeLessThan((controlsBox?.y ?? 0) + (controlsBox?.height ?? 0));
		const topGap = (codeText.top ?? 0) - (nodeBox?.y ?? 0);
		const bottomGap = (nodeBox?.y ?? 0) + (nodeBox?.height ?? 0) - (codeText.bottom ?? 0);
		expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(4);

		const currentLanguageLabel = await languageButton.getAttribute("aria-label");
		const nextLanguage = currentLanguageLabel?.includes("Python") ? "JavaScript" : "Python";
		await languageButton.click();
		await admin.page.mouse.move(0, 0);
		await expect(controls).toHaveCSS("opacity", "1");
		const input = admin.page.getByPlaceholder("Search for a language…");
		const popup = admin.page.locator(".kumo-popover-popup");
		await expect(input).toBeVisible();
		await expect(input).toHaveCSS("font-size", "14px");
		await expect(admin.page.getByRole("option", { name: "Plain text" })).toHaveCSS(
			"font-size",
			"14px",
		);
		await popup.evaluate(async (element) => {
			await Promise.all(element.getAnimations().map((animation) => animation.finished));
		});
		const placeholderColor = await input.evaluate(
			(element) => getComputedStyle(element, "::placeholder").color,
		);
		const inputColor = await input.evaluate((element) => getComputedStyle(element).color);
		expect(placeholderColor).not.toBe(inputColor);

		const popupBox = await popup.boundingBox();
		const openControlsBox = await controls.boundingBox();
		expect(popupBox?.x).toBeCloseTo(openControlsBox?.x ?? 0, 0);
		const popupBelowGap =
			(popupBox?.y ?? 0) - ((openControlsBox?.y ?? 0) + (openControlsBox?.height ?? 0));
		const popupAboveGap =
			(openControlsBox?.y ?? 0) - ((popupBox?.y ?? 0) + (popupBox?.height ?? 0));
		expect(Math.max(popupBelowGap, popupAboveGap)).toBeCloseTo(8, 0);

		await admin.page.keyboard.press("Escape");
		await expect(input).toBeHidden();
		await copyButton.hover();
		await expect(
			admin.page.locator(".kumo-tooltip-popup").filter({ hasText: "Copy code" }),
		).toBeVisible();
		await expect(admin.page.locator(".kumo-tooltip-popup")).toHaveCount(1);
		await admin.page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		await copyButton.click();
		await expect(controls.getByRole("button", { name: "Copied" })).toBeVisible();
		await admin.page.waitForTimeout(2200);
		expect(updateRequests).toBe(0);

		await languageButton.click();
		const autosaveResponse = admin.page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" && response.url().includes("/_emdash/api/content/"),
			{ timeout: 5000 },
		);
		await admin.page.getByRole("option", { name: nextLanguage }).click();
		await expect(
			controls.getByRole("button", { name: `Set language (current: ${nextLanguage})` }),
		).toBeVisible();
		await autosaveResponse;
		expect(updateRequests).toBe(1);
	});

	test("keeps controls and language search inside a narrow RTL editor", async ({ admin }) => {
		await admin.page.setViewportSize({ width: 320, height: 800 });
		await admin.page.evaluate(() => {
			document.querySelector(".emdash-code-block-node")?.setAttribute("dir", "rtl");
		});
		const codeBlockNode = admin.page.locator(".emdash-code-block-node").first();
		const controls = codeBlockNode.getByRole("toolbar", { name: "Code block actions" });
		await codeBlockNode.hover();
		await expect(controls).toBeVisible();

		const nodeBox = await codeBlockNode.boundingBox();
		const controlsBox = await controls.boundingBox();
		expect(controlsBox?.x).toBeCloseTo((nodeBox?.x ?? 0) + 4, 0);

		await controls.getByRole("button", { name: /^Set language/ }).click();
		const popupBox = await admin.page.locator(".kumo-popover-popup").boundingBox();
		expect(popupBox).not.toBeNull();
		expect(popupBox?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((popupBox?.x ?? 0) + (popupBox?.width ?? 0)).toBeLessThanOrEqual(320);
		expect(popupBox?.width ?? 0).toBeLessThanOrEqual(288);
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

	test("matches the admin controls without saving during control interactions", async ({
		page,
	}) => {
		const codeBlockNode = page.locator(".emdash-inline-code-block").first();
		const controlsWrap = codeBlockNode.locator(".emdash-inline-code-block-controls-wrap");
		const controls = codeBlockNode.getByRole("toolbar", { name: "Code block actions" });
		const languageButton = controls.getByRole("button", { name: /^Set language/ });
		const copyButton = controls.getByRole("button", { name: "Copy code" });
		let updateRequests = 0;
		page.on("request", (request) => {
			if (request.method() === "PUT" && request.url().includes("/_emdash/api/content/")) {
				updateRequests += 1;
			}
		});
		await page.waitForTimeout(2200);
		updateRequests = 0;
		await page.emulateMedia({ colorScheme: "dark" });
		const outsideControlStyle = await page.evaluate(() => {
			const outside = document.createElement("div");
			outside.className = "emdash-inline-code-block-controls-wrap";
			document.body.append(outside);
			const style = getComputedStyle(outside);
			const result = {
				opacity: style.opacity,
				pointerEvents: style.pointerEvents,
				position: style.position,
			};
			outside.remove();
			return result;
		});
		expect(outsideControlStyle).toEqual({
			opacity: "1",
			pointerEvents: "auto",
			position: "static",
		});

		await page.mouse.move(0, 0);
		await page.evaluate(() => {
			if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
		});
		await expect(controlsWrap).toHaveCSS("opacity", "0");
		await languageButton.focus();
		await expect(controlsWrap).toHaveCSS("opacity", "1");
		await codeBlockNode.hover();
		await expect(controlsWrap).toHaveCSS("opacity", "1");
		await expect(controls.getByRole("button")).toHaveCount(2);
		await expect(languageButton).toHaveCSS("font-size", "14px");
		await expect(copyButton).toHaveCSS("font-size", "14px");
		await expect(controls).toHaveCSS("background-color", "rgb(24, 24, 24)");

		const nodeBox = await codeBlockNode.boundingBox();
		const controlsBox = await controls.boundingBox();
		const languageBox = await languageButton.boundingBox();
		const codeText = await codeBlockNode.locator("code").evaluate((element) => {
			const range = document.createRange();
			range.selectNodeContents(element);
			const rects = [...range.getClientRects()];
			return { top: rects[0]?.top, bottom: rects.at(-1)?.bottom };
		});
		expect(nodeBox).not.toBeNull();
		expect(controlsBox).not.toBeNull();
		expect(languageBox?.height).toBe(36);
		expect(controlsBox?.y).toBeCloseTo((nodeBox?.y ?? 0) + 4, 0);
		expect(controlsBox?.x).toBeCloseTo(
			(nodeBox?.x ?? 0) + (nodeBox?.width ?? 0) - (controlsBox?.width ?? 0) - 4,
			0,
		);
		expect(codeText.top ?? 0).toBeLessThan((controlsBox?.y ?? 0) + (controlsBox?.height ?? 0));
		const topGap = (codeText.top ?? 0) - (nodeBox?.y ?? 0);
		const bottomGap = (nodeBox?.y ?? 0) + (nodeBox?.height ?? 0) - (codeText.bottom ?? 0);
		expect(Math.abs(topGap - bottomGap)).toBeLessThanOrEqual(4);

		await languageButton.click();
		await page.mouse.move(0, 0);
		await expect(controlsWrap).toHaveCSS("opacity", "1");
		const input = page.getByPlaceholder("Search for a language…");
		const popup = page.locator(".emdash-inline-code-block-popover");
		await expect(input).toBeVisible();
		await expect(input).toBeFocused();
		await expect(input).toHaveCSS("font-size", "14px");
		await expect(page.getByRole("option", { name: "Plain text" })).toHaveCSS("font-size", "14px");
		const placeholderColor = await input.evaluate(
			(element) => getComputedStyle(element, "::placeholder").color,
		);
		const inputColor = await input.evaluate((element) => getComputedStyle(element).color);
		expect(placeholderColor).not.toBe(inputColor);

		const popupBox = await popup.boundingBox();
		const openControlsBox = await controls.boundingBox();
		const viewportWidth = await page.evaluate(() => window.innerWidth);
		const expectedPopupX = Math.min(
			Math.max(openControlsBox?.x ?? 0, 16),
			viewportWidth - 16 - (popupBox?.width ?? 0),
		);
		expect(popupBox?.x).toBeCloseTo(expectedPopupX, 0);
		const popupBelowGap =
			(popupBox?.y ?? 0) - ((openControlsBox?.y ?? 0) + (openControlsBox?.height ?? 0));
		const popupAboveGap =
			(openControlsBox?.y ?? 0) - ((popupBox?.y ?? 0) + (popupBox?.height ?? 0));
		expect(Math.max(popupBelowGap, popupAboveGap)).toBeCloseTo(8, 0);

		await input.fill("yaml");
		await expect(page.getByRole("option", { name: "YAML" })).toBeVisible();
		await expect
			.poll(async () => {
				const filteredPopupBox = await popup.boundingBox();
				const filteredControlsBox = await controls.boundingBox();
				const filteredBelowGap =
					(filteredPopupBox?.y ?? 0) -
					((filteredControlsBox?.y ?? 0) + (filteredControlsBox?.height ?? 0));
				const filteredAboveGap =
					(filteredControlsBox?.y ?? 0) -
					((filteredPopupBox?.y ?? 0) + (filteredPopupBox?.height ?? 0));
				return Math.max(filteredBelowGap, filteredAboveGap);
			})
			.toBeCloseTo(8, 0);
		await input.fill("");

		await page.keyboard.press("Escape");
		await expect(input).toBeHidden();
		await expect(languageButton).toBeFocused();
		await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
		await copyButton.click();
		await expect(controls.getByRole("button", { name: "Copied" })).toBeVisible();

		await languageButton.click();
		await page.getByRole("option", { name: "Python" }).click();
		await expect(
			controls.getByRole("button", { name: "Set language (current: Python)" }),
		).toBeVisible();
		await page.waitForTimeout(500);
		expect(updateRequests).toBe(0);
	});

	test("keeps inline controls and search inside a narrow RTL viewport", async ({ page }) => {
		await page.setViewportSize({ width: 320, height: 800 });
		await page.evaluate(() => {
			document.querySelector(".emdash-inline-code-block")?.setAttribute("dir", "rtl");
		});
		const codeBlockNode = page.locator(".emdash-inline-code-block").first();
		const controlsWrap = codeBlockNode.locator(".emdash-inline-code-block-controls-wrap");
		const controls = codeBlockNode.getByRole("toolbar", { name: "Code block actions" });
		await codeBlockNode.hover();
		await expect(controlsWrap).toHaveCSS("opacity", "1");

		const nodeBox = await codeBlockNode.boundingBox();
		const controlsBox = await controls.boundingBox();
		expect(controlsBox?.x).toBeCloseTo((nodeBox?.x ?? 0) + 4, 0);

		await controls.getByRole("button", { name: /^Set language/ }).click();
		const popup = page.locator(".emdash-inline-code-block-popover");
		const popupBox = await popup.boundingBox();
		expect(popupBox).not.toBeNull();
		expect(popupBox?.x ?? -1).toBeGreaterThanOrEqual(0);
		expect((popupBox?.x ?? 0) + (popupBox?.width ?? 0)).toBeLessThanOrEqual(320);
		expect(popupBox?.width ?? 0).toBeLessThanOrEqual(288);
		await expect(page.getByPlaceholder("Search for a language…")).toHaveCSS("font-size", "16px");
		await expect(page.getByRole("option", { name: "Plain text" })).toHaveCSS("font-size", "14px");
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
		expect(await editorHandle?.evaluate((element) => element.isConnected)).toBe(true);
		expect(updateRequests).toBe(0);
	});
});

test("keeps inline code controls visible on touch devices", async ({ browser, baseURL }) => {
	if (!baseURL) throw new Error("Playwright baseURL is required");
	const context = await browser.newContext({
		baseURL,
		hasTouch: true,
		viewport: { width: 393, height: 852 },
	});
	try {
		const page = await context.newPage();
		await page.goto("/_emdash/api/auth/dev-bypass?redirect=/");
		await context.addCookies([
			{
				name: "emdash-edit-mode",
				value: "true",
				domain: "localhost",
				path: "/",
			},
		]);
		await page.goto("/posts/post-with-code");
		await expect(page.locator(".emdash-inline-editor")).toBeVisible({ timeout: 15000 });
		const controlsWrap = page
			.locator(".emdash-inline-code-block")
			.first()
			.locator(".emdash-inline-code-block-controls-wrap");
		await expect(controlsWrap).toHaveCSS("opacity", "1");
		await expect(controlsWrap).toHaveCSS("pointer-events", "auto");
	} finally {
		await context.close();
	}
});
