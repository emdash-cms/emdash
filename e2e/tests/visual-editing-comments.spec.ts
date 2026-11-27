/**
 * Editorial comments in the visual editing toolbar: the badges on annotated
 * elements and the comment popover.
 */

import { test, expect } from "../fixtures";

function textBlock(key: string, text: string) {
	return {
		_type: "block",
		_key: key,
		style: "normal",
		markDefs: [],
		children: [{ _type: "span", _key: `${key}s`, text, marks: [] }],
	};
}

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
			data: {
				data: {
					title: "Comment target",
					excerpt: "A short excerpt",
					body: [textBlock("b1", "One fish, two fish."), textBlock("b2", "Red fish, blue fish.")],
				},
				slug,
			},
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

	const INLINE_EDITOR_MODULE_RE =
		/InlinePortableTextEditor|inline-editorial-comments|editorial-editor|EditorialCommentsExtension/;

	/** A module of the inline editor or its comment highlights, by dev path or built chunk name. */
	function isInlineEditorRequest(pathname: string): boolean {
		return INLINE_EDITOR_MODULE_RE.test(pathname);
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
			const editorRequests: string[] = [];
			visitorPage.on("request", (request) => {
				const { pathname } = new URL(request.url());
				if (pathname.startsWith("/_emdash")) emdashRequests.push(request.url());
				if (isInlineEditorRequest(pathname)) editorRequests.push(pathname);
			});

			const response = await visitorPage.goto(`/editorial-comments?slug=${slug}&body`);
			const html = await response!.text();
			await visitorPage.waitForLoadState("networkidle");

			expect(html).not.toContain("emdash-toolbar");
			expect(html).not.toContain("emdash-cm-");
			expect(html).not.toContain("emdash-editorial");
			expect(html).not.toContain("/_emdash/visual-editing/comments");
			expect(emdashRequests).toEqual([]);
			expect(editorRequests).toEqual([]);
			await expect(visitorPage.locator("#body")).toContainText("Red fish, blue fish.");
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
		const editorRequests: string[] = [];
		page.on("request", (request) => {
			if (isCommentsRequest(request.url())) commentRequests.push(request.url());
			const { pathname } = new URL(request.url());
			if (isInlineEditorRequest(pathname)) editorRequests.push(pathname);
		});

		const response = await page.goto(`/editorial-comments?slug=${slug}&body`);
		const html = await response!.text();
		await page.waitForLoadState("networkidle");

		expect(commentRequests).toEqual([]);
		expect(editorRequests).toEqual([]);
		expect(html).not.toContain("emdash-editorial");
		await expect(page.locator(".emdash-cm-trigger, .emdash-inline-editor")).toHaveCount(0);
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

	const BLUE_ANCHOR = {
		type: "text",
		field: "body",
		blockKey: "b2",
		start: 10,
		end: 14,
		quote: "blue",
		prefix: "Red fish, ",
		suffix: " fish.",
	};

	async function addBlueThread(request: import("@playwright/test").APIRequestContext) {
		const response = await request.post(`/_emdash/api/content/posts/${postId}/threads`, {
			headers: { "X-EmDash-Request": "1" },
			data: { anchor: BLUE_ANCHOR, body: "Which blue?" },
		});
		expect(response.ok(), await response.text()).toBe(true);
		return ((await response.json()) as { data: { id: string } }).data.id;
	}

	async function openThreads(request: import("@playwright/test").APIRequestContext) {
		const response = await request.get(`/_emdash/api/content/posts/${postId}/threads?status=open`);
		return ((await response.json()) as { data: { items: Array<{ id: string; anchor: unknown }> } })
			.data.items;
	}

	/** Selects the first occurrence of `text` in the inline editor. */
	async function selectInEditor(page: import("@playwright/test").Page, text: string) {
		await page.evaluate((wanted) => {
			type InlineEditor = {
				state: {
					doc: {
						descendants: (
							visit: (node: { isText: boolean; text?: string }, pos: number) => void,
						) => void;
					};
				};
				chain: () => {
					focus: () => {
						setTextSelection: (range: { from: number; to: number }) => { run: () => boolean };
					};
				};
			};
			const element = document.querySelector(".emdash-inline-editor") as HTMLElement & {
				editor: InlineEditor;
			};
			let from = -1;
			element.editor.state.doc.descendants((node, pos) => {
				if (from !== -1 || !node.isText || !node.text) return;
				const index = node.text.indexOf(wanted);
				if (index !== -1) from = pos + index;
			});
			if (from === -1) throw new Error(`"${wanted}" isn't in the editor`);
			element.editor
				.chain()
				.focus()
				.setTextSelection({ from, to: from + wanted.length })
				.run();
		}, text);
	}

	test("highlights a text thread in the inline editor, and opens it without leaving the editor", async ({
		page,
	}) => {
		const threadId = await addBlueThread(page.request);

		await page.goto(`/editorial-comments?slug=${slug}&body`);

		const highlight = page.locator(".emdash-inline-editor .emdash-editorial-text");
		await expect(highlight).toHaveText("blue");
		await expect(page.getByRole("button", { name: "Comments on Body: 1 open" })).toHaveText("1");

		await highlight.click();
		const dialog = page.getByRole("dialog", { name: "Comments on Body" });
		await expect(dialog).toBeVisible();
		await expect(dialog.locator(".emdash-comments-thread[data-marked]")).toContainText(
			"Which blue?",
		);
		await expect(page.locator(".emdash-inline-editor")).toBeFocused();
		await expect(highlight).toHaveClass(/emdash-editorial-active/);
		await expect(dialog.getByRole("link", { name: "Open in admin" })).toHaveAttribute(
			"href",
			`/_emdash/admin/content/posts/${postId}?thread=${threadId}`,
		);
	});

	test("starts a text thread from a selection in the inline editor", async ({ page }) => {
		await page.goto(`/editorial-comments?slug=${slug}&body`);
		await expect(page.getByRole("button", { name: "Comment on Body" })).toBeAttached();

		await selectInEditor(page, "two fish");
		await page.getByRole("button", { name: "Comment on the selection" }).click();

		const dialog = page.getByRole("dialog", { name: "Comments on Body" });
		await expect(dialog.getByText("On “two fish”")).toBeVisible();
		const textbox = dialog.getByRole("textbox", { name: "Write a comment" });
		await expect(textbox).toBeFocused();
		await textbox.fill("Count again");
		await dialog.getByRole("button", { name: "Comment", exact: true }).click();
		await expect(dialog.locator(".emdash-comments-text")).toHaveText(["Count again"]);
		await expect(dialog.getByText("On “two fish”")).toHaveCount(1);

		const highlight = page.locator(".emdash-inline-editor .emdash-editorial-text");
		await expect(highlight).toHaveText("two fish");
		expect((await openThreads(page.request)).map((thread) => thread.anchor)).toEqual([
			expect.objectContaining({ type: "text", field: "body", blockKey: "b1", quote: "two fish" }),
		]);

		await page.reload();
		await expect(highlight).toHaveText("two fish");
		await expect(page.getByRole("button", { name: "Comments on Body: 1 open" })).toBeAttached();
	});

	test("says why a selection across paragraphs can't take a comment", async ({ page }) => {
		await page.goto(`/editorial-comments?slug=${slug}&body`);
		await expect(page.getByRole("button", { name: "Comment on Body" })).toBeAttached();

		await page.evaluate(() => {
			const element = document.querySelector(".emdash-inline-editor") as HTMLElement & {
				editor: {
					chain: () => {
						focus: () => {
							setTextSelection: (range: { from: number; to: number }) => { run: () => boolean };
						};
					};
				};
			};
			element.editor.chain().focus().setTextSelection({ from: 5, to: 26 }).run();
		});
		await page.getByRole("button", { name: "Comment on the selection" }).click();

		await expect(page.getByRole("status")).toHaveText(
			"Select text within one paragraph to comment on it",
		);
		await expect(page.locator("[data-emdash-comments]")).toHaveCount(0);
	});

	test("moves a thread's anchor when an inline edit moves its text", async ({ page }) => {
		await addBlueThread(page.request);
		await page.goto(`/editorial-comments?slug=${slug}&body`);
		await expect(page.locator(".emdash-inline-editor .emdash-editorial-text")).toHaveText("blue");

		await selectInEditor(page, "Red fish");
		await page.keyboard.press("ArrowLeft");
		await page.keyboard.type("Very ");
		const moved = page.waitForResponse(
			(response) =>
				new URL(response.url()).pathname.endsWith("/threads/anchors") &&
				response.request().method() === "PATCH",
		);
		await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
		expect((await moved).ok()).toBe(true);

		expect((await openThreads(page.request)).map((thread) => thread.anchor)).toEqual([
			{ ...BLUE_ANCHOR, start: 15, end: 19, prefix: "Very Red fish, " },
		]);
		await page.reload();
		await expect(page.locator(".emdash-inline-editor .emdash-editorial-text")).toHaveText("blue");
	});

	test("shows the inline editor's highlights and badge on the start side of a right-to-left page", async ({
		page,
	}) => {
		await addBlueThread(page.request);
		await page.goto(`/editorial-comments?slug=${slug}&body&dir=rtl`);

		await expect(page.locator(".emdash-inline-editor .emdash-editorial-text")).toHaveText("blue");
		const editor = page.locator(".emdash-inline-editor");
		const badge = page.getByRole("button", { name: "Comments on Body: 1 open" });
		await editor.hover();
		await expect(badge).toBeVisible();
		const [editorBox, badgeBox] = await Promise.all([editor.boundingBox(), badge.boundingBox()]);
		expect(badgeBox!.x + badgeBox!.width / 2).toBeLessThan(editorBox!.x + editorBox!.width / 2);

		await selectInEditor(page, "two fish");
		await expect(page.getByRole("button", { name: "Comment on the selection" })).toBeVisible();
	});
});
