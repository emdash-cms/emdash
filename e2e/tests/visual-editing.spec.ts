/**
 * Visual Editing / Inline Editor E2E Tests
 *
 * Tests the inline TipTap editor for portable text fields:
 * - Image rendering in static mode (Image.astro)
 * - Inline editor loading with image nodes
 * - Slash commands and media picker
 * - Save on image insert
 * - Click-to-edit of plain text fields
 */

import { test, expect } from "../fixtures";

const MEDIA_FILE_PATTERN = /\/_emdash\/api\/media\/file\/.+\.\w+/;
const IMAGE_BUTTON_PATTERN = /Image/;

// The seeded post with an image block has slug "post-with-image"
const POST_WITH_IMAGE_PATH = "/posts/post-with-image";

/**
 * Navigate to a page, retrying if Astro's dev server shows a compilation error.
 * This handles the transient "No cached compile metadata" race condition.
 */
async function gotoWithRetry(
	page: import("@playwright/test").Page,
	url: string,
	maxRetries = 3,
): Promise<void> {
	for (let i = 0; i < maxRetries; i++) {
		await page.goto(url);
		await page.waitForLoadState("domcontentloaded");

		// Check if the page has an Astro error overlay
		const hasError = await page.locator("text=An error occurred").count();
		if (hasError === 0) return;

		// Wait and retry — Astro needs time to compile virtual modules
		await page.waitForTimeout(2000);
	}
}

/**
 * Enable visual editing mode by setting the edit-mode cookie
 * and authenticating via dev bypass.
 */
async function enableEditMode(page: import("@playwright/test").Page): Promise<void> {
	// Authenticate first (sets session cookie)
	await page.goto("/_emdash/api/setup/dev-bypass?redirect=/");
	await page.waitForLoadState("networkidle");

	// Set the edit mode cookie
	await page.context().addCookies([
		{
			name: "emdash-edit-mode",
			value: "true",
			domain: "localhost",
			path: "/",
		},
	]);
}

/** Answers the editor's saves without storing them, so the seeded post stays as it was. */
async function stubSaves(page: import("@playwright/test").Page): Promise<void> {
	await page.route("**/_emdash/api/content/**", (route) =>
		route.request().method() === "PUT"
			? route.fulfill({ status: 200, contentType: "application/json", body: '{"data":{}}' })
			: route.continue(),
	);
}

type InlineEditorDom = HTMLElement & {
	editor: {
		state: {
			doc: {
				descendants: (
					visit: (
						node: { type: { name: string }; textContent: string; nodeSize: number },
						pos: number,
					) => boolean,
				) => void;
			};
			selection: { from: number };
		};
		commands: {
			focus: () => boolean;
			setTextSelection: (position: number | { from: number; to: number }) => boolean;
			splitBlock: () => boolean;
			insertContent: (value: string) => boolean;
			setLink: (attributes: { href: string }) => boolean;
		};
	};
};

/**
 * Selects the first word of the first paragraph, or with `newLine` puts the
 * caret on a new empty line after that paragraph, through the editor's API.
 */
async function placeSelection(
	page: import("@playwright/test").Page,
	mode: "firstWord" | "newLine",
): Promise<void> {
	await page.evaluate((selection) => {
		const { editor } = document.querySelector(".emdash-inline-editor") as InlineEditorDom;
		let paragraph: { pos: number; size: number; word: number } | undefined;
		editor.state.doc.descendants((node, pos) => {
			if (!paragraph && node.type.name === "paragraph" && node.textContent) {
				paragraph = { pos, size: node.nodeSize, word: node.textContent.indexOf(" ") };
			}
			return !paragraph;
		});
		if (!paragraph) throw new Error("No paragraph to select in");
		editor.commands.focus();
		if (selection === "firstWord") {
			editor.commands.setTextSelection({
				from: paragraph.pos + 1,
				to: paragraph.pos + 1 + paragraph.word,
			});
		} else {
			editor.commands.setTextSelection(paragraph.pos + paragraph.size - 1);
			editor.commands.splitBlock();
		}
	}, mode);
	// TipTap focuses the editor a frame later, and keys pressed before then go elsewhere.
	await expect(page.locator(".emdash-inline-editor")).toBeFocused();
}

