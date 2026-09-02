import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

const expectedMediaUsage = [
	["building-long-term.jpg", "Building for the Long Term"],
	["case-for-static.jpg", "The Case for Static"],
	["learning-in-public.jpg", "Learning in Public"],
	["small-tools.jpg", "Small Tools, Big Impact"],
	["designing-with-constraints.jpg", "Designing with Constraints"],
	["weekend-side-project.jpg", "A Weekend with a Side Project"],
	["notes-on-simplicity.jpg", "Notes on Simplicity"],
] as const;
const ADMIN_URL_PATTERN = /\/_emdash\/admin\/?$/;

async function openFreshPlayground(page: Page): Promise<void> {
	const welcome = page.getByRole("dialog").filter({ hasText: "Welcome to EmDash" });
	await page.addLocatorHandler(welcome, (dialog) =>
		dialog.getByRole("button", { name: "Get Started" }).click(),
	);
	await page.goto("/playground");
	await page.waitForURL(ADMIN_URL_PATTERN, { timeout: 120_000 });
	await expect(page.getByRole("link", { name: "Media", exact: true })).toBeVisible({
		timeout: 60_000,
	});
}

test("opens with seeded media and ready usage", async ({ page }) => {
	await openFreshPlayground(page);

	await page.goto("/_emdash/admin/media");
	await expect(page.getByRole("heading", { name: "Media Library" })).toBeVisible();
	const thumbnails = page.locator("[data-media-grid] img");
	await expect(thumbnails).toHaveCount(7);
	await expect
		.poll(() =>
			thumbnails.evaluateAll((images) =>
				images.every(
					(image) =>
						image instanceof HTMLImageElement &&
						image.complete &&
						image.naturalWidth > 0 &&
						image.naturalHeight > 0,
				),
			),
		)
		.toBe(true);
	await expect(page.getByText("Set up media usage tracking")).toHaveCount(0);
	await expect(page.getByText("Media usage tracking is indexing existing content")).toHaveCount(0);

	for (const [filename, postTitle] of expectedMediaUsage) {
		await page.locator("[data-media-grid] button").filter({ hasText: filename }).click();
		const dialog = page.getByRole("dialog");
		await dialog.getByRole("tab", { name: "Used in", exact: true }).click();
		await expect(dialog.getByText(postTitle, { exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).not.toBeVisible();
	}

	await page.goto("/_emdash/admin/settings/media-usage");
	await expect(page.getByText("Media usage tracking is ready", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Enable tracking" })).toHaveCount(0);
	await expect(page.getByText("Indexing existing content", { exact: true })).toHaveCount(0);

	const blockedUpload = await page.evaluate(async () =>
		fetch("/_emdash/api/media", {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
		}).then((response) => response.status),
	);
	expect(blockedUpload).toBe(403);
	const blockedDelete = await page.evaluate(async () =>
		fetch("/_emdash/api/media/01M1A5H7P30125M3W71HJ7XC2F////", {
			method: "DELETE",
			headers: { "X-EmDash-Request": "1" },
		}).then((response) => response.status),
	);
	expect(blockedDelete).toBe(403);
});
