/**
 * Editorial comments in the visual editing toolbar: the badges on annotated
 * elements and the comment popover.
 */

import { test, expect } from "../fixtures";

test.describe("Editorial comments in visual editing", () => {
	let headers: Record<string, string>;
	let postId: string;
	let slug: string;

	test.beforeEach(async ({ admin, page, serverInfo }) => {
		await admin.devBypassAuth();
		headers = { Authorization: `Bearer ${serverInfo.token}`, "X-EmDash-Request": "1" };
		slug = `toolbar-comments-${crypto.randomUUID().slice(0, 8)}`;
		const created = await page.request.post("/_emdash/api/content/posts", {
			headers,
			data: { data: { title: "Comment target", excerpt: "A short excerpt" }, slug },
		});
		expect(created.ok(), await created.text()).toBe(true);
		postId = ((await created.json()) as { data: { item: { id: string } } }).data.item.id;
		const published = await page.request.post(`/_emdash/api/content/posts/${postId}/publish`, {
			headers,
			data: {},
		});
		expect(published.ok(), await published.text()).toBe(true);

		await page
			.context()
			.addCookies([{ name: "emdash-edit-mode", value: "true", domain: "localhost", path: "/" }]);
	});

	test.afterEach(async ({ page }) => {
		await page.request.delete(`/_emdash/api/content/posts/${postId}`, { headers });
	});

	async function addThread(
		request: import("@playwright/test").APIRequestContext,
		anchor: { type: "entry" } | { type: "field"; field: string },
	) {
		const response = await request.post(`/_emdash/api/content/posts/${postId}/threads`, {
			headers: { "X-EmDash-Request": "1" },
			data: { anchor, body: "Check this" },
		});
		expect(response.ok(), await response.text()).toBe(true);
	}

	function addTitleThread(request: import("@playwright/test").APIRequestContext) {
		return addThread(request, { type: "field", field: "title" });
	}

	type Box = { x: number; y: number; width: number; height: number };

	function overlaps(a: Box, b: Box): boolean {
		return (
			a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height
		);
	}

	async function tabUntilFocused(page: import("@playwright/test").Page, name: string) {
		const focusedNames: string[] = [];
		for (let presses = 0; presses < 40; presses++) {
			await page.keyboard.press("Tab");
			const focused = await page.evaluate(() => {
				const element = document.activeElement;
				return element?.classList.contains("emdash-cm-trigger")
					? element.getAttribute("aria-label")
					: null;
			});
			if (focused) focusedNames.push(focused);
			if (focused === name) return focusedNames;
		}
		throw new Error(`Tab never reached "${name}"; reached ${JSON.stringify(focusedNames)}`);
	}

	function isCommentsRequest(url: string): boolean {
		const { pathname } = new URL(url);
		return (
			pathname.endsWith("/threads") ||
			pathname === "/_emdash/visual-editing/comments" ||
			pathname.includes("EditorialCommentsPopover")
		);
	}

	test("adds nothing to the page for a logged-out visitor, even with the edit mode cookie", async ({
		browser,
		page,
	}) => {
		await addTitleThread(page.request);
		const visitor = await browser.newContext();
		try {
			await visitor.addCookies([
				{ name: "emdash-edit-mode", value: "true", domain: "localhost", path: "/" },
			]);
			const visitorPage = await visitor.newPage();
			const emdashRequests: string[] = [];
			visitorPage.on("request", (request) => {
				if (new URL(request.url()).pathname.startsWith("/_emdash"))
					emdashRequests.push(request.url());
			});

			const response = await visitorPage.goto(`/editorial-comments?slug=${slug}`);
			const html = await response!.text();
			await visitorPage.waitForLoadState("networkidle");

			expect(html).not.toContain("emdash-toolbar");
			expect(html).not.toContain("emdash-cm-");
			expect(html).not.toContain("/_emdash/visual-editing/comments");
			expect(emdashRequests).toEqual([]);
			await expect(visitorPage.locator(".emdash-cm-trigger, [data-emdash-comments]")).toHaveCount(
				0,
			);
		} finally {
			await visitor.close();
		}
	});

	test("loads no threads for a signed-in editor with edit mode off", async ({ page }) => {
		await addTitleThread(page.request);
		await page.context().clearCookies({ name: "emdash-edit-mode" });
		const commentRequests: string[] = [];
		page.on("request", (request) => {
			if (isCommentsRequest(request.url())) commentRequests.push(request.url());
		});

		await page.goto(`/editorial-comments?slug=${slug}`);
		await page.waitForLoadState("networkidle");

		expect(commentRequests).toEqual([]);
		await expect(page.locator(".emdash-cm-trigger")).toHaveCount(0);
	});

	test("loads only the thread counts until a badge is opened", async ({ page }) => {
		await addTitleThread(page.request);
		const commentRequests: string[] = [];
		page.on("request", (request) => {
			if (isCommentsRequest(request.url())) commentRequests.push(new URL(request.url()).pathname);
		});

		await page.goto(`/editorial-comments?slug=${slug}`);
		await expect(page.getByRole("button", { name: "Comments on Title: 1 open" })).toBeVisible();
		await page.locator("#title").hover();
		await page.waitForLoadState("networkidle");

		expect(commentRequests).toEqual([`/_emdash/api/content/posts/${postId}/threads`]);
		await expect(page.locator(".emdash-inline-ui, [data-emdash-comments]")).toHaveCount(0);
	});

	test("badges a field with open threads, and replies to and resolves them in its popover", async ({
		page,
	}) => {
		const me = await page.request.get("/_emdash/api/auth/me");
		const user = ((await me.json()) as { data: { id: string; name: string } }).data;
		const threadResponse = await page.request.post(`/_emdash/api/content/posts/${postId}/threads`, {
			headers: { "X-EmDash-Request": "1" },
			data: {
				anchor: { type: "field", field: "title" },
				body: `Can <@${user.id}> check this <b>title</b>?`,
			},
		});
		expect(threadResponse.ok(), await threadResponse.text()).toBe(true);
		const threadId = ((await threadResponse.json()) as { data: { id: string } }).data.id;

		await page.goto(`/editorial-comments?slug=${slug}`);

		const badge = page.getByRole("button", { name: "Comments on Title: 1 open" });
		await expect(badge).toBeVisible();
		await expect(badge).toHaveText("1");

		await page.locator("#excerpt").hover();
		await expect(page.getByRole("button", { name: "Comment on Excerpt" })).toBeVisible();

		// The popover comes from the island on this page, through the toolbar's
		// fetch and import(). A change to Astro's island markup fails here.
		const islandPage = page.waitForResponse(
			(response) => new URL(response.url()).pathname === "/_emdash/visual-editing/comments",
		);
		await badge.click();
		const islandResponse = await islandPage;
		expect(islandResponse.status()).toBe(200);
		expect(islandResponse.headers()["cache-control"]).toBe("private, no-store");
		const dialog = page.getByRole("dialog", { name: "Comments on Title" });
		await expect(dialog).toBeFocused();
		await expect(dialog.locator(".emdash-comments-text")).toHaveText(
			`Can @${user.name} check this <b>title</b>?`,
		);
		await expect(dialog.getByRole("link", { name: "Open in admin" })).toHaveAttribute(
			"href",
			`/_emdash/admin/content/posts/${postId}?thread=${threadId}`,
		);

		const reply = dialog.getByRole("textbox", { name: "Write a reply" });
		await reply.fill("Fixed the title");
		await dialog.getByRole("button", { name: "Reply" }).click();
		await expect(dialog.locator(".emdash-comments-text")).toHaveText([
			`Can @${user.name} check this <b>title</b>?`,
			"Fixed the title",
		]);
		await expect(dialog.getByRole("textbox", { name: "Write a reply" })).toBeFocused();

		await dialog.getByRole("button", { name: "Resolve" }).click();
		await expect(dialog.getByText("No open comments")).toBeVisible();
		await expect(dialog).toBeFocused();

		await page.keyboard.press("Escape");
		await expect(dialog).toBeHidden();
		const control = page.getByRole("button", { name: "Comment on Title" });
		await expect(control).toBeFocused();

		const remaining = await page.request.get(
			`/_emdash/api/content/posts/${postId}/threads?status=open`,
		);
		expect(((await remaining.json()) as { data: { items: unknown[] } }).data.items).toEqual([]);
	});

	test("refuses the popover's island page without a session, and never lets caches keep it", async ({
		request,
	}) => {
		const response = await request.get("/_emdash/visual-editing/comments");
		expect(response.status()).toBe(401);
		expect(response.headers()["cache-control"]).toBe("private, no-store");
		expect(await response.text()).not.toContain("astro-island");
	});

	test("starts an entry thread from the keyboard and keeps its badge after a reload", async ({
		page,
	}) => {
		await page.goto(`/editorial-comments?slug=${slug}`);
		await expect(page.locator(".emdash-cm-trigger")).not.toHaveCount(0);

		// Editing a field puts focus in it, which shows its comment button
		// even once the pointer has left.
		const title = page.locator("#title");
		const titleControl = page.getByRole("button", { name: "Comment on Title" });
		await expect(titleControl).toHaveCSS("opacity", "0");
		await title.click();
		await expect(title).toBeFocused();
		await page.mouse.move(0, 0);
		await expect(titleControl).toHaveCSS("opacity", "1");

		const reached = await tabUntilFocused(page, "Comment on this entry");
		expect(reached).toEqual(["Comment on this entry"]);
		const control = page.getByRole("button", { name: "Comment on this entry" });
		await expect(control).toBeVisible();
		await page.keyboard.press("Tab");
		await expect(page.getByRole("button", { name: "Comment on Title" })).toBeFocused();
		await page.keyboard.press("Shift+Tab");
		await expect(control).toBeFocused();
		await page.keyboard.press("Enter");

		const dialog = page.getByRole("dialog", { name: "Comments on this entry" });
		await expect(dialog).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(dialog.getByRole("button", { name: "Close" })).toBeFocused();
		await page.keyboard.press("Tab");
		await expect(dialog.getByRole("textbox", { name: "Write a comment" })).toBeFocused();
		await page.keyboard.type("Ready for review");
		await page.keyboard.press("Tab");
		await expect(dialog.getByRole("button", { name: "Comment", exact: true })).toBeFocused();
		await page.keyboard.press("Enter");

		await expect(dialog.locator(".emdash-comments-text")).toHaveText(["Ready for review"]);
		await expect(
			page.getByRole("button", { name: "Comments on this entry: 1 open" }),
		).toBeVisible();

		const threads = await page.request.get(`/_emdash/api/content/posts/${postId}/threads`);
		const items = ((await threads.json()) as { data: { items: Array<{ anchor: unknown }> } }).data
			.items;
		expect(items.map((item) => item.anchor)).toEqual([{ type: "entry" }]);

		await page.reload();
		await expect(page.getByRole("button", { name: "Comments on this entry: 1 open" })).toHaveText(
			"1",
		);
	});

	test("puts the control and popover on the start side of a right-to-left page", async ({
		page,
	}) => {
		await page.goto(`/editorial-comments?slug=${slug}&dir=rtl`);

		const title = page.locator("#title");
		await title.hover();
		const control = page.getByRole("button", { name: "Comment on Title" });
		await control.click();

		const dialog = page.getByRole("dialog", { name: "Comments on Title" });
		await expect(dialog).toBeVisible();
		await expect(dialog).toHaveCSS("direction", "rtl");
		// Measure once the entrance animation, which scales the popover, has finished.
		await dialog.evaluate((element) =>
			Promise.all(element.getAnimations().map((animation) => animation.finished)),
		);
		const [titleBox, controlBox, dialogBox, headingBox, closeBox] = await Promise.all([
			title.boundingBox(),
			control.boundingBox(),
			dialog.boundingBox(),
			dialog.getByRole("heading", { name: "Comments on Title" }).boundingBox(),
			dialog.getByRole("button", { name: "Close" }).boundingBox(),
		]);
		// In right-to-left text the title starts, and its control sits, on the left.
		expect(Math.abs(controlBox!.x + controlBox!.width / 2 - titleBox!.x)).toBeLessThan(2);
		expect(Math.abs(dialogBox!.x - controlBox!.x)).toBeLessThan(2);
		expect(closeBox!.x).toBeLessThan(headingBox!.x);
	});

	test("hides the badges of elements that are hidden from the start or after layout", async ({
		page,
	}) => {
		await addThread(page.request, { type: "field", field: "theme_color" });
		await addThread(page.request, { type: "field", field: "event" });
		await page.goto(`/editorial-comments?slug=${slug}`);

		const eventBadge = page.getByRole("button", { name: "Comments on Event: 1 open" });
		await expect(eventBadge).toBeVisible();
		const hiddenBadge = page.getByRole("button", {
			name: "Comments on Theme Color: 1 open",
			includeHidden: true,
		});
		await expect(hiddenBadge).toHaveCount(1);
		await expect(hiddenBadge).toBeHidden();

		await page.locator("#event").evaluate((element) => {
			element.style.display = "none";
		});
		await expect(eventBadge).toBeHidden();
	});

	for (const dir of ["ltr", "rtl"] as const) {
		test(`hides a badge while its element is scrolled out of a container, and puts it back on the element (${dir})`, async ({
			page,
		}) => {
			await addThread(page.request, { type: "field", field: "featured_image" });
			await page.goto(`/editorial-comments?slug=${slug}&dir=${dir}`);
			const badge = page.getByRole("button", {
				name: "Comments on Featured Image: 1 open",
				includeHidden: true,
			});
			const scroller = page.locator("#scroller");
			const element = page.locator("#featured-image");
			const scrollTo = (top: number) =>
				scroller.evaluate((container, value) => {
					container.scrollTop = value;
				}, top);

			await expect(badge).toBeAttached();
			await expect(badge).toBeHidden();

			// The element's top edge, where the badge sits, is in view; its bottom isn't.
			await scrollTo(300);
			await expect(badge).toBeVisible();
			await expect
				.poll(async () => {
					const [elementBox, badgeBox] = await Promise.all([
						element.boundingBox(),
						badge.boundingBox(),
					]);
					const corner = dir === "rtl" ? elementBox!.x : elementBox!.x + elementBox!.width;
					return [
						Math.abs(Math.round(badgeBox!.y + badgeBox!.height / 2 - elementBox!.y)),
						Math.abs(Math.round(badgeBox!.x + badgeBox!.width / 2 - corner)),
					];
				})
				.toEqual([0, 0]);

			await badge.click();
			const dialog = page.getByRole("dialog", { name: "Comments on Featured Image" });
			await expect(dialog).toBeVisible();

			await scrollTo(800);
			await expect(badge).toBeHidden();
			await expect(dialog).toBeHidden();
			await expect(badge).toHaveAttribute("aria-expanded", "false");
			await scrollTo(360);
			await expect(badge).toBeVisible();
		});
	}

	for (const dir of ["ltr", "rtl"] as const) {
		test(`keeps both badges visible and clickable when an entry and its first field share a corner (${dir})`, async ({
			page,
		}) => {
			await addThread(page.request, { type: "entry" });
			await addTitleThread(page.request);
			await page.goto(`/editorial-comments?slug=${slug}&flush&dir=${dir}`);

			const [articleBox, titleBox] = await Promise.all([
				page.locator("#post").boundingBox(),
				page.locator("#title").boundingBox(),
			]);
			expect(Math.round(articleBox!.y)).toBe(Math.round(titleBox!.y));

			const entryBadge = page.getByRole("button", { name: "Comments on this entry: 1 open" });
			const titleBadge = page.getByRole("button", { name: "Comments on Title: 1 open" });
			await expect(entryBadge).toBeVisible();
			await expect(titleBadge).toBeVisible();
			const [entryBox, titleBadgeBox] = await Promise.all([
				entryBadge.boundingBox(),
				titleBadge.boundingBox(),
			]);
			expect(overlaps(entryBox!, titleBadgeBox!)).toBe(false);

			await titleBadge.click();
			await expect(page.getByRole("dialog", { name: "Comments on Title" })).toBeVisible();
			await page.keyboard.press("Escape");
			await entryBadge.click();
			await expect(page.getByRole("dialog", { name: "Comments on this entry" })).toBeVisible();
		});
	}
});
