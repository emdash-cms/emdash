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
	await page.waitForURL(ADMIN_URL_PATTERN, { timeout: 240_000 });
	await expect(page.getByRole("link", { name: "Media", exact: true })).toBeVisible({
		timeout: 60_000,
	});
}

test("counts a Copy URL link without a Site URL", async ({ page }) => {
	await openFreshPlayground(page);
	await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
	const settings = await page.evaluate(async () => {
		const response = await fetch("/_emdash/api/settings");
		return response.json();
	});
	expect(settings.data.url).toBeUndefined();

	await page.goto("/_emdash/admin/media");
	const mediaButton = page
		.locator("[data-media-grid] button")
		.filter({ hasText: "building-long-term.jpg" });
	await mediaButton.click();
	const mediaDialog = page.getByRole("dialog");
	await mediaDialog.getByRole("button", { name: "Copy URL", exact: true }).click();
	const mediaUrl = await page.evaluate(() => navigator.clipboard.readText());
	expect(new URL(mediaUrl).origin).toBe(new URL(page.url()).origin);
	await page.keyboard.press("Escape");

	const title = "Copy URL link without Site URL";
	const created = await page.evaluate(
		async ({ title: postTitle, mediaUrl: linkUrl }) => {
			const response = await fetch("/_emdash/api/content/posts", {
				method: "POST",
				headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
				body: JSON.stringify({
					slug: "copy-url-no-site-url",
					data: {
						title: postTitle,
						content: [
							{
								_type: "block",
								_key: "media-link-block",
								style: "normal",
								children: [
									{
										_type: "span",
										_key: "media-link-span",
										text: "Download",
										marks: ["media-link"],
									},
								],
								markDefs: [{ _type: "link", _key: "media-link", href: linkUrl }],
							},
						],
					},
				}),
			});
			return { status: response.status, body: await response.json() };
		},
		{ title, mediaUrl },
	);
	expect(created.status).toBe(201);
	const contentId = String(created.body.data.item.id);
	const published = await page.evaluate(async (id) => {
		const response = await fetch(`/_emdash/api/content/posts/${id}/publish`, {
			method: "POST",
			headers: { "X-EmDash-Request": "1" },
		});
		return response.status;
	}, contentId);
	expect(published).toBe(200);

	await page.reload();
	await mediaButton.click();
	const savedUsageDialog = page.getByRole("dialog");
	await savedUsageDialog.getByRole("tab", { name: "Used in", exact: true }).click();
	await expect(savedUsageDialog.getByText(title, { exact: true })).toBeVisible();
	await page.keyboard.press("Escape");

	const repaired = await page.evaluate(async () => {
		const response = await fetch("/_emdash/api/admin/media-usage/repair", {
			method: "POST",
			headers: { "Content-Type": "application/json", "X-EmDash-Request": "1" },
			body: JSON.stringify({ scope: "all" }),
		});
		return { status: response.status, body: await response.json() };
	});
	expect(repaired.status).toBe(200);
	expect(repaired.body.data.status).toBe("complete");

	await page.reload();
	await mediaButton.click();
	const usedInDialog = page.getByRole("dialog");
	await usedInDialog.getByRole("tab", { name: "Used in", exact: true }).click();
	await expect(usedInDialog.getByText(title, { exact: true })).toBeVisible();
});

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
