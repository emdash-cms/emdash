/**
 * Site Transfer E2E Tests
 *
 * Exports the fixture site from Settings → Transfer and downloads the
 * archive. The fixture has content, so the import card must explain why it
 * can't receive an import instead of offering one.
 */

import { readFile } from "node:fs/promises";

import { test, expect } from "../fixtures";

const TAR_BLOCK_BYTES = 512;

test.describe("Site transfer", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
		await admin.goto("/settings/transfer");
		await admin.waitForShell();
		await admin.waitForLoading();
	});

	test("exports the site and downloads the package file by file", async ({ admin, page }) => {
		await admin.expectPageTitle("Transfer");

		await page.getByRole("button", { name: "Export site" }).click();
		await expect(page.getByText("Export ready")).toBeVisible({ timeout: 60_000 });
		await expect(page.getByText("Package digest")).toBeVisible();

		const href = await page
			.getByRole("link", { name: "Download as one file" })
			.getAttribute("href");
		expect(href).toMatch(/\/_emdash\/api\/admin\/transfer\/exports\/[^/]+\/archive$/);
		const response = await page.request.get(href!);
		expect(response.status()).toBe(200);
		expect(response.headers()["content-disposition"]).toMatch(/\.emdash"$/);
		const serverArchive = await response.body();
		expect(serverArchive.byteLength).toBeGreaterThan(TAR_BLOCK_BYTES);

		// Without the save picker the browser assembles the archive in memory and downloads it.
		await page.evaluate(() => Reflect.set(window, "showSaveFilePicker", undefined));
		const downloading = page.waitForEvent("download");
		await page.getByRole("button", { name: "Download package" }).click();
		const download = await downloading;
		expect(download.suggestedFilename()).toMatch(/\.emdash$/);
		const path = await download.path();
		const assembled = await readFile(path);
		await expect(page.getByText("Package downloaded")).toBeVisible();

		expect(assembled.subarray(0, "manifest.json".length).toString("utf8")).toBe("manifest.json");
		expect(Buffer.compare(assembled, serverArchive)).toBe(0);
	});

	test("explains why a site with content can't receive an import", async ({ page }) => {
		await expect(page.getByText("This site can’t receive an import")).toBeVisible();
		await expect(page.getByText(/Collection “posts” has entries/)).toBeVisible();
		await expect(page.getByRole("button", { name: "Choose package file" })).toHaveCount(0);
	});

	test("focuses the import when opened to start one", async ({ admin, page }) => {
		await admin.goto("/settings/transfer?start=import");
		await admin.waitForShell();
		await admin.waitForLoading();
		await expect
			.poll(() => page.evaluate(() => document.activeElement?.textContent ?? ""))
			.toContain("This site can’t receive an import");
	});

	test("links to Transfer from Backups", async ({ admin, page }) => {
		await admin.goto("/settings/backups");
		await admin.waitForShell();
		await admin.waitForLoading();
		await page.getByRole("link", { name: "Transfer" }).click();
		await expect(page).toHaveURL(/\/settings\/transfer$/);
	});
});
