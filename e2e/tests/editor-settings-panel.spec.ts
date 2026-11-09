/**
 * Content editor settings panel toggle E2E tests: hiding and showing the desktop
 * settings panel, remembering the choice, and the views that reveal it.
 */

import type { Locator, Page } from "@playwright/test";

import { test, expect } from "../fixtures";

const EXTERNAL_IMAGE_URL = "http://media.example.test/settings-panel.png";
const REVISIONS_TRIGGER = /^Revisions/;
const VERSION_VIEW = /^Version from /;

function editorBar(page: Page): Locator {
	return page.locator("[data-emdash-editor-bar]");
}

/** Located by what it controls, which holds in any UI language. */
function panelToggle(page: Page): Locator {
	return editorBar(page).locator("button[aria-controls]");
}

async function settingsPanel(page: Page): Promise<Locator> {
	const panelId = await panelToggle(page).getAttribute("aria-controls");
	expect(panelId).toBeTruthy();
	return page.locator(`[id="${panelId}"]`);
}

async function panelWidth(panel: Locator): Promise<number> {
	return panel.evaluate((element) => element.getBoundingClientRect().width);
}

/** Horizontal offset of the page's center from the canvas's center. */
async function pageOffsetInCanvas(page: Page): Promise<number> {
	return page.evaluate(() => {
		const canvas = document.querySelector("[data-emdash-editor-canvas]")!.getBoundingClientRect();
		const sheet = document.querySelector(".emdash-editor-page")!.getBoundingClientRect();
		return sheet.left + sheet.width / 2 - (canvas.left + canvas.width / 2);
	});
}

/** How much of the panel's content is left on screen once ancestors that clip it are applied. */
async function visiblePanelWidth(panel: Locator): Promise<number> {
	return panel.evaluate((element) => {
		const content = element.querySelector("[data-sidebar='content-container']")!;
		const bounds = content.getBoundingClientRect();
		let left = Math.max(bounds.left, 0);
		let right = Math.min(bounds.right, window.innerWidth);
		for (let node = content.parentElement; node; node = node.parentElement) {
			if (getComputedStyle(node).overflowX === "visible") continue;
			const clip = node.getBoundingClientRect();
			left = Math.max(left, clip.left);
			right = Math.min(right, clip.right);
		}
		return Math.max(0, right - left);
	});
}

async function expectHidden(page: Page, panel: Locator, side: "left" | "right"): Promise<void> {
	await expect(panel).toHaveAttribute("inert");
	await expect.poll(() => panelWidth(panel)).toBe(0);
	expect(await visiblePanelWidth(panel)).toBe(0);
	const canvasEdge = await page.locator("[data-emdash-editor-canvas]").evaluate((element, edge) => {
		const bounds = element.getBoundingClientRect();
		return edge === "left" ? bounds.left : window.innerWidth - bounds.right;
	}, side);
	expect(Math.abs(canvasEdge)).toBeLessThanOrEqual(1);
	expect(Math.abs(await pageOffsetInCanvas(page))).toBeLessThanOrEqual(1);
}

