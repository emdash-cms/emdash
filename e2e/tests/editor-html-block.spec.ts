import { test, expect } from "../fixtures";

test.describe("HTML block", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test("runs its HTML, CSS and JavaScript in a sandboxed frame on the published page", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const headers = { Authorization: `Bearer ${serverInfo.token}`, "X-EmDash-Request": "1" };
		const slug = `html-block-${crypto.randomUUID().slice(0, 8)}`;
		const created = await page.request.post("/_emdash/api/content/posts", {
			headers,
			data: { data: { title: "HTML block" }, slug },
		});
		expect(created.ok(), await created.text()).toBe(true);
		const { data } = (await created.json()) as { data: { item: { id: string } } };
		const id = data.item.id;

		try {
			await admin.goToEditContent("posts", id);
			await admin.waitForLoading();

			await page.locator(".ProseMirror").first().click();
			await page.keyboard.type("/html");
			await page.keyboard.press("Enter");
			const code = page.locator(".html-block .cm-content");
			await expect(code).toBeFocused();
			await page.keyboard.insertText('<p id="out">Waiting</p>');

			await page.getByRole("tab", { name: "CSS" }).click();
			await code.click();
			await page.keyboard.insertText("#out { color: rgb(200, 0, 0); min-height: 320px; }");

			await page.getByRole("tab", { name: "JS" }).click();
			await code.click();
			await page.keyboard.insertText(
				"let reachable = true;" +
					"try { parent.document.title; } catch { reachable = false; }" +
					'document.getElementById("out").textContent = reachable ? "reachable" : "isolated";',
			);

			await admin.clickSave();
			await admin.waitForSaveComplete();
			const published = await page.request.post(`/_emdash/api/content/posts/${id}/publish`, {
				headers,
				data: {},
			});
			expect(published.ok(), await published.text()).toBe(true);

			await page.goto(`/posts/${slug}`);
			const frame = page.frameLocator("iframe[data-emdash-html-block]");
			await expect(frame.locator("#out")).toHaveText("isolated");
			await expect(frame.locator("#out")).toHaveCSS("color", "rgb(200, 0, 0)");
			await expect
				.poll(
					async () =>
						(await page.locator("iframe[data-emdash-html-block]").boundingBox())?.height ?? 0,
				)
				.toBeGreaterThan(150);
		} finally {
			await page.request.delete(`/_emdash/api/content/posts/${id}`, { headers });
			await page.request.delete(`/_emdash/api/content/posts/${id}/permanent`, { headers });
		}
	});
});
