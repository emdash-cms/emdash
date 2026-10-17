import type { APIRequestContext } from "@playwright/test";

import { test, expect } from "../fixtures";

const EDITOR = "#field-body .ProseMirror";
const IMAGE_URL = "http://media.example.test/editor-toolbar.png";
const csrfHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	"X-EmDash-Request": "1",
});

async function savedImage(request: APIRequestContext, id: string) {
	const response = await request.get(`/_emdash/api/content/posts/${id}?locale=en`);
	const payload = (await response.json()) as {
		data?: { item?: { data?: { body?: Array<Record<string, unknown>> } } };
	};
	const image = payload.data?.item?.data?.body?.find((block) => block._type === "image");
	return { alt: image?.alt, caption: image?.caption };
}

async function createImagePost(request: APIRequestContext, token: string) {
	const slug = `image-toolbar-${crypto.randomUUID()}`;
	const response = await request.post("/_emdash/api/content/posts", {
		headers: csrfHeaders(token),
		data: {
			slug,
			data: {
				title: slug,
				body: [
					{
						_type: "image",
						_key: "image-1",
						asset: { _ref: "", url: IMAGE_URL },
						alt: "editor-toolbar.png",
					},
				],
			},
		},
	});
	expect(response.ok(), await response.text()).toBe(true);
	const payload = (await response.json()) as { data: { item?: { id: string }; id?: string } };
	return payload.data.item?.id ?? payload.data.id!;
}

test.describe("Editor image toolbar", () => {
	const postIds: string[] = [];

	test.beforeEach(async ({ admin, page }) => {
		await admin.devBypassAuth();
		await page.route(IMAGE_URL, (route) =>
			route.fulfill({
				body: '<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="800"><rect width="1200" height="800" fill="gray"/></svg>',
				contentType: "image/svg+xml",
			}),
		);
	});

	test.afterEach(async ({ page, serverInfo }) => {
		const headers = csrfHeaders(serverInfo.token);
		for (const id of postIds.splice(0)) {
			await page.request.delete(`/_emdash/api/content/posts/${id}?locale=en`, { headers });
			await page.request.delete(`/_emdash/api/content/posts/${id}/permanent`, { headers });
		}
	});

	test("saves a caption typed under the image and alt text set in the toolbar", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const id = await createImagePost(page.request, serverInfo.token);
		postIds.push(id);

		await admin.goToEditContent("posts", id);
		await admin.waitForLoading();
		const editor = page.locator(EDITOR);
		await editor.getByRole("img", { name: "editor-toolbar.png" }).click();

		const toolbar = page.getByRole("toolbar", { name: "Image controls" });
		await toolbar.getByRole("button", { name: "Alt text" }).click();
		await toolbar.getByRole("textbox", { name: "Alt text" }).fill("A grey test card");
		await page.keyboard.press("Enter");
		await editor.getByRole("textbox", { name: "Caption" }).fill("Seen from the harbour");

		await expect
			.poll(() => savedImage(page.request, id), { timeout: 20_000 })
			.toEqual({ alt: "A grey test card", caption: "Seen from the harbour" });

		await page.reload();
		const reloaded = page.locator(EDITOR);
		await expect(reloaded.getByRole("textbox", { name: "Caption" })).toHaveValue(
			"Seen from the harbour",
		);
		await expect(reloaded.getByRole("img", { name: "A grey test card" })).toBeVisible();
	});

	test("keeps an IME composition in the caption until it is committed", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const id = await createImagePost(page.request, serverInfo.token);
		postIds.push(id);

		await admin.goToEditContent("posts", id);
		await admin.waitForLoading();
		const editor = page.locator(EDITOR);
		const caption = editor.getByRole("textbox", { name: "Caption" });
		await caption.click();
		await expect(caption).toBeFocused();
		// A real IME commits its unconverted text when the editor re-renders mid-composition.
		await editor.evaluate((dom) => {
			type Tiptap = {
				on(
					event: "transaction",
					fn: (event: { transaction: { docChanged: boolean } }) => void,
				): void;
			};
			const tiptap = (dom as HTMLElement & { editor: Tiptap }).editor;
			tiptap.on("transaction", ({ transaction }) => {
				if (transaction.docChanged)
					dom.dataset.docChanges = String(Number(dom.dataset.docChanges ?? 0) + 1);
			});
		});

		// Type きむら and convert it to 木村, as a Japanese IME does.
		const cdp = await page.context().newCDPSession(page);
		for (const text of ["ｋ", "き", "きｍ", "きむ", "きむｒ", "きむら", "木村"]) {
			await cdp.send("Input.imeSetComposition", {
				text,
				selectionStart: text.length,
				selectionEnd: text.length,
			});
		}
		await expect(caption).toHaveValue("木村");
		await expect(editor).not.toHaveAttribute("data-doc-changes");

		await cdp.send("Input.insertText", { text: "木村" });
		await expect(caption).toHaveValue("木村");
		await expect(editor).toHaveAttribute("data-doc-changes", "1");
		await expect
			.poll(() => savedImage(page.request, id), { timeout: 20_000 })
			.toEqual({ alt: "editor-toolbar.png", caption: "木村" });
	});
});