/** Waits for an element's own animations, such as its entrance, to finish. */
async function animationsFinished(locator: import("@playwright/test").Locator): Promise<void> {
	await locator.evaluate((element) =>
		Promise.allSettled(element.getAnimations().map((animation) => animation.finished)),
	);
}

/**
 * How far the point the first element matching `selector` grows from moves
 * while it appears. Scaled around its transform origin, that point stays
 * put; scaled around anywhere else, the element slides as it grows.
 */
async function measureEntranceDrift(
	page: import("@playwright/test").Page,
	selector: string,
	appear: () => Promise<void>,
): Promise<number> {
	type Sampling = { frames: Array<{ x: number; y: number }>; done: boolean };
	await page.evaluate((target) => {
		const sampling: Sampling = { frames: [], done: false };
		(window as unknown as { __entrance: Sampling }).__entrance = sampling;
		const sample = () => {
			if (sampling.done) return;
			const element = document.querySelector(target);
			const style = element && getComputedStyle(element);
			if (element && style?.visibility === "visible") {
				// Starts the entrance over, so the first sample is its first frame however late this one is.
				if (sampling.frames.length === 0) {
					for (const animation of element.getAnimations()) animation.currentTime = 0;
				}
				const rect = element.getBoundingClientRect();
				const scale = rect.width / Number.parseFloat(style.width);
				const [originX = 0, originY = 0] = style.transformOrigin
					.split(" ")
					.map((value) => Number.parseFloat(value));
				sampling.frames.push({ x: rect.left + scale * originX, y: rect.top + scale * originY });
			}
			requestAnimationFrame(sample);
		};
		requestAnimationFrame(sample);
	}, selector);
	await appear();
	const element = page.locator(selector).first();
	await expect(element).toBeVisible();
	await animationsFinished(element);
	// The sampler's next frame runs first, so the last sample is the settled element.
	const frames = await page.evaluate(
		() =>
			new Promise<Sampling["frames"]>((resolve) => {
				requestAnimationFrame(() => {
					const sampling = (window as unknown as { __entrance: Sampling }).__entrance;
					sampling.done = true;
					resolve(sampling.frames);
				});
			}),
	);
	expect(frames.length).toBeGreaterThan(0);
	const last = frames.at(-1)!;
	return Math.max(...frames.map((frame) => Math.hypot(frame.x - last.x, frame.y - last.y)));
}

test.describe("Image Rendering (Static)", () => {
	test("renders image block with correct src URL", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		// The Image.astro component renders a <figure class="emdash-image"> with an <img>
		const figure = page.locator("figure.emdash-image");
		await expect(figure).toBeVisible({ timeout: 10000 });

		const img = figure.locator("img");
		await expect(img).toBeVisible();

		// The src should resolve to the media file endpoint (not a bare ULID).
		// With responsive optimization the src may be Astro's image-service URL
		// (`/_image?href=…` on Node, `/cdn-cgi/image/…` on Cloudflare) that
		// encodes the media file URL, so decode before matching.
		const src = await img.getAttribute("src");
		expect(src).toBeTruthy();
		expect(decodeURIComponent(src!)).toMatch(MEDIA_FILE_PATTERN);

		// Alt text should be set
		const alt = await img.getAttribute("alt");
		expect(alt).toBe("Test image");
	});

	test("renders text blocks around the image", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const body = page.locator("#body");
		await expect(body).toBeVisible({ timeout: 10000 });

		// Should contain the text paragraphs
		await expect(body.locator("text=Text before image.")).toBeVisible();
		await expect(body.locator("text=Text after image.")).toBeVisible();
	});
});

