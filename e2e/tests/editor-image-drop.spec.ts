import type { Locator, Page } from "@playwright/test";

import { test as base, expect } from "../fixtures/index.js";

interface UploadedImage {
	id: string;
	filename: string;
	storageKey: string;
	width: number;
	height: number;
}

const test = base.extend<{
	imageDropContent: { collection: string; id: string; title: string; mediaIds: string[] };
}>({
	imageDropContent: [
		async ({ page, serverInfo }, use) => {
			const headers = { Authorization: `Bearer ${serverInfo.token}`, "X-EmDash-Request": "1" };
			const collection = `image_drop_${crypto.randomUUID().replaceAll("-", "").slice(0, 12)}`;
			const collectionPath = `/_emdash/api/schema/collections/${collection}`;
			const created = await page.request.post("/_emdash/api/schema/collections", {
				headers,
				data: {
					slug: collection,
					label: "Image drop",
					labelSingular: "Image drop",
					supports: ["revisions", "drafts", "seo"],
				},
			});
			expect(created.ok(), await created.text()).toBe(true);
			let contentPath: string | undefined;
			const mediaIds: string[] = [];
			try {
				for (const field of [
					{ slug: "title", label: "Title", type: "string", required: true },
					{ slug: "featured_image", label: "Featured Image", type: "image" },
				]) {
					const response = await page.request.post(`${collectionPath}/fields`, {
						headers,
						data: field,
					});
					expect(response.ok(), await response.text()).toBe(true);
				}
				const title = `Image drop ${crypto.randomUUID()}`;
				const response = await page.request.post(`/_emdash/api/content/${collection}`, {
					headers,
					data: { data: { title } },
				});
				expect(response.ok(), await response.text()).toBe(true);
				const { data } = (await response.json()) as { data: { item: { id: string } } };
				contentPath = `/_emdash/api/content/${collection}/${data.item.id}`;
				await use({ collection, id: data.item.id, title, mediaIds });
			} finally {
				if (contentPath) {
					await page.request.delete(`${contentPath}?locale=en`, { headers });
					await page.request.delete(`${contentPath}/permanent`, { headers });
				}
				for (const id of mediaIds)
					await page.request.delete(`/_emdash/api/media/${id}`, { headers });
				await page.request.delete(collectionPath, { headers });
			}
		},
		{ timeout: 60_000 },
	],
});

async function dropImage(page: Page, target: Locator, filename: string): Promise<UploadedImage> {
	await target.scrollIntoViewIfNeeded();
	const transfer = await page.evaluateHandle(async (name) => {
		const canvas = document.createElement("canvas");
		canvas.width = 32;
		canvas.height = 24;
		const context = canvas.getContext("2d")!;
		const pixels = context.createImageData(32, 24);
		crypto.getRandomValues(pixels.data);
		for (let i = 3; i < pixels.data.length; i += 4) pixels.data[i] = 255;
		context.putImageData(pixels, 0, 0);
		const blob = await new Promise<Blob>((resolve, reject) => {
			canvas.toBlob((value) => {
				if (value) resolve(value);
				else reject(new Error("Could not create test image"));
			}, "image/png");
		});
		const data = new DataTransfer();
		data.items.add(new File([blob], name, { type: "image/png" }));
		return data;
	}, filename);
	try {
		const response = page.waitForResponse((result) => {
			const path = new URL(result.url()).pathname;
			return (
				result.request().method() === "POST" &&
				(path === "/_emdash/api/media" || /^\/_emdash\/api\/media\/[^/]+\/confirm$/.test(path))
			);
		});
		for (const event of ["dragenter", "dragover", "drop"]) {
			await target.dispatchEvent(event, { dataTransfer: transfer });
		}
		const uploaded = await response;
		expect(uploaded.ok(), await uploaded.text()).toBe(true);
		const result = (await uploaded.json()) as { data: { item: UploadedImage } };
		return result.data.item;
	} finally {
		await transfer.dispose();
	}
}

test("uploads and saves dropped featured and OG images", async ({
	admin,
	page,
	imageDropContent,
}) => {
	await admin.devBypassAuth();
	const name = `image-drop-${crypto.randomUUID()}`;
	const { collection, id, title, mediaIds } = imageDropContent;
	const contentPath = `/_emdash/api/content/${collection}/${id}`;
	await page.goto(`/_emdash/admin/content/${collection}/${id}`);
	await admin.waitForHydration();
	await expect(page.getByRole("textbox", { name: "Title", exact: true })).toHaveValue(title);
	const featured = await dropImage(
		page,
		page.getByRole("button", { name: /browse for Featured Image/i }),
		`${name}-featured.png`,
	);
	mediaIds.push(featured.id);
	expect(featured).toMatchObject({ filename: `${name}-featured.png`, width: 32, height: 24 });
	await expect(page.getByText(featured.filename, { exact: true })).toBeVisible();

	const og = await dropImage(
		page,
		page.getByRole("button", { name: "Drop an image here or browse for OG Image", exact: true }),
		`${name}-og.png`,
	);
	mediaIds.push(og.id);
	const ogUrl = `/_emdash/api/media/file/${og.storageKey}`;
	await expect
		.poll(
			async () => {
				const response = await page.request.get(`${contentPath}?locale=en`);
				const saved = await response.json();
				return {
					featuredId: saved.data?.item?.data.featured_image?.id,
					ogImage: saved.data?.item?.seo?.image,
				};
			},
			{ timeout: 20_000 },
		)
		.toEqual({ featuredId: featured.id, ogImage: ogUrl });

	await page.reload();
	await expect(page.getByText(featured.filename, { exact: true })).toBeVisible();
	await expect(page.locator(`img[src="${ogUrl}"]`)).toBeVisible();
});
