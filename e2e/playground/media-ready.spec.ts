import type { Page } from "@playwright/test";
import { expect, test } from "@playwright/test";

interface MediaItem {
	id: string;
	filename: string;
	alt: string | null;
	status: string;
	url: string;
}

interface ApiSuccess<T> {
	success: true;
	data: T;
}

const expectedPostTitles = new Map([
	["building-long-term.jpg", "Building for the Long Term"],
	["case-for-static.jpg", "The Case for Static"],
	["learning-in-public.jpg", "Learning in Public"],
	["small-tools.jpg", "Small Tools, Big Impact"],
	["designing-with-constraints.jpg", "Designing with Constraints"],
	["weekend-side-project.jpg", "A Weekend with a Side Project"],
	["notes-on-simplicity.jpg", "Notes on Simplicity"],
]);
const ADMIN_URL_PATTERN = /\/_emdash\/admin\/?$/;

async function requestJson<T>(
	page: Page,
	path: string,
	method = "GET",
	body?: unknown,
): Promise<{ status: number; body: T }> {
	return page.evaluate(
		async ({ requestPath, requestMethod, requestBody }) => {
			const init: RequestInit = {
				method: requestMethod,
				headers: {
					"X-EmDash-Request": "1",
					...(requestBody === undefined ? {} : { "Content-Type": "application/json" }),
				},
			};
			if (requestBody !== undefined) init.body = JSON.stringify(requestBody);
			const response = await fetch(requestPath, init);
			return { status: response.status, body: await response.json() };
		},
		{ requestPath: path, requestMethod: method, requestBody: body },
	);
}

async function openFreshPlayground(page: Page): Promise<void> {
	await page.goto("/playground");
	await page.waitForURL(ADMIN_URL_PATTERN, { timeout: 120_000 });
	await page.waitForSelector("astro-island:not([ssr])", { timeout: 60_000 });
	const welcome = page.getByRole("dialog").filter({ hasText: "Welcome to EmDash" });
	if (await welcome.isVisible()) await welcome.getByRole("button", { name: "Get Started" }).click();
}

async function listMedia(page: Page): Promise<MediaItem[]> {
	const response = await requestJson<ApiSuccess<{ items: MediaItem[] }>>(
		page,
		"/_emdash/api/media?includeUsage=1&limit=50",
	);
	expect(response.status).toBe(200);
	expect(response.body.success).toBe(true);
	return response.body.data.items;
}

test("opens with seeded media and ready usage after creation and reset", async ({
	page,
	context,
}) => {
	await openFreshPlayground(page);
	const firstSession = (await context.cookies()).find(({ name }) => name === "emdash_playground");
	const media = await listMedia(page);
	expect(media).toHaveLength(7);
	expect(media.every(({ status }) => status === "ready")).toBe(true);

	for (const item of media) {
		const file = await page.evaluate(async (url) => {
			const response = await fetch(url);
			return { status: response.status, contentType: response.headers.get("content-type") };
		}, item.url);
		expect(file).toEqual({ status: 200, contentType: "image/jpeg" });
	}

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

	for (const item of media) {
		const title = expectedPostTitles.get(item.filename);
		if (!title) throw new Error(`Unexpected media item: ${item.filename}`);
		await page.locator("[data-media-grid] button").filter({ hasText: item.filename }).click();
		const dialog = page.getByRole("dialog");
		await expect(dialog.getByText("Used in", { exact: true })).toBeVisible();
		await expect(dialog.getByText(title, { exact: true })).toBeVisible();
		await page.keyboard.press("Escape");
		await expect(dialog).not.toBeVisible();
	}

	await page.goto("/_emdash/admin/settings/media-usage");
	await expect(page.getByText("Media usage tracking is ready", { exact: true })).toBeVisible();
	await expect(page.getByRole("button", { name: "Enable tracking" })).toHaveCount(0);
	await expect(page.getByText("Indexing existing content", { exact: true })).toHaveCount(0);

	const id = media[0]!.id;
	for (const [method, path] of [
		["POST", "/_emdash/api/media"],
		["POST", "/_emdash/api/media/upload-url"],
		["PUT", `/_emdash/api/media/${id}/upload`],
		["POST", `/_emdash/api/media/${id}/confirm`],
		["DELETE", `/_emdash/api/media/${id}`],
		["POST", "/_emdash/api/media/providers/local"],
		["DELETE", `/_emdash/api/media/providers/local/${id}`],
	] as const) {
		expect((await requestJson(page, path, method)).status).toBe(403);
	}
	const mcp = await page.evaluate(async () =>
		fetch("/_emdash/api/mcp", { method: "POST" }).then((response) => response.status),
	);
	expect(mcp).toBe(404);

	const originalAlt = media[0]!.alt;
	const update = await requestJson(page, `/_emdash/api/media/${id}`, "PUT", {
		alt: "Changed in the first Playground session",
	});
	expect(update.status).toBe(200);

	await page.goto("/_playground/reset");
	await page.waitForURL(ADMIN_URL_PATTERN, { timeout: 120_000 });
	const secondSession = (await context.cookies()).find(({ name }) => name === "emdash_playground");
	expect(secondSession?.value).not.toBe(firstSession?.value);
	const resetMedia = await listMedia(page);
	expect(resetMedia).toHaveLength(7);
	expect(resetMedia.find((item) => item.id === id)?.alt).toBe(originalAlt);
});