test.describe("Inline Editor", () => {
	test.beforeEach(async ({ page }) => {
		await enableEditMode(page);
	});

	test("PT editor shows up in visual editing mode", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// The island failed to hydrate with zero height when highlight.js/lib/core
		// was served raw as CommonJS, so also assert some static content rendered
		// inside the editor rather than disappearing.
		const box = await editor.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.height).toBeGreaterThan(0);
		await expect(editor.locator("text=Text before image.")).toBeVisible();
		await expect(editor.locator("text=Text after image.")).toBeVisible();
	});

	test("loads without crashing on posts with image blocks", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		// The inline editor renders as a .emdash-inline-editor div (TipTap's editorProps class)
		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// Should contain the text content (not crash with RangeError)
		await expect(editor.locator("text=Text before image.")).toBeVisible();
		await expect(editor.locator("text=Text after image.")).toBeVisible();

		// Should render the image node (TipTap Image extension)
		const img = editor.locator("img");
		await expect(img).toBeVisible();
	});

	test("shows slash menu on / keystroke", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// Click into the editor to focus, then type /
		await editor.locator("p").first().click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("/");

		// Slash menu should appear
		const slashMenu = page.locator(".emdash-slash-menu");
		await expect(slashMenu).toBeVisible({ timeout: 5000 });

		// Should have the Image command — use role to avoid matching the description text
		await expect(slashMenu.getByRole("button", { name: IMAGE_BUTTON_PATTERN })).toBeVisible();
	});

	test("lines the selection toolbar's menus up with the toolbar's edges", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);
		await expect(page.locator(".emdash-inline-editor")).toBeVisible({ timeout: 15000 });
		// Holds the toolbar at the start of its entrance, so Turn into opens while it rises.
		await page.evaluate(() => {
			const animate = Element.prototype.animate;
			Element.prototype.animate = function (
				this: Element,
				...args: Parameters<Element["animate"]>
			) {
				const animation = animate.apply(this, args);
				if (this.matches('[role="toolbar"][aria-label="Format selection"]')) {
					Element.prototype.animate = animate;
					animation.pause();
					(window as unknown as { __toolbarHeld: boolean }).__toolbarHeld = true;
				}
				return animation;
			};
		});
		await placeSelection(page, "firstWord");
		await expect
			.poll(() =>
				page.evaluate(() => (window as unknown as { __toolbarHeld?: boolean }).__toolbarHeld),
			)
			.toBe(true);
		const toolbar = page.getByRole("toolbar", { name: "Format selection" });
		const menu = page.getByRole("menu");

		await toolbar.getByRole("button", { name: "Turn into" }).click();
		await expect(menu).toBeVisible();
		await animationsFinished(menu);
		const opened = (await menu.boundingBox())!;
		await toolbar.evaluate((element) => {
			for (const animation of element.getAnimations()) animation.finish();
		});
		const bar = (await toolbar.boundingBox())!;
		const turnInto = (await menu.boundingBox())!;
		expect(Math.abs(turnInto.x - opened.x)).toBeLessThan(1);
		expect(Math.abs(turnInto.x - bar.x)).toBeLessThan(1);

		await page.keyboard.press("Escape");
		await expect(menu).toBeHidden();
		await toolbar.getByRole("button", { name: "More formatting" }).click();
		await expect(menu).toBeVisible();
		await animationsFinished(menu);
		const more = (await menu.boundingBox())!;
		expect(Math.abs(more.x + more.width - (bar.x + bar.width))).toBeLessThan(1);
	});

	test("lines the toolbars up with the selection's right edge on a right-to-left page", async ({
		page,
	}) => {
		await stubSaves(page);
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);
		await expect(page.locator(".emdash-inline-editor")).toBeVisible({ timeout: 15000 });
		await page.evaluate(() => {
			document.documentElement.dir = "rtl";
		});
		await placeSelection(page, "newLine");
		// A line long enough that the toolbar fits inside it whichever edge it lines up with.
		await page.evaluate(() => {
			const { editor } = document.querySelector(".emdash-inline-editor") as InlineEditorDom;
			editor.commands.insertContent(
				"Some words that make a line long enough to hold the whole toolbar",
			);
			const end = editor.state.selection.from;
			editor.commands.setTextSelection({ from: end - "toolbar".length, to: end });
		});
		const toolbar = page.getByRole("toolbar", { name: "Format selection" });
		await expect(toolbar).toBeVisible();
		await animationsFinished(toolbar);
		const selectionRight = await page.evaluate(
			() => window.getSelection()!.getRangeAt(0).getBoundingClientRect().right,
		);
		const bar = (await toolbar.boundingBox())!;
		expect(Math.abs(bar.x + bar.width - selectionRight)).toBeLessThan(1);

		// Links the selected word, then moves the caret into it from outside, so the
		// link bar first shows in the same update that gives it the link's address.
		const linkStart = await page.evaluate(() => {
			const { editor } = document.querySelector(".emdash-inline-editor") as InlineEditorDom;
			const { from } = editor.state.selection;
			editor.commands.setLink({ href: "https://example.com/rtl" });
			editor.commands.setTextSelection(from - 5);
			return from;
		});
		await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
		await page.evaluate((start) => {
			const { editor } = document.querySelector(".emdash-inline-editor") as InlineEditorDom;
			editor.commands.setTextSelection(start + 2);
		}, linkStart);
		const linkBar = page.getByRole("toolbar", { name: "Link options" });
		await expect(linkBar).toBeVisible();
		await animationsFinished(linkBar);
		const link = page.locator('.emdash-inline-editor a[href="https://example.com/rtl"]');
		// The bar is placed again at its rendered width in a later task.
		await expect
			.poll(async () => {
				const [linkBarBox, linkBox] = await Promise.all([
					linkBar.boundingBox(),
					link.boundingBox(),
				]);
				return Math.abs(linkBarBox!.x + linkBarBox!.width - (linkBox!.x + linkBox!.width));
			})
			.toBeLessThan(1);
	});

	test("keeps the link bar under the start of its link", async ({ page }) => {
		await stubSaves(page);
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);
		await expect(page.locator(".emdash-inline-editor")).toBeVisible({ timeout: 15000 });
		await placeSelection(page, "firstWord");
		const toolbar = page.getByRole("toolbar", { name: "Format selection" });
		await toolbar.getByRole("button", { name: "Add link" }).click();
		await toolbar.getByRole("textbox", { name: "Link URL" }).fill("https://example.com");
		await page.keyboard.press("Enter");
		const link = page.locator('.emdash-inline-editor a[href="https://example.com"]');
		await expect(link).toBeVisible();
		await expect(page.locator(".emdash-inline-editor")).toBeFocused();

		const linkBar = page.getByRole("toolbar", { name: "Link options" });
		const offsets: number[] = [];
		for (const key of ["ArrowLeft", "ArrowLeft", "ArrowLeft"]) {
			await page.keyboard.press(key);
			await expect(linkBar).toBeVisible();
			await animationsFinished(linkBar);
			const [bar, linked] = await Promise.all([linkBar.boundingBox(), link.boundingBox()]);
			offsets.push(bar!.x - linked!.x);
		}
		for (const offset of offsets) expect(Math.abs(offset)).toBeLessThan(1);
	});

	test("shows a tooltip or menu reopened while it fades out", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);
		await expect(page.locator(".emdash-inline-editor")).toBeVisible({ timeout: 15000 });
		await placeSelection(page, "firstWord");
		const toolbar = page.getByRole("toolbar", { name: "Format selection" });
		await expect(toolbar).toBeVisible();

		const italic = toolbar.getByRole("button", { name: "Italic" });
		const tooltip = page.locator(".emdash-inline-ui-tooltip");
		await italic.hover();
		await expect(tooltip).toBeVisible();
		const button = (await italic.boundingBox())!;
		await page.mouse.move(button.x + button.width / 2, button.y + button.height + 40);
		await page.mouse.move(button.x + button.width / 2, button.y + button.height / 2);
		await expect(tooltip).toBeVisible();
		await expect(tooltip).toHaveAttribute("data-status", "open");

		const turnInto = toolbar.getByRole("button", { name: "Turn into" });
		const menu = page.getByRole("menu");
		await turnInto.click();
		await expect(menu).toBeVisible();
		// Closes the menu, then opens it again a task later, while it fades out.
		await turnInto.evaluate(async (trigger: HTMLElement) => {
			trigger.click();
			await new Promise((resolve) => setTimeout(resolve, 0));
			trigger.click();
		});
		await expect(menu).toBeVisible();
		await expect(menu).toHaveAttribute("data-status", "open");
	});

	test("opens the slash menu, toolbar menus, and tooltips in place", async ({ page }) => {
		await stubSaves(page);
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);
		await expect(page.locator(".emdash-inline-editor")).toBeVisible({ timeout: 15000 });
		const maxDrift = 1;

		await placeSelection(page, "newLine");
		const slashDrift = await measureEntranceDrift(page, ".emdash-slash-menu", () =>
			page.keyboard.type("/"),
		);
		expect(slashDrift).toBeLessThan(maxDrift);
		await page.keyboard.press("Escape");

		await placeSelection(page, "firstWord");
		const toolbar = page.getByRole("toolbar", { name: "Format selection" });
		await expect(toolbar).toBeVisible();
		const menuDrift = await measureEntranceDrift(page, '[role="menu"]', () =>
			toolbar.getByRole("button", { name: "Turn into" }).click(),
		);
		expect(menuDrift).toBeLessThan(maxDrift);
		await page.keyboard.press("Escape");

		const tooltipDrift = await measureEntranceDrift(page, ".emdash-inline-ui-tooltip", () =>
			toolbar.getByRole("button", { name: "Italic" }).hover(),
		);
		expect(tooltipDrift).toBeLessThan(maxDrift);
	});

	test.fixme("slash menu does not scroll page to top", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// Inject extra height so the page is scrollable
		await page.evaluate(() => {
			const spacer = document.createElement("div");
			spacer.style.height = "2000px";
			document.body.appendChild(spacer);
		});

		// Scroll down a bit first to have a non-zero scroll position
		await page.evaluate(() => window.scrollTo(0, 200));
		await page.waitForTimeout(100);
		const scrollBefore = await page.evaluate(() => window.scrollY);
		expect(scrollBefore).toBeGreaterThan(0);

		// Focus editor and type /
		await editor.locator("p").last().click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("/");

		const slashMenu = page.locator(".emdash-slash-menu");
		await expect(slashMenu).toBeVisible({ timeout: 5000 });

		// Scroll position should not have jumped to top
		const scrollAfter = await page.evaluate(() => window.scrollY);
		// Allow some tolerance (e.g. +-20px for natural scroll adjustments)
		expect(scrollAfter).toBeGreaterThan(scrollBefore - 20);
	});

	test("/image command opens media picker", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// Type /image to filter to the Image command
		await editor.locator("p").first().click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("/image");

		const slashMenu = page.locator(".emdash-slash-menu");
		await expect(slashMenu).toBeVisible({ timeout: 5000 });

		// Click the Image command (or press Enter to select it)
		await page.keyboard.press("Enter");

		// Media picker should open
		const picker = page.locator(".emdash-media-picker");
		await expect(picker).toBeVisible({ timeout: 5000 });

		// Should show "Insert Image" title
		await expect(picker.locator("text=Insert Image")).toBeVisible();
	});

	test("refuses file drop and paste without losing edits or breaking image insertion", async ({
		page,
	}) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		await editor.locator("p").last().click();
		await page.keyboard.press("End");
		await page.keyboard.type(" SafeTransferEdits");

		const dropResult = await editor.evaluate((element) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(["image"], "drop.png", { type: "image/png" }));
			const dragEnter = new DragEvent("dragenter", {
				bubbles: true,
				cancelable: true,
				dataTransfer: transfer,
			});
			const dragEnterDispatched = element.dispatchEvent(dragEnter);
			const dragOver = new DragEvent("dragover", {
				bubbles: true,
				cancelable: true,
				dataTransfer: transfer,
			});
			const dragOverDispatched = element.dispatchEvent(dragOver);
			const event = new DragEvent("drop", {
				bubbles: true,
				cancelable: true,
				dataTransfer: transfer,
			});
			const dispatched = element.dispatchEvent(event);
			return {
				dragEnterDefaultPrevented: dragEnter.defaultPrevented,
				dragEnterDispatched,
				dragOverDefaultPrevented: dragOver.defaultPrevented,
				dragOverDispatched,
				defaultPrevented: event.defaultPrevented,
				dispatched,
				fileCount: event.dataTransfer?.files.length,
				itemCount: event.dataTransfer?.items.length,
				itemKind: event.dataTransfer?.items[0]?.kind,
			};
		});

		expect(dropResult).toEqual({
			dragEnterDefaultPrevented: true,
			dragEnterDispatched: false,
			dragOverDefaultPrevented: true,
			dragOverDispatched: false,
			defaultPrevented: true,
			dispatched: false,
			fileCount: 1,
			itemCount: 1,
			itemKind: "file",
		});
		await expect(editor).toContainText("SafeTransferEdits");
		const guidance = page.getByRole("status");
		await expect(guidance).toContainText("Type /image");
		const firstGuidance = await guidance.elementHandle();
		expect(firstGuidance).not.toBeNull();

		const pasteResult = await editor.evaluate((element) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(["document"], "paste.pdf", { type: "application/pdf" }));
			const event = new ClipboardEvent("paste", { bubbles: true, cancelable: true });
			Object.defineProperty(event, "clipboardData", { value: transfer });
			const dispatched = element.dispatchEvent(event);
			return { defaultPrevented: event.defaultPrevented, dispatched };
		});

		expect(pasteResult).toEqual({ defaultPrevented: true, dispatched: false });
		await expect(editor).toContainText("SafeTransferEdits");
		await expect(guidance).toContainText("Type /image");
		expect(await firstGuidance!.evaluate((element) => element.isConnected)).toBe(false);

		await editor.locator("p").last().click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("/image");
		await page.keyboard.press("Enter");
		await expect(page.locator(".emdash-media-picker")).toBeVisible({ timeout: 5000 });
	});

	test("shows file-transfer guidance in Arabic with RTL direction", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });
		await page.evaluate(() => {
			document.documentElement.lang = "ar";
			document.documentElement.dir = "rtl";
		});

		await editor.evaluate((element) => {
			const transfer = new DataTransfer();
			transfer.items.add(new File(["image"], "drop.png", { type: "image/png" }));
			element.dispatchEvent(
				new DragEvent("drop", {
					bubbles: true,
					cancelable: true,
					dataTransfer: transfer,
				}),
			);
		});

		const guidance = page.locator(".emdash-inline-editor-guidance");
		await expect(guidance).toHaveText(
			"لا يمكن إفلات الملفات أو لصقها هنا. اكتب /image لاختيار صورة من مكتبة الوسائط.",
		);
		expect(await guidance.evaluate((element) => getComputedStyle(element).direction)).toBe("rtl");
	});

	test("media picker shows uploaded images", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// Open media picker via slash command
		await editor.locator("p").first().click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("/image");
		await page.keyboard.press("Enter");

		const picker = page.locator(".emdash-media-picker");
		await expect(picker).toBeVisible({ timeout: 5000 });

		// Should show at least one image (the seeded test-image.png)
		// Wait for loading to finish — the picker shows "Loading…" then the count
		await expect(picker.getByText("Loading…").first()).toBeHidden({ timeout: 10000 });

		// Grid should have at least one image thumbnail
		const images = picker.locator("img");
		const count = await images.count();
		expect(count).toBeGreaterThan(0);
	});

	test("selecting image from picker inserts it and triggers save", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// Count existing images in editor
		const initialImageCount = await editor.locator("img").count();

		// Open media picker via slash command
		await editor.locator("p").first().click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("/image");
		await page.keyboard.press("Enter");

		const picker = page.locator(".emdash-media-picker");
		await expect(picker).toBeVisible({ timeout: 5000 });

		// Wait for images to load
		await expect(picker.getByText("Loading…").first()).toBeHidden({ timeout: 10000 });

		// Click the first image in the grid to select it
		const firstThumb = picker
			.locator("button")
			.filter({ has: page.locator("img") })
			.first();
		await firstThumb.click();

		// Set up response listener for the save request before clicking Insert
		const savePromise = page.waitForResponse(
			(res) => res.url().includes("/api/content/posts/") && res.request().method() === "PUT",
			{ timeout: 10000 },
		);

		// Click Insert button
		const insertButton = picker.locator("button", { hasText: "Insert" });
		await expect(insertButton).toBeVisible();
		await insertButton.click();

		// Picker should close
		await expect(picker).toBeHidden({ timeout: 3000 });

		// A new image should appear in the editor
		const newImageCount = await editor.locator("img").count();
		expect(newImageCount).toBeGreaterThan(initialImageCount);

		// Save should have been triggered
		const saveResponse = await savePromise;
		expect(saveResponse.ok()).toBe(true);
	});

	test("media picker can be closed with cancel", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// Open media picker
		await editor.locator("p").first().click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("/image");
		await page.keyboard.press("Enter");

		const picker = page.locator(".emdash-media-picker");
		await expect(picker).toBeVisible({ timeout: 5000 });

		// Click Cancel
		const cancelButton = picker.locator("button", { hasText: "Cancel" });
		await cancelButton.click();

		// Picker should close
		await expect(picker).toBeHidden({ timeout: 3000 });
	});

	test("flushes unsaved edits when navigating away (#1582)", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// Type into the editor and do NOT blur — the only save trigger
		// used to be the blur handler, so browser-back lost the edit.
		await editor.locator("p").last().click();
		await page.keyboard.press("End");
		await page.keyboard.type(" Repro1582");

		// waitForRequest, not waitForResponse: the keepalive PUT outlives the
		// page, and Playwright never delivers response events for a page that
		// has navigated away — waiting for the response times out even when
		// the save succeeds.
		const savePromise = page.waitForRequest(
			(req) => req.url().includes("/api/content/posts/") && req.method() === "PUT",
			{ timeout: 10000 },
		);

		// Browser back: no React blur fires, only pagehide.
		await page.goBack();

		// The pagehide flush must fire a keepalive PUT…
		await savePromise;

		// …and the server must persist it. Poll the rendered page instead of
		// reloading immediately: on slow runners the PUT may still be in
		// flight when the request event fires.
		await expect
			.poll(async () => (await page.request.get(POST_WITH_IMAGE_PATH)).text(), {
				timeout: 10000,
			})
			.toContain("Repro1582");

		// The edit must survive a fresh load of the post.
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);
		const reloadedEditor = page.locator(".emdash-inline-editor");
		await expect(reloadedEditor).toBeVisible({ timeout: 15000 });
		await expect(reloadedEditor.locator("text=Repro1582")).toBeVisible();
	});

	test("media picker can be closed with X button", async ({ page }) => {
		await gotoWithRetry(page, POST_WITH_IMAGE_PATH);

		const editor = page.locator(".emdash-inline-editor");
		await expect(editor).toBeVisible({ timeout: 15000 });

		// Open media picker
		await editor.locator("p").first().click();
		await page.keyboard.press("End");
		await page.keyboard.press("Enter");
		await page.keyboard.type("/image");
		await page.keyboard.press("Enter");

		const picker = page.locator(".emdash-media-picker");
		await expect(picker).toBeVisible({ timeout: 5000 });

		// Click the close (X) button
		const closeButton = picker.locator('button[aria-label="Close"]');
		await closeButton.click();

		// Picker should close
		await expect(picker).toBeHidden({ timeout: 3000 });
	});
});

