import type { APIRequestContext, JSHandle, Locator, Page } from "@playwright/test";

import { test, expect, type ServerInfo } from "../fixtures";

const EDITOR = "#field-body .ProseMirror";
const PLACEHOLDER = "[data-image-upload-placeholder]";
const csrfHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	"X-EmDash-Request": "1",
});

interface UploadedImage {
	id: string;
	storageKey: string;
}

async function createPost(request: APIRequestContext, info: ServerInfo, slug: string) {
	const response = await request.post("/_emdash/api/content/posts", {
		headers: csrfHeaders(info.token),
		data: {
			data: {
				title: slug,
				body: ["First", "Second"].map((text, index) => ({
					_type: "block",
					_key: `block-${index}`,
					style: "normal",
					markDefs: [],
					children: [{ _type: "span", _key: `span-${index}`, text, marks: [] }],
				})),
			},
			slug,
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
	const payload = (await response.json()) as { data: { item?: { id: string }; id?: string } };
	return payload.data.item?.id ?? payload.data.id!;
}

function imageTransfer(page: Page, filename: string): Promise<JSHandle<DataTransfer>> {
	return page.evaluateHandle(async (name) => {
		const canvas = document.createElement("canvas");
		canvas.width = 64;
		canvas.height = 48;
		const context = canvas.getContext("2d")!;
		// Random pixels keep content-hash deduplication from reusing an earlier upload.
		const pixels = context.createImageData(64, 48);
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
}

// Every upload starts here, whether storage then takes a signed or a direct upload.
const UPLOAD_URL_PATH = "/_emdash/api/media/upload-url";

/** Holds media uploads until released, so the in-progress placeholder can be observed. */
async function holdUploads(page: Page) {
	let release!: () => void;
	const released = new Promise<void>((resolve) => {
		release = resolve;
	});
	await page.route(
		(url) => url.pathname === UPLOAD_URL_PATH,
		async (route) => {
			await released;
			await route.continue();
		},
	);
	return release;
}

function uploadResponse(page: Page) {
	return page.waitForResponse((response) => {
		const path = new URL(response.url()).pathname;
		return (
			response.request().method() === "POST" &&
			(path === "/_emdash/api/media" || /^\/_emdash\/api\/media\/[^/]+\/confirm$/.test(path))
		);
	});
}

async function savedBody(request: APIRequestContext, id: string) {
	const response = await request.get(`/_emdash/api/content/posts/${id}?locale=en`);
	const payload = (await response.json()) as {
		data?: { item?: { data?: { body?: Array<Record<string, unknown>> } } };
	};
	return (payload.data?.item?.data?.body ?? []).map((block) =>
		block._type === "image"
			? `image:${String((block.asset as { _ref?: string } | undefined)?._ref)}`
			: String((block.children as Array<{ text: string }> | undefined)?.[0]?.text),
	);
}

async function dropOn(target: Locator, transfer: JSHandle<DataTransfer>) {
	const box = (await target.boundingBox())!;
	const position = { clientX: box.x + box.width - 2, clientY: box.y + box.height / 2 };
	for (const type of ["dragenter", "dragover", "drop"]) {
		await target.dispatchEvent(type, { dataTransfer: transfer, ...position });
	}
}

test.describe("Portable Text image upload", () => {
	const mediaIds: string[] = [];
	const postIds: string[] = [];

	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test.afterEach(async ({ page, serverInfo }) => {
		const headers = csrfHeaders(serverInfo.token);
		for (const id of postIds.splice(0)) {
			await page.request.delete(`/_emdash/api/content/posts/${id}?locale=en`, { headers });
			await page.request.delete(`/_emdash/api/content/posts/${id}/permanent`, { headers });
		}
		for (const id of mediaIds.splice(0)) {
			await page.request.delete(`/_emdash/api/media/${id}`, { headers });
		}
	});

	test("uploads a dropped image to the media library and saves it in place", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const id = await createPost(page.request, serverInfo, `image-drop-${crypto.randomUUID()}`);
		postIds.push(id);
		await admin.goToEditContent("posts", id);
		await admin.waitForLoading();
		const editor = page.locator(EDITOR);
		await expect(editor).toBeEditable();

		const release = await holdUploads(page);
		const transfer = await imageTransfer(page, `drop-${crypto.randomUUID()}.png`);
		try {
			await dropOn(editor.locator("p", { hasText: "First" }), transfer);
		} finally {
			await transfer.dispose();
		}

		const placeholder = page.locator(PLACEHOLDER);
		await expect(placeholder.getByRole("status")).toHaveText("Uploading image…");
		await expect(placeholder.locator("img")).toHaveAttribute("src", /^blob:/);

		const response = uploadResponse(page);
		release();
		const uploaded = (await (await response).json()) as { data: { item: UploadedImage } };
		mediaIds.push(uploaded.data.item.id);

		await expect(placeholder).toHaveCount(0);
		const image = editor.locator(`img[src*="${uploaded.data.item.storageKey}"]`);
		await expect(image).toBeVisible();
		await expect
			.poll(() => savedBody(page.request, id), { timeout: 20_000 })
			.toEqual(["First", `image:${uploaded.data.item.id}`, "Second"]);

		await page.reload();
		await expect(
			page.locator(EDITOR).locator(`img[src*="${uploaded.data.item.storageKey}"]`),
		).toBeVisible();
	});

	test("uploads a pasted screenshot below the current paragraph", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const id = await createPost(page.request, serverInfo, `image-paste-${crypto.randomUUID()}`);
		postIds.push(id);
		await admin.goToEditContent("posts", id);
		await admin.waitForLoading();
		const editor = page.locator(EDITOR);
		await expect(editor).toBeEditable();
		await editor.locator("p", { hasText: "First" }).click();
		await page.keyboard.press("End");

		const transfer = await imageTransfer(page, `paste-${crypto.randomUUID()}.png`);
		const response = uploadResponse(page);
		try {
			await editor.evaluate((element, data) => {
				element.dispatchEvent(
					new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData: data }),
				);
			}, transfer);
		} finally {
			await transfer.dispose();
		}
		const uploaded = (await (await response).json()) as { data: { item: UploadedImage } };
		mediaIds.push(uploaded.data.item.id);

		await expect
			.poll(() => savedBody(page.request, id), { timeout: 20_000 })
			.toEqual(["First", `image:${uploaded.data.item.id}`, "Second"]);
	});

	test("shows the server's reason when an upload fails", async ({ admin, page, serverInfo }) => {
		const id = await createPost(page.request, serverInfo, `image-fail-${crypto.randomUUID()}`);
		postIds.push(id);
		await page.route(
			(url) => url.pathname === UPLOAD_URL_PATH,
			(route) =>
				route.fulfill({
					status: 413,
					contentType: "application/json",
					body: JSON.stringify({
						error: { code: "PAYLOAD_TOO_LARGE", message: "File exceeds the upload limit" },
					}),
				}),
		);
		await admin.goToEditContent("posts", id);
		await admin.waitForLoading();
		const editor = page.locator(EDITOR);
		await expect(editor).toBeEditable();

		const transfer = await imageTransfer(page, "too-big.png");
		try {
			await dropOn(editor.locator("p", { hasText: "First" }), transfer);
		} finally {
			await transfer.dispose();
		}

		const placeholder = page.locator(PLACEHOLDER);
		await expect(placeholder.getByRole("alert")).toHaveText("File exceeds the upload limit");
		await placeholder.getByRole("button", { name: "Dismiss" }).click();
		await expect(placeholder).toHaveCount(0);
		expect(await savedBody(page.request, id)).toEqual(["First", "Second"]);
	});
});