test.describe("Editor settings panel", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("hides, stays hidden across a reload, and shows again", async ({ admin, page }) => {
		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		const panel = await settingsPanel(page);
		await expect.poll(() => panelWidth(panel)).toBe(368);

		await page.getByRole("button", { name: "Hide settings" }).click();
		await expectHidden(page, panel, "right");

		await page.reload();
		await admin.waitForLoading();
		await expectHidden(page, await settingsPanel(page), "right");

		await page.getByRole("button", { name: "Show settings" }).click();
		const shown = await settingsPanel(page);
		await expect(shown).not.toHaveAttribute("inert");
		await expect.poll(() => panelWidth(shown)).toBe(368);
		expect(Math.abs(await pageOffsetInCanvas(page))).toBeLessThanOrEqual(1);
	});

	test("keeps a value typed into the panel across hide and show", async ({ admin, page }) => {
		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		const panel = await settingsPanel(page);
		const slug = panel.getByLabel("Slug", { exact: true });
		await slug.fill("typed-before-hiding");

		await page.getByRole("button", { name: "Hide settings" }).click();
		await expect(panel).toHaveAttribute("inert");
		await page.getByRole("button", { name: "Show settings" }).click();
		await expect(slug).toBeVisible();
		await expect(slug).toHaveValue("typed-before-hiding");
	});

	test("hides the panel on the left in Arabic", async ({ admin, page }) => {
		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/_emdash" }]);
		await page.reload();
		await admin.waitForLoading();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");

		const panel = await settingsPanel(page);
		await expect.poll(() => panelWidth(panel)).toBe(368);
		const panelBox = (await panel.boundingBox())!;
		expect(panelBox.x).toBeLessThanOrEqual(1);
		const toggle = panelToggle(page);
		const toggleBox = (await toggle.boundingBox())!;
		const barBox = (await editorBar(page).boundingBox())!;
		expect(toggleBox.x + toggleBox.width / 2).toBeLessThan(barBox.x + barBox.width / 4);

		await toggle.click();
		await expectHidden(page, panel, "left");
	});

	test("shows a hidden panel for image settings and hides it again after", async ({
		admin,
		page,
	}) => {
		await page.route(EXTERNAL_IMAGE_URL, (route) =>
			route.fulfill({
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="gray"/></svg>',
				contentType: "image/svg+xml",
			}),
		);
		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		const panel = await settingsPanel(page);
		await page.getByRole("button", { name: "Hide settings" }).click();
		await expect(panel).toHaveAttribute("inert");

		await page.getByRole("button", { name: "Insert image" }).click();
		const picker = page.getByRole("dialog", { name: "Select image" });
		await picker.getByRole("tab", { name: "From URL" }).click();
		await picker.getByLabel("Image URL").fill(EXTERNAL_IMAGE_URL);
		await picker.getByRole("button", { name: "Use URL" }).click();
		const insertButton = picker.getByRole("button", { name: "Insert image" });
		await expect(insertButton).toBeEnabled();
		await insertButton.click();

		const image = page.getByRole("img", { name: "settings-panel.png" });
		await expect(image).toBeVisible();
		await image.click();
		await page.getByRole("button", { name: "Image settings", exact: true }).click();

		await expect(panel).not.toHaveAttribute("inert");
		await expect(panel.getByRole("heading", { name: "Image settings" })).toBeVisible();
		await expect.poll(() => panelWidth(panel)).toBe(368);

		await panel.getByRole("button", { name: "Close image settings" }).click();
		await expectHidden(page, panel, "right");
		await expect(page.getByRole("button", { name: "Show settings" })).toBeVisible();
	});

	test.describe("with versions", () => {
		let collectionSlug: string;
		let postId: string;
		let headers: Record<string, string>;
		let baseUrl: string;

		async function api(method: string, path: string, data?: unknown): Promise<Response> {
			const response = await fetch(`${baseUrl}/_emdash/api${path}`, {
				method,
				headers,
				body: data === undefined ? undefined : JSON.stringify(data),
			});
			expect(response.ok, `${method} ${path} returned ${response.status}`).toBe(true);
			return response;
		}

		test.beforeEach(async ({ serverInfo }) => {
			baseUrl = serverInfo.baseUrl;
			headers = {
				"Content-Type": "application/json",
				Authorization: `Bearer ${serverInfo.token}`,
				"X-EmDash-Request": "1",
				Origin: baseUrl,
			};

			collectionSlug = `panel_test_${Date.now()}`;
			await api("POST", "/schema/collections", {
				slug: collectionSlug,
				label: "Panel Test",
				labelSingular: "Panel Test",
				supports: ["revisions", "drafts"],
			});
			await api("POST", `/schema/collections/${collectionSlug}/fields`, {
				slug: "title",
				type: "string",
				label: "Title",
				required: true,
			});
			const created = (await (
				await api("POST", `/content/${collectionSlug}`, {
					data: { title: "Original Title" },
					slug: "panel-test-post",
				})
			).json()) as { data: { item: { id: string } } };
			postId = created.data.item.id;
			const entryPath = `/content/${collectionSlug}/${postId}`;
			await api("PUT", entryPath, { data: { title: "Revised Title" } });
			await api("POST", `${entryPath}/publish`, {});
			await api("PUT", entryPath, { data: { title: "Latest Title" } });
		});

		test.afterEach(async () => {
			await fetch(`${baseUrl}/_emdash/api/content/${collectionSlug}/${postId}`, {
				method: "DELETE",
				headers,
			}).catch(() => {});
			await fetch(`${baseUrl}/_emdash/api/schema/collections/${collectionSlug}`, {
				method: "DELETE",
				headers,
			}).catch(() => {});
		});

		test("steps between versions from the bar while the panel is hidden", async ({
			admin,
			page,
		}) => {
			await admin.goToEditContent(collectionSlug, postId);
			await admin.waitForLoading();
			await expect(page.locator("#field-title")).toHaveValue("Latest Title");

			await page.getByRole("button", { name: REVISIONS_TRIGGER }).click();
			const rows = page.locator("[data-revision-row]");
			await expect(rows).toHaveCount(3);
			await rows.nth(1).click();
			const canvas = page.getByRole("article", { name: VERSION_VIEW });
			await expect(canvas).toBeVisible();
			const older = page.getByRole("button", { name: "Older version" });
			await expect(older).toHaveCount(0);

			await page.getByRole("button", { name: "Hide settings" }).click();
			await expect(older).toBeEnabled();
			await expect(page.getByRole("button", { name: "Newer version" })).toBeEnabled();
			await older.click();
			await expect(older).toBeDisabled();
			await expect(canvas).toBeVisible();
		});
	});
});