/**
 * A point a quarter into the character at `index` of a field's text (negative
 * counts from the end), where a click puts the caret right before it.
 */
function positionBeforeCharacter(field: import("@playwright/test").Locator, index: number) {
	return field.evaluate((element, at) => {
		const text = element.firstChild!;
		const start = at < 0 ? text.textContent!.length + at : at;
		const range = document.createRange();
		range.setStart(text, start);
		range.setEnd(text, start + 1);
		const character = range.getBoundingClientRect();
		const box = element.getBoundingClientRect();
		return {
			x: character.left - box.left + character.width / 4,
			y: character.top - box.top + character.height / 2,
		};
	}, index);
}

test.describe("Text field editing", () => {
	test.beforeEach(async ({ page }) => {
		await enableEditMode(page);
		await gotoWithRetry(page, "/text-fields");
	});

	for (const { name, selector } of [
		{ name: "a text field", selector: "#excerpt" },
		{ name: "a text field inside a link", selector: "#linked-title" },
	]) {
		test(`places the caret where ${name} is clicked`, async ({ page }) => {
			const field = page.locator(selector);
			const text = (await field.textContent())!;

			await field.click({ position: await positionBeforeCharacter(field, -1) });
			await expect(field).toHaveAttribute("data-emdash-editing", "");
			await page.keyboard.type("X");

			await expect(field).toHaveText(`${text.slice(0, -1)}X${text.slice(-1)}`);
			// Discard the edit so the seeded post stays unchanged.
			await page.keyboard.press("Escape");
		});
	}

	test("keeps text selected by dragging across a text field", async ({ page }) => {
		const field = page.locator("#excerpt");
		const text = (await field.textContent())!;

		await field.dragTo(field, {
			sourcePosition: await positionBeforeCharacter(field, 1),
			targetPosition: await positionBeforeCharacter(field, -1),
		});
		await expect(field).toHaveAttribute("data-emdash-editing", "");
		await page.keyboard.type("X");

		await expect(field).toHaveText(`${text[0]}X${text.slice(-1)}`);
		await page.keyboard.press("Escape");
	});
});
