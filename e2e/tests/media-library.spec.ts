/**
 * Media Library E2E Tests
 *
 * Tests uploading, viewing, and deleting media files.
 * Runs against an isolated fixture — starts with no media.
 */

import { writeFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import type { Locator, Page } from "@playwright/test";

import { test, expect, type ServerInfo } from "../fixtures";

// Create a test image for uploads
const TEST_ASSETS_DIR = join(process.cwd(), "e2e/fixtures/assets");

// Regex patterns
const MEDIA_API_RESPONSE_PATTERN = /\/api\/media/;
const UPLOAD_BUTTON_REGEX = /Upload/;
const BROWSE_FILES_LABEL = "Browse files to upload";
const CROP_TEST_PNG = Buffer.from(
	"iVBORw0KGgoAAAANSUhEUgAAACgAAAAUCAYAAAD/Rn+7AAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAOklEQVR4nO2WsQ0AAAjC+v/T9QkSlw6uxBCFIrgctnLOFWlBctBu0J7EYsaC2prEuthggXDLgNVvoj5sbjobLqOjWwAAAABJRU5ErkJggg==",
	"base64",
);

function ensureTestAssets(): string {
	if (!existsSync(TEST_ASSETS_DIR)) {
		mkdirSync(TEST_ASSETS_DIR, { recursive: true });
	}

	// Create a simple test PNG (1x1 red pixel)
	const testImagePath = join(TEST_ASSETS_DIR, "test-image.png");
	if (!existsSync(testImagePath)) {
		// Minimal valid PNG file (1x1 red pixel)
		const pngData = Buffer.from([
			0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44,
			0x52, 0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x02, 0x00, 0x00, 0x00, 0x90,
			0x77, 0x53, 0xde, 0x00, 0x00, 0x00, 0x0c, 0x49, 0x44, 0x41, 0x54, 0x08, 0xd7, 0x63, 0xf8,
			0xcf, 0xc0, 0x00, 0x00, 0x00, 0x03, 0x00, 0x01, 0x00, 0x05, 0xfe, 0xd4, 0xef, 0x00, 0x00,
			0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82,
		]);
		writeFileSync(testImagePath, pngData);
	}

	return testImagePath;
}

async function uploadTestImage(page: Page, filename?: string) {
	const testImagePath = ensureTestAssets();
	await page.getByRole("button", { name: UPLOAD_BUTTON_REGEX }).first().click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();

	const uploadResponse = page.waitForResponse(
		(res) =>
			MEDIA_API_RESPONSE_PATTERN.test(res.url()) &&
			res.request().method() === "POST" &&
			res.status() === 200,
		{ timeout: 10000 },
	);
	await dialog.getByLabel(BROWSE_FILES_LABEL).setInputFiles(
		filename
			? {
					name: filename,
					mimeType: "image/png",
					buffer: Buffer.concat([readFileSync(testImagePath), Buffer.from(filename)]),
				}
			: testImagePath,
	);
	await uploadResponse;
	await expect(dialog.getByText("Complete", { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
}

async function uploadCropTestImage(page: Page, filename: string) {
	await page.getByRole("button", { name: UPLOAD_BUTTON_REGEX }).first().click();
	const dialog = page.getByRole("dialog");
	await expect(dialog).toBeVisible();
	await dialog.getByLabel(BROWSE_FILES_LABEL).setInputFiles({
		name: filename,
		mimeType: "image/png",
		buffer: CROP_TEST_PNG,
	});
	await expect(dialog.getByText("Complete", { exact: true })).toBeVisible();
	await dialog.getByRole("button", { name: "Done" }).click();
	await expect(dialog).not.toBeVisible();
}

async function apiJson<T>(
	serverInfo: ServerInfo,
	path: string,
	init: RequestInit = {},
): Promise<T> {
	const headers = new Headers(init.headers);
	headers.set("Authorization", `Bearer ${serverInfo.token}`);
	headers.set("Origin", serverInfo.baseUrl);
	headers.set("X-EmDash-Request", "1");
	if (init.body) headers.set("Content-Type", "application/json");
	const response = await fetch(`${serverInfo.baseUrl}${path}`, {
		...init,
		headers,
	});
	if (!response.ok) throw new Error(`${init.method ?? "GET"} ${path} failed: ${response.status}`);
	const body = (await response.json()) as { data: T };
	return body.data;
}

interface CropTestMediaItem {
	id: string;
	filename: string;
	storageKey: string;
	url: string;
	width: number;
	height: number;
	contentHash: string | null;
}

async function findMediaByFilename(
	serverInfo: ServerInfo,
	filename: string,
): Promise<CropTestMediaItem> {
	const result = await apiJson<{ items: CropTestMediaItem[] }>(
		serverInfo,
		`/_emdash/api/media?q=${encodeURIComponent(filename)}&limit=100`,
	);
	const item = result.items.find((candidate) => candidate.filename === filename);
	if (!item) throw new Error(`Media not found: ${filename}`);
	return item;
}

async function fetchUncachedBytes(serverInfo: ServerInfo, url: string): Promise<Uint8Array> {
	const uncached = new URL(url, serverInfo.baseUrl);
	uncached.searchParams.set("e2e", crypto.randomUUID());
	const response = await fetch(uncached);
	if (!response.ok) throw new Error(`Media download failed: ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

async function createFolder(page: Page, name: string) {
	await page.getByRole("button", { name: "Add new folder" }).click();
	const dialog = page.getByRole("dialog", { name: "Add new folder" });
	await dialog.getByLabel("Name").fill(name);
	await dialog.getByRole("button", { name: "Create" }).click();
	await expect(dialog).not.toBeVisible();
}

async function pointerDrag(page: Page, source: Locator, target: Locator) {
	const sourceBox = await source.boundingBox();
	const targetBox = await target.boundingBox();
	if (!sourceBox || !targetBox) throw new Error("Drag source or target is not visible");
	const sourcePoint = {
		x: sourceBox.x + sourceBox.width / 2,
		y: sourceBox.y + sourceBox.height / 2,
	};
	const targetPoint = {
		x: targetBox.x + targetBox.width / 2,
		y: targetBox.y + targetBox.height / 2,
	};
	await page.mouse.move(sourcePoint.x, sourcePoint.y);
	await page.mouse.down();
	await page.mouse.move(sourcePoint.x + 12, sourcePoint.y, { steps: 2 });
	await page.mouse.move(targetPoint.x, targetPoint.y, { steps: 8 });
	const overlayCard = page.locator("[data-media-drag-overlay] > *");
	await overlayCard.waitFor();
	const overlayBox = await overlayCard.boundingBox();
	if (!overlayBox) throw new Error("Drag overlay is not visible");
	expect(Math.abs(overlayBox.x + overlayBox.width / 2 - targetPoint.x)).toBeLessThanOrEqual(4);
	expect(Math.abs(overlayBox.y + overlayBox.height / 2 - targetPoint.y)).toBeLessThanOrEqual(4);
	await page.mouse.up();
}

async function expectFolderColumns(cards: Locator, expectedColumns: number) {
	await expect(cards).toHaveCount(4);
	const columnCount = await cards.first().evaluate((element) => {
		return getComputedStyle(element.parentElement!).gridTemplateColumns.trim().split(/\s+/).length;
	});
	expect(columnCount).toBe(expectedColumns);
}

test.describe("Media Library", () => {
	test.beforeAll(() => {
		ensureTestAssets();
	});

	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.describe("Media List", () => {
		test("displays media library page", async ({ admin }) => {
			await admin.goToMedia();
			await admin.waitForLoading();

			// Should show the media library heading
			await admin.expectPageTitle("Media Library");

			// Should have upload button
			await expect(
				admin.page.getByRole("button", { name: UPLOAD_BUTTON_REGEX }).first(),
			).toBeVisible();
		});

		test("shows grid view by default", async ({ admin, page }) => {
			await admin.goToMedia();
			await admin.waitForLoading();
			await uploadTestImage(page);

			// Grid view tab should be active
			const gridTab = admin.page.getByRole("tab", { name: "Grid view" });
			await expect(gridTab).toBeVisible();
			await expect(gridTab).toHaveAttribute("aria-selected", "true");
		});

		test("shows view toggle tabs", async ({ admin, page }) => {
			await admin.goToMedia();
			await admin.waitForLoading();
			await uploadTestImage(page);

			await expect(admin.page.getByRole("tab", { name: "Grid view" })).toBeVisible();
			await expect(admin.page.getByRole("tab", { name: "List view" })).toBeVisible();
		});
	});

	test.describe("Upload Media", () => {
		test("uploads a new image file", async ({ admin, page }) => {
			await admin.goToMedia();
			await admin.waitForLoading();

			// Upload file
			await uploadTestImage(page);

			// Wait for the uploaded image to appear in the media grid
			const mediaGrid = page.locator("[data-media-grid]");
			await expect(mediaGrid.locator("img").first()).toBeVisible({ timeout: 5000 });

			// Should have at least one image in the grid now
			const images = mediaGrid.locator("img");
			const count = await images.count();
			expect(count).toBeGreaterThan(0);
		});
	});

	test("crops a referenced image in place and creates a distinct cropped copy", async ({
		admin,
		page,
		serverInfo,
	}) => {
		test.setTimeout(150_000);
		const marker = Date.now();
		const filename = `crop-source-${marker}.png`;
		const duplicateFilename = `crop-source-${marker}-square.png`;
		const slug = `crop-reference-${marker}`;
		await admin.goToMedia();
		await admin.waitForLoading();
		await uploadCropTestImage(page, filename);

		const original = await findMediaByFilename(serverInfo, filename);
		const originalBytes = await fetchUncachedBytes(serverInfo, original.url);
		const created = await apiJson<{ item: { id: string } }>(
			serverInfo,
			"/_emdash/api/content/posts",
			{
				method: "POST",
				body: JSON.stringify({
					slug,
					data: {
						title: "Crop reference",
						excerpt: "Content snapshot used by the crop test",
						body: [
							{
								_type: "image",
								_key: "crop-image",
								asset: { _ref: original.id, url: original.url },
								alt: "Crop test image",
								width: original.width,
								height: original.height,
							},
						],
					},
				}),
			},
		);
		await apiJson(serverInfo, `/_emdash/api/content/posts/${created.item.id}/publish`, {
			method: "POST",
			body: "{}",
		});
		const contentBefore = await apiJson<{ item: Record<string, unknown> }>(
			serverInfo,
			`/_emdash/api/content/posts/${created.item.id}`,
		);

		await page.getByRole("button", { name: filename, exact: true }).click();
		const details = page.getByRole("dialog", { name: "Media details" });
		await details.getByRole("tab", { name: "Edit image" }).click();
		const previewColumn = details.getByTestId("media-detail-dialog-preview-column");
		await details.getByRole("tab", { name: "Crop" }).click();
		await expect(
			details.getByRole("group", { name: "Crop selection. Use the Arrow keys to move it." }),
		).toBeVisible();
		const corner = details.getByRole("button", { name: "Resize crop from bottom-right corner" });
		await corner.press("Shift+ArrowLeft");
		await expect(details.getByRole("button", { name: "Replace original" })).toBeEnabled();

		await details.getByRole("button", { name: "Replace original" }).click();
		const replaceConfirm = page.getByRole("alertdialog", { name: "Replace original image?" });
		const replaceResponse = page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				new URL(response.url()).pathname.endsWith(`/_emdash/api/media/${original.id}/replace`),
		);
		await replaceConfirm.getByRole("button", { name: "Replace original" }).click();
		const replacedHttp = await replaceResponse;
		const replacedBody = (await replacedHttp.json()) as {
			data: { item: CropTestMediaItem };
			error?: { code: string; message: string };
		};
		expect(replacedHttp.status(), JSON.stringify(replacedBody.error)).toBe(200);
		const replaced = replacedBody.data.item;
		expect(replaced).toMatchObject({
			id: original.id,
			storageKey: original.storageKey,
			url: original.url,
		});
		expect(replaced.width).toBeLessThan(original.width);
		expect(replaced.height).toBeLessThan(original.height);
		const replacedBytes = await fetchUncachedBytes(serverInfo, replaced.url);
		expect(replacedBytes).not.toEqual(originalBytes);
		expect(await apiJson(serverInfo, `/_emdash/api/content/posts/${created.item.id}`)).toEqual(
			contentBefore,
		);
		await expect(page.getByText("Original image cropped.")).toBeAttached();
		await details.getByRole("tab", { name: "Details" }).click();
		const refreshedPreview = previewColumn.locator("img").first();
		await expect
			.poll(() => refreshedPreview.evaluate((image) => image.naturalWidth))
			.toBe(replaced.width);
		await expect(refreshedPreview).toHaveAttribute(
			"src",
			new RegExp(encodeURIComponent(replaced.contentHash!)),
		);
		await details.getByRole("tab", { name: "Edit image" }).click();

		const aspectRatio = details.getByRole("combobox", { name: "Aspect ratio" });
		await aspectRatio.click();
		await page.getByRole("option", { name: "Square (1:1)" }).click();
		await expect(details.getByRole("button", { name: "Replace original" })).toBeDisabled();
		const duplicateResponse = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname.endsWith("/confirm") &&
				response.status() === 200,
		);
		const duplicateAction = details.getByRole("button", { name: "Create cropped copy" });
		await expect(duplicateAction).toBeEnabled();
		await duplicateAction.click();
		await duplicateResponse;
		await expect(page.getByRole("heading", { name: "Cropped copy created." })).toBeVisible();
		await expect(details).not.toBeVisible();

		const duplicate = await findMediaByFilename(serverInfo, duplicateFilename);
		expect(duplicate.id).not.toBe(original.id);
		expect(duplicate.storageKey).not.toBe(original.storageKey);
		expect(duplicate.width).toBe(duplicate.height);
		const duplicateCardImage = page
			.getByRole("button", { name: duplicateFilename, exact: true })
			.locator("img");
		await expect(duplicateCardImage).toBeVisible();
		expect(await fetchUncachedBytes(serverInfo, original.url)).toEqual(replacedBytes);
		expect(await apiJson(serverInfo, `/_emdash/api/content/posts/${created.item.id}`)).toEqual(
			contentBefore,
		);

		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/_emdash" }]);
		await page.setViewportSize({ width: 320, height: 800 });
		await page.reload();
		await admin.waitForLoading();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await page.locator('input[type="search"]').fill(filename);
		await page.getByRole("button", { name: filename, exact: true }).click();
		const narrowDetails = page.getByRole("dialog").filter({ hasText: filename });
		await narrowDetails.getByRole("tab", { name: "Edit image" }).click();
		await narrowDetails.getByRole("tab", { name: "Crop" }).click();
		await expect(narrowDetails.getByRole("button", { name: "Create cropped copy" })).toBeVisible();
		expect(
			await narrowDetails.evaluate((element) => element.scrollWidth <= element.clientWidth),
		).toBe(true);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
	});

	test.describe("List View", () => {
		test("shows file details in list view", async ({ admin, page }) => {
			// Upload a file first so there's something to show
			await admin.goToMedia();
			await admin.waitForLoading();

			await uploadTestImage(page);
			await page.reload();
			await admin.waitForLoading();

			// Switch to list view
			await page.getByRole("tab", { name: "List view" }).click();

			// Should show table with columns
			await expect(page.locator("th:has-text('Filename')")).toBeVisible();
			await expect(page.locator("th:has-text('Type')")).toBeVisible();
			await expect(page.locator("th:has-text('Size')")).toBeVisible();
		});

		test("keeps bounded folder states inside the mixed table", async ({ admin, page }) => {
			test.setTimeout(60_000);
			let releaseFolders: () => void = () => {};
			const folderGate = new Promise<void>((resolve) => {
				releaseFolders = resolve;
			});
			const folderPattern = "**/_emdash/api/media/folders?**";
			await page.route(folderPattern, async (route) => {
				if (route.request().method() !== "GET") return route.continue();
				await folderGate;
				await route.continue();
			});

			await admin.goToMedia();
			await expect(page.getByRole("heading", { name: "Media Library" })).toBeVisible();
			await page.getByRole("tab", { name: "List view" }).click();
			const table = page.getByRole("table");
			const loadingRow = table.getByRole("row").filter({ hasText: "Loading folders" });
			await expect(loadingRow).toBeVisible();
			await expect(loadingRow.locator("td")).toHaveAttribute("colspan", "5");

			releaseFolders();
			await expect(loadingRow).not.toBeVisible();
			await page.unroute(folderPattern);
			const folderName = `List folder ${Date.now()}`;
			await createFolder(page, folderName);

			await page.route(folderPattern, async (route) => {
				if (route.request().method() !== "GET") return route.continue();
				const url = new URL(route.request().url());
				if (url.searchParams.has("cursor")) {
					await route.fulfill({
						status: 500,
						contentType: "application/json",
						body: JSON.stringify({
							success: false,
							error: { code: "TEST_ERROR", message: "Later folder page failed" },
						}),
					});
					return;
				}
				const response = await route.fetch();
				const body = (await response.json()) as {
					data: { nextCursor?: string };
				};
				body.data.nextCursor = "forced-next-page";
				await route.fulfill({ response, json: body });
			});
			await page.reload();
			const listTab = page.getByRole("tab", { name: "List view" });
			if ((await listTab.getAttribute("aria-selected")) !== "true") await listTab.click();
			await expect(page.getByRole("heading", { name: "Folders" })).toHaveCount(0);
			const folderLink = page.getByRole("link", { name: `Open folder ${folderName}` });
			const editFolder = page.getByRole("button", { name: `Edit folder ${folderName}` });
			await expect(folderLink).toBeVisible();
			const folderLinkBox = await folderLink.boundingBox();
			const editFolderBox = await editFolder.boundingBox();
			expect(folderLinkBox).not.toBeNull();
			expect(editFolderBox).not.toBeNull();
			expect(editFolderBox!.x - (folderLinkBox!.x + folderLinkBox!.width)).toBeLessThanOrEqual(8);

			await page.getByRole("button", { name: "Load more folders" }).click();
			const rows = table.locator("tbody > tr");
			await expect(table.getByRole("alert")).toHaveText("Folders could not be loaded.");
			await page.setViewportSize({ width: 320, height: 800 });
			await expect(table.getByRole("button", { name: "Retry" })).toBeVisible();
			expect(
				await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
			).toBe(true);
			const rowText = await rows.allTextContents();
			const folderIndex = rowText.findIndex((text) => text.includes(folderName));
			const errorIndex = rowText.findIndex((text) => text.includes("Folders could not be loaded."));
			const loadMoreIndex = rowText.findIndex((text) => text.includes("Load more folders"));
			expect(folderIndex).toBeGreaterThanOrEqual(0);
			expect(errorIndex).toBeGreaterThan(folderIndex);
			expect(loadMoreIndex).toBeGreaterThan(errorIndex);
			expect(loadMoreIndex).toBeLessThan(rowText.length - 1);
			await page.unroute(folderPattern);
			await page.reload();
			await page.getByRole("button", { name: `Edit folder ${folderName}` }).click();
			const editDialog = page.getByRole("dialog", { name: "Edit folder" });
			await editDialog.getByRole("button", { name: "Delete folder" }).click();
			const confirmDelete = page.getByRole("dialog", { name: `Delete “${folderName}”?` });
			await confirmDelete.getByRole("button", { name: "Delete folder" }).click();
			await expect(confirmDelete).not.toBeVisible();
			await expect(page.getByRole("link", { name: `Open folder ${folderName}` })).toHaveCount(0);
		});
	});

	test("moves one local media item into a visible folder by dragging", async ({ admin, page }) => {
		test.setTimeout(90_000);
		await page.setViewportSize({ width: 1512, height: 982 });
		await admin.goToMedia();
		await admin.waitForLoading();
		const uniqueFilename = `drag-source-${Date.now()}.png`;
		await uploadTestImage(page, uniqueFilename);

		const gridFolderName = `Grid drop ${Date.now()}`;
		await createFolder(page, gridFolderName);
		const grid = page.locator("[data-media-grid]");
		const gridSource = grid.getByRole("button", { name: uniqueFilename, exact: true });
		const originalImage = gridSource.locator("img");
		await expect(originalImage).toBeVisible();
		const originalSrc = await originalImage.getAttribute("src");
		expect(originalSrc).not.toBeNull();
		const originalMediaUrl =
			new URL(originalSrc!, page.url()).searchParams.get("href") ?? originalSrc!;
		const originalImageSelector = `img[src=${JSON.stringify(originalSrc)}]`;
		const gridTarget = page
			.getByRole("link", { name: `Open folder ${gridFolderName}` })
			.locator("xpath=ancestor::*[@data-media-folder-card][1]");
		const gridMoveResponse = page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				new URL(response.url()).pathname.includes("/_emdash/api/media/") &&
				response.status() === 200,
		);

		await pointerDrag(page, gridSource, gridTarget);
		await gridMoveResponse;
		await expect(page).toHaveURL(/\/_emdash\/admin\/media\/?$/);
		await expect(page.getByRole("dialog", { name: "Media details" })).toHaveCount(0);
		await expect(grid.locator(originalImageSelector)).toHaveCount(0);
		await page.getByRole("link", { name: `Open folder ${gridFolderName}` }).click();
		await expect(grid.locator(originalImageSelector)).toBeVisible();
		const movedGridSrc = await grid.locator(originalImageSelector).getAttribute("src");
		expect(new URL(movedGridSrc!, page.url()).searchParams.get("href") ?? movedGridSrc).toBe(
			originalMediaUrl,
		);
		await page.getByRole("link", { name: "Back" }).click();
		await page.getByRole("button", { name: `Edit folder ${gridFolderName}` }).click();
		let editDialog = page.getByRole("dialog", { name: "Edit folder" });
		await editDialog.getByRole("button", { name: "Delete folder" }).click();
		let confirmDelete = page.getByRole("dialog", { name: `Delete “${gridFolderName}”?` });
		await confirmDelete.getByRole("button", { name: "Delete folder" }).click();
		await expect(grid.locator(originalImageSelector)).toBeVisible();

		const listFolderName = `List drop ${Date.now()}`;
		await createFolder(page, listFolderName);
		await page.getByRole("tab", { name: "List view" }).click();
		const table = page.getByRole("table");
		const listSource = table.getByRole("row").filter({ hasText: uniqueFilename });
		const listTarget = page
			.getByRole("link", { name: `Open folder ${listFolderName}` })
			.locator("xpath=ancestor::tr[1]");
		const listMoveResponse = page.waitForResponse(
			(response) =>
				response.request().method() === "PUT" &&
				new URL(response.url()).pathname.includes("/_emdash/api/media/") &&
				response.status() === 200,
		);

		await pointerDrag(page, listSource, listTarget);
		await listMoveResponse;
		await expect(page).toHaveURL(/\/_emdash\/admin\/media\/?$/);
		await expect(table.getByRole("row").filter({ hasText: uniqueFilename })).toHaveCount(0);
		await page.getByRole("link", { name: `Open folder ${listFolderName}` }).click();
		const movedListRow = table.getByRole("row").filter({ hasText: uniqueFilename });
		await expect(movedListRow).toBeVisible();
		const movedListSrc = await movedListRow.locator("img").getAttribute("src");
		expect(new URL(movedListSrc!, page.url()).searchParams.get("href") ?? movedListSrc).toBe(
			originalMediaUrl,
		);
		await page.getByRole("link", { name: "Back" }).click();
		await page.getByRole("button", { name: `Edit folder ${listFolderName}` }).click();
		editDialog = page.getByRole("dialog", { name: "Edit folder" });
		await editDialog.getByRole("button", { name: "Delete folder" }).click();
		confirmDelete = page.getByRole("dialog", { name: `Delete “${listFolderName}”?` });
		await confirmDelete.getByRole("button", { name: "Delete folder" }).click();
		await expect(table.getByRole("row").filter({ hasText: uniqueFilename })).toBeVisible();

		await table.getByRole("row").filter({ hasText: uniqueFilename }).click();
		const details = page.getByRole("dialog", { name: "Media details" });
		await details.getByRole("button", { name: "Delete" }).click();
		const confirmMediaDelete = page.getByRole("alertdialog", { name: "Delete media?" });
		await confirmMediaDelete.getByRole("button", { name: "Delete" }).click();
		await expect(details).not.toBeVisible();
		await expect(table.getByRole("row").filter({ hasText: uniqueFilename })).toHaveCount(0);
	});

	test("matches the compact responsive folder layout and mixed-direction names", async ({
		admin,
		page,
	}) => {
		test.setTimeout(60_000);
		const folderMarker = crypto.randomUUID();
		const longFolderName = `Campaign assets with a deliberately long folder name ${folderMarker}`;
		await admin.goToMedia();
		await admin.waitForLoading();
		await createFolder(page, `Archive ${folderMarker}`);
		await createFolder(page, longFolderName);
		await createFolder(page, `Events ${folderMarker}`);
		await createFolder(page, `Press ${folderMarker}`);
		const createdFolderCards = page
			.locator("[data-media-folder-card]")
			.filter({ hasText: folderMarker });

		const folderIconContrast = () =>
			page
				.locator("[data-media-folder-card] svg")
				.first()
				.evaluate((element) => {
					const canvas = document.createElement("canvas");
					canvas.width = 1;
					canvas.height = 1;
					const context = canvas.getContext("2d");
					if (!context) throw new Error("Canvas context unavailable");
					const toRgb = (color: string) => {
						context.clearRect(0, 0, 1, 1);
						context.fillStyle = color;
						context.fillRect(0, 0, 1, 1);
						return context.getImageData(0, 0, 1, 1).data;
					};
					const luminance = (rgb: Uint8ClampedArray) => {
						const toLinear = (channel: number) => {
							const value = channel / 255;
							return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
						};
						return (
							0.2126 * toLinear(rgb[0] ?? 0) +
							0.7152 * toLinear(rgb[1] ?? 0) +
							0.0722 * toLinear(rgb[2] ?? 0)
						);
					};
					const foreground = luminance(toRgb(getComputedStyle(element).color));
					const background = luminance(
						toRgb(getComputedStyle(element.parentElement!).backgroundColor),
					);
					return (
						(Math.max(foreground, background) + 0.05) / (Math.min(foreground, background) + 0.05)
					);
				});

		await page.evaluate(() => localStorage.setItem("emdash-theme", "light"));
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("data-mode", "light");
		expect(await folderIconContrast()).toBeGreaterThanOrEqual(3);
		await page.evaluate(() => localStorage.setItem("emdash-theme", "dark"));
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("data-mode", "dark");
		expect(await folderIconContrast()).toBeGreaterThanOrEqual(3);
		await page.evaluate(() => localStorage.setItem("emdash-theme", "system"));
		await page.reload();

		for (const [width, columns] of [
			[640, 1],
			[800, 2],
			[1100, 3],
			[1400, 4],
		] as const) {
			await page.setViewportSize({ width, height: 900 });
			await expectFolderColumns(createdFolderCards, columns);
		}

		await page.setViewportSize({ width: 1512, height: 982 });
		expect(
			await page
				.locator("[data-media-folder-card]")
				.first()
				.evaluate((element) => element.getBoundingClientRect().height),
		).toBeLessThanOrEqual(72);
		const hoverCard = page.locator("[data-media-folder-card]").first();
		const hoverLink = hoverCard.getByRole("link");
		const hoverEdit = hoverCard.getByRole("button", { name: /Edit folder/ });
		const initialFolderBackground = await hoverCard.evaluate(
			(element) => getComputedStyle(element).backgroundColor,
		);
		await hoverLink.hover();
		expect(
			await hoverCard.evaluate((element) => getComputedStyle(element).backgroundColor),
		).not.toBe(initialFolderBackground);
		await hoverEdit.hover();
		expect(
			await hoverEdit.evaluate((button) => {
				const rect = button.getBoundingClientRect();
				const top = document.elementFromPoint(
					rect.left + rect.width / 2,
					rect.top + rect.height / 2,
				);
				return top === button || button.contains(top);
			}),
		).toBe(true);

		await page.setViewportSize({ width: 320, height: 800 });
		const mediaTitleBox = await page
			.getByRole("heading", { name: "Media Library", level: 1 })
			.boundingBox();
		const addFolderBox = await page.getByRole("button", { name: "Add new folder" }).boundingBox();
		const uploadFilesBox = await page.getByRole("button", { name: "Upload Files" }).boundingBox();
		const searchBox = await page.getByRole("searchbox", { name: "Search media" }).boundingBox();
		const typeFilterBox = await page
			.getByRole("combobox", { name: "Filter by type" })
			.boundingBox();
		const viewModeBox = await page.getByRole("group", { name: "View mode" }).boundingBox();
		const mediaGridBox = await page.locator("[data-media-grid]").boundingBox();
		const mediaCardBox = await page.locator("[data-media-grid] > button").first().boundingBox();
		expect(mediaTitleBox).not.toBeNull();
		expect(addFolderBox).not.toBeNull();
		expect(uploadFilesBox).not.toBeNull();
		expect(searchBox).not.toBeNull();
		expect(typeFilterBox).not.toBeNull();
		expect(viewModeBox).not.toBeNull();
		expect(mediaGridBox).not.toBeNull();
		expect(mediaCardBox).not.toBeNull();
		expect(addFolderBox!.width).toBeGreaterThanOrEqual(44);
		expect(uploadFilesBox!.width).toBeGreaterThanOrEqual(44);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);

		await page.getByRole("button", { name: "Add new folder" }).click();
		const createDialog = page.getByRole("dialog", { name: "Add new folder" });
		await expect(createDialog.getByRole("button", { name: "Create" })).toBeVisible();
		await createDialog.getByRole("button", { name: "Cancel" }).click();

		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/_emdash" }]);
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await expect(page.locator("[data-media-library]")).not.toHaveAttribute("aria-busy", "true");
		const rtlSearch = page.locator('input[type="search"]');
		await rtlSearch.fill(longFolderName);
		const longFolderText = page
			.locator('[data-media-folder-card] [dir="auto"]')
			.filter({ hasText: longFolderName });
		await expect(longFolderText).toBeVisible();
		const bidiMetrics = await longFolderText.evaluate((element) => ({
			direction: getComputedStyle(element).direction,
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth,
			text: element.textContent ?? "",
		}));
		expect(bidiMetrics.direction).toBe("ltr");
		expect(bidiMetrics.scrollWidth).toBeGreaterThan(bidiMetrics.clientWidth);
		expect(bidiMetrics.text.startsWith("Campaign assets")).toBe(true);

		await longFolderText.locator("xpath=ancestor::a[1]").click();
		await expect(page).toHaveURL(/\/media\?folder=/);
		const currentBidiName = page.locator('[aria-current="page"] [dir="auto"]').first();
		await expect(currentBidiName).toBeVisible();
		const currentBidiMetrics = await currentBidiName.evaluate((element) => ({
			direction: getComputedStyle(element).direction,
			clientWidth: element.clientWidth,
			scrollWidth: element.scrollWidth,
			text: element.textContent ?? "",
		}));
		expect(currentBidiMetrics.direction).toBe("ltr");
		expect(currentBidiMetrics.scrollWidth).toBeGreaterThan(currentBidiMetrics.clientWidth);
		expect(currentBidiMetrics.text.startsWith("Campaign assets")).toBe(true);
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);

		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "en", domain: "localhost", path: "/_emdash" }]);
	});

	test("keeps media intact while organizing it in folders", async ({ admin, page }) => {
		test.setTimeout(90_000);
		const folderName = `Product photos ${Date.now()}`;
		const renamedFolder = `${folderName} archive`;
		const uniqueFilename = `organize-${Date.now()}.png`;
		const searchTerm = uniqueFilename.replace(/\.png$/, "");
		await admin.goToMedia();
		await admin.waitForLoading();
		await uploadTestImage(page, uniqueFilename);
		await createFolder(page, folderName);
		await createFolder(page, `Press ${Date.now()}`);

		const mediaGrid = page.locator("[data-media-grid]");
		const originalImage = mediaGrid.locator("img").first();
		await expect(originalImage).toBeVisible();
		const originalSrc = await originalImage.getAttribute("src");
		await mediaGrid.locator("button").first().click();

		const details = page.getByRole("dialog", { name: "Media details" });
		await details.getByRole("combobox", { name: "Location" }).click();
		await page.getByRole("option", { name: folderName }).click();
		await details.getByRole("button", { name: "Save" }).click();
		await expect(details).toBeVisible();
		await expect(details.getByRole("button", { name: "Save" })).toBeDisabled();
		await details.getByRole("button", { name: "Close" }).click();
		await expect(details).not.toBeVisible();

		await page.getByRole("link", { name: `Open folder ${folderName}` }).click();
		await expect(page).toHaveURL(/\/media\?folder=/);
		await expect(mediaGrid.locator("img").first()).toHaveAttribute("src", originalSrc!);
		const mediaLibrary = page.locator("[data-media-library]");
		const pageSize = page.getByRole("combobox", { name: "Page size" });
		await expect(mediaLibrary).not.toHaveAttribute("aria-busy", "true");
		await pageSize.click();
		await page.getByRole("option", { name: "70" }).click();
		await expect(pageSize).toContainText("70");
		await expect(mediaLibrary).not.toHaveAttribute("aria-busy", "true");

		const folderSearch = page.getByRole("searchbox", { name: "Search media" });
		await folderSearch.fill(searchTerm);
		await page.getByRole("combobox", { name: "Filter by type" }).click();
		await page.getByRole("option", { name: "Images" }).click();
		await expect(mediaLibrary).not.toHaveAttribute("aria-busy", "true");
		await expect(mediaGrid.locator("button").filter({ hasText: uniqueFilename })).toBeVisible();
		await page.getByRole("tab", { name: "List view" }).click();
		const mediaRow = page.getByRole("row").filter({ hasText: uniqueFilename });
		await expect(mediaRow).toBeVisible();
		await expect(pageSize).toContainText("70");
		await expect(mediaRow).toBeVisible();
		const main = page.locator("main");
		const headerBack = page.getByRole("link", { name: "Back" });
		await headerBack.focus();
		const scrollFixture = await page.addStyleTag({
			content: "main { padding-bottom: 1200px !important; }",
		});
		const scrollBeforeBack = await main.evaluate((element) => {
			element.scrollTop = 400;
			return element.scrollTop;
		});
		expect(scrollBeforeBack).toBeGreaterThan(0);
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/media\/?$/);
		await expect(folderSearch).toHaveValue(searchTerm);
		await expect(page.getByRole("combobox", { name: "Filter by type" })).toContainText("Images");
		await expect(pageSize).toContainText("70");
		await expect(page.getByRole("tab", { name: "List view" })).toHaveAttribute(
			"aria-selected",
			"true",
		);
		await expect(page.getByRole("heading", { name: "Media Library" })).toBeFocused();
		await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		await scrollFixture.evaluate((element) => element.remove());

		await folderSearch.fill("");
		await page.getByRole("combobox", { name: "Filter by type" }).click();
		await page.getByRole("option", { name: "All types" }).click();
		await page.getByRole("tab", { name: "Grid view" }).click();
		await page.getByRole("link", { name: `Open folder ${folderName}` }).click();
		await expect(page).toHaveURL(/\/media\?folder=/);
		await page.setViewportSize({ width: 320, height: 800 });
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page.reload();
		await expect(mediaGrid.locator("img").first()).toHaveAttribute("src", originalSrc!);
		await page.route("**/_emdash/api/media/folders?**", async (route) => {
			await new Promise((resolve) => setTimeout(resolve, 1200));
			await route.continue();
		});
		const rootFoldersResponse = page.waitForResponse((response) =>
			new URL(response.url()).pathname.endsWith("/_emdash/api/media/folders"),
		);
		const delayedBack = page.getByRole("link", { name: "Back" });
		await delayedBack.focus();
		const delayedScrollFixture = await page.addStyleTag({
			content: "main { padding-bottom: 1200px !important; }",
		});
		const delayedScrollBeforeBack = await main.evaluate((element) => {
			element.scrollTop = 400;
			return element.scrollTop;
		});
		expect(delayedScrollBeforeBack).toBeGreaterThan(0);
		await page.keyboard.press("Enter");
		await expect(page).toHaveURL(/\/media\/?$/);
		await rootFoldersResponse;
		await expect.poll(() => main.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
		await delayedScrollFixture.evaluate((element) => element.remove());
		await page.unroute("**/_emdash/api/media/folders?**");
		await page.goBack();
		await expect(page).toHaveURL(/\/media\?folder=/);
		await page.goForward();
		await expect(page).toHaveURL(/\/media\/?$/);

		const search = page.getByRole("searchbox", { name: "Search media" });
		await search.fill(folderName);
		await page.getByRole("link", { name: `Open folder ${folderName}` }).click();
		await expect(search).toHaveValue("");
		await search.fill(folderName);
		await page.getByRole("button", { name: `Edit folder ${folderName}` }).click();

		const editDialog = page.getByRole("dialog", { name: "Edit folder" });
		for (const name of ["Cancel", "Delete folder", "Save"]) {
			await expect(editDialog.getByRole("button", { name })).toBeVisible();
		}
		await editDialog.getByLabel("Name").fill(renamedFolder);
		await editDialog.getByRole("button", { name: "Save" }).click();
		await expect(page.getByText(renamedFolder).first()).toBeVisible();

		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/_emdash" }]);
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		expect(
			await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
		).toBe(true);
		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "en", domain: "localhost", path: "/_emdash" }]);
		await page.reload();
		await expect(page.locator("html")).toHaveAttribute("dir", "ltr");

		await search.fill(renamedFolder);
		await page.getByRole("button", { name: `Edit folder ${renamedFolder}` }).click();
		await editDialog.getByRole("button", { name: "Delete folder" }).click();
		const confirm = page.getByRole("dialog", { name: `Delete “${renamedFolder}”?` });
		await confirm.getByRole("button", { name: "Delete folder" }).click();

		await expect(page).toHaveURL(/\/media\/?$/);
		await page.getByRole("button", { name: "Clear search" }).click();
		await expect(mediaGrid.locator("img").first()).toHaveAttribute("src", originalSrc!);
	});
});
