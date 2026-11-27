import { readFileSync } from "node:fs";

import type { Locator } from "@playwright/test";

import { test, expect } from "../fixtures";

test.use({ reducedMotion: "reduce" });

async function filterMedia(picker: Locator, prefix: string) {
	const results = picker.getByRole("region", { name: /^(Media results|نتائج الوسائط)$/ });
	await expect(results).toBeVisible();
	await expect(results).not.toHaveAttribute("aria-busy", "true", { timeout: 30_000 });
	await picker.getByRole("searchbox").fill(prefix);
	await expect(picker.getByRole("status").filter({ hasText: /\b97\s*$/ })).toBeVisible({
		timeout: 30_000,
	});
	await expect(picker.locator("[data-media-items] > *")).toHaveCount(12);
	await expect(results).not.toHaveAttribute("aria-busy", "true");
}

async function checkResults(picker: Locator, grid: boolean, minimumHeightRatio = 0.4) {
	const viewport = picker.locator("[data-media-results-viewport]");
	const items = picker.locator("[data-media-items] > *");
	await expect(async () => {
		const box = (await viewport.boundingBox())!;
		const first = (await items.first().boundingBox())!;
		expect(box.height).toBeGreaterThan((await picker.boundingBox())!.height * minimumHeightRatio);
		expect(first.y).toBeGreaterThanOrEqual(box.y);
		expect(first.y + first.height).toBeLessThanOrEqual(box.y + box.height);
		if (grid) {
			const second = (await items.nth(1).boundingBox())!;
			expect(second.y).toBe(first.y);
		}
	}).toPass({ timeout: 10_000 });
	await viewport.evaluate((element) => {
		element.scrollTop = element.scrollHeight;
	});
	await expect.poll(() => viewport.evaluate((element) => element.scrollTop)).toBeGreaterThan(0);
	await expect(items.last()).toBeInViewport({ ratio: 1 });
	await viewport.evaluate((element) => {
		element.scrollTop = 0;
	});
}

async function checkToolbar(picker: Locator) {
	const filter = (await picker.getByRole("combobox", { name: "Filter by type" }).boundingBox())!;
	const viewMode = (await picker.getByRole("group", { name: "View mode" }).boundingBox())!;
	expect(Math.abs(filter.y - viewMode.y)).toBeLessThan(1);
}

async function checkSources(picker: Locator) {
	await expect(async () => {
		const sources = (await picker.locator("[data-source-tabs]").boundingBox())!;
		const upload = (await picker
			.getByRole("button", { name: /Upload files|رفع الملفات/ })
			.boundingBox())!;
		const dialog = (await picker.boundingBox())!;
		for (const box of [sources, upload]) {
			expect(box.x).toBeGreaterThanOrEqual(dialog.x);
			expect(box.x + box.width).toBeLessThanOrEqual(dialog.x + dialog.width);
		}
		if (Math.abs(sources.y - upload.y) > 4) {
			expect(Math.abs(sources.width - upload.width)).toBeLessThan(4);
			expect(Math.abs(sources.x - upload.x)).toBeLessThan(4);
		}
	}).toPass({ timeout: 10_000 });
}

test("phone media picker keeps results scrollable and source controls evenly arranged", async ({
	admin,
	page,
	serverInfo,
}) => {
	test.setTimeout(120_000);
	const bytes = readFileSync("e2e/fixtures/assets/test-image.png");
	const prefix = `phone-picker-${crypto.randomUUID().slice(0, 8)}`;
	const ids: string[] = [];
	const headers = {
		Authorization: `Bearer ${serverInfo.token}`,
		"X-EmDash-Request": "1",
		Origin: serverInfo.baseUrl,
	};
	try {
		for (let index = 0; index < 97; index++) {
			const filename = `${prefix}-${String(index).padStart(3, "0")}.png`;
			const response = await page.request.post(`${serverInfo.baseUrl}/_emdash/api/media`, {
				headers,
				multipart: {
					file: {
						name: filename,
						mimeType: "image/png",
						buffer: Buffer.concat([bytes, Buffer.from(filename)]),
					},
					width: "1",
					height: "1",
				},
			});
			expect(response.ok()).toBe(true);
			ids.push((await response.json()).data.item.id);
		}
		await admin.devBypassAuth();
		await admin.goToNewContent("posts");
		await admin.waitForLoading();
		await page.setViewportSize({ width: 390, height: 758 });
		await page.getByRole("button", { name: /browse for Featured Image/i }).click();
		const picker = page.getByRole("dialog", { name: "Select Featured Image" });
		await filterMedia(picker, prefix);
		expect((await picker.boundingBox())!.height).toBeGreaterThan(758 * 0.9);
		await checkSources(picker);
		await checkToolbar(picker);
		await checkResults(picker, true);
		await picker.getByRole("tab", { name: "List view" }).click();
		await checkResults(picker, false);

		await picker.getByRole("tab", { name: "From URL" }).click();
		await expect(picker.getByRole("textbox", { name: "Image URL" })).toBeInViewport();
		await picker.getByRole("tab", { name: "Library", exact: true }).click();
		await filterMedia(picker, prefix);
		const chooser = page.waitForEvent("filechooser");
		await picker.getByRole("button", { name: "Upload files" }).click();
		expect((await chooser).isMultiple()).toBe(false);
		await picker.getByRole("tab", { name: "Grid view" }).click();
		await page.setViewportSize({ width: 320, height: 667 });
		await checkSources(picker);
		await checkToolbar(picker);
		await checkResults(picker, true, 0.3);

		await page.setViewportSize({ width: 1280, height: 900 });
		await checkSources(picker);
		await checkResults(picker, true);
		await expect(picker.locator("[data-media-items] > *")).toHaveCount(12);
		const first = (await picker.locator("[data-media-items] > *").first().boundingBox())!;
		const fourth = (await picker.locator("[data-media-items] > *").nth(3).boundingBox())!;
		expect(fourth.y).toBe(first.y);

		await picker.getByRole("button", { name: "Last page", exact: true }).click();
		await expect(picker.getByRole("status").filter({ hasText: "Showing" })).toContainText("97");
		await expect(picker.locator("[data-media-items] > *")).toHaveCount(1);
		await picker.locator("[data-media-items] > *").click();
		await picker.getByRole("button", { name: "Select", exact: true }).click();
		await expect(picker).not.toBeVisible();
		await expect(page.locator("#field-featured_image img")).toBeVisible();

		await page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/_emdash" }]);
		await page.reload();
		await admin.waitForLoading();
		await page.setViewportSize({ width: 390, height: 758 });
		await page
			.getByRole("button", { name: /أفلت صورة هنا أو استعرض لاختيار Featured Image/ })
			.click();
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		const arabicPicker = page.getByRole("dialog");
		await filterMedia(arabicPicker, prefix);
		await checkSources(arabicPicker);
		await checkResults(arabicPicker, true);
	} finally {
		for (const id of ids) {
			const response = await page.request.delete(`${serverInfo.baseUrl}/_emdash/api/media/${id}`, {
				headers,
			});
			expect(response.ok()).toBe(true);
		}
	}
});
