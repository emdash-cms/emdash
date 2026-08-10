/**
 * Visual Editing / Inline Editor E2E Tests
 *
 * Tests the inline TipTap editor for portable text fields:
 * - Image rendering in static mode (Image.astro)
 * - Inline editor loading with image nodes
 * - Slash commands and media picker
 * - Save on image insert
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
