import { test, expect } from "../fixtures";

const EMBED_URL = "https://embed.example.test/chart";

test.describe("Iframe block sizing", () => {
	test.beforeEach(async ({ admin, page }) => {
		await admin.devBypassAuth();
		await page.route(EMBED_URL, (route) =>
			route.fulfill({ contentType: "text/html", body: "<p>Chart content</p>" }),
		);
	});

	for (const [name, dimensions] of [
		["default ratio", {}],
		["custom ratio", { width: 800, height: 400 }],
		["height only", { height: 450 }],
	] as const) {
		test(`keeps following content below a resized iframe with ${name}`, async ({
			page,
			serverInfo,
		}) => {
			const headers = { Authorization: `Bearer ${serverInfo.token}`, "X-EmDash-Request": "1" };
			const slug = `iframe-sizing-${crypto.randomUUID().slice(0, 8)}`;
			const created = await page.request.post("/_emdash/api/content/posts", {
				headers,
				data: {
					slug,
					data: {
						title: "Iframe sizing",
						body: [
							{ _type: "iframe", _key: "chart", src: EMBED_URL, ...dimensions },
							{
								_type: "block",
								_key: "following",
								style: "normal",
								markDefs: [],
								children: [
									{ _type: "span", _key: "text", text: "Following article content", marks: [] },
								],
							},
						],
					},
				},
			});
			expect(created.ok(), await created.text()).toBe(true);
			const { data } = (await created.json()) as { data: { item: { id: string } } };
			const id = data.item.id;

			try {
				const published = await page.request.post(`/_emdash/api/content/posts/${id}/publish`, {
					headers,
					data: {},
				});
				expect(published.ok(), await published.text()).toBe(true);
				await page.goto(`/posts/${slug}`);
				const frame = page.locator(".emdash-iframe iframe");
				await expect(frame).toBeVisible();

				for (const viewportWidth of [1280, 390]) {
					await page.setViewportSize({ width: viewportWidth, height: 1000 });
					const initialHeight =
						"height" in dimensions && !("width" in dimensions) ? dimensions.height : null;
					await frame.evaluate((element, height) => {
						element.style.removeProperty("height");
						if (height === null) element.removeAttribute("height");
						else element.setAttribute("height", String(height));
					}, initialHeight);
					const initialBox = await frame.boundingBox();
					if (!initialBox) throw new Error("The iframe is not visible");
					const ratio = "width" in dimensions ? dimensions.width / dimensions.height : 16 / 9;
					expect(initialBox.height).toBeCloseTo(initialHeight ?? initialBox.width / ratio, 0);
					for (const method of ["attribute", "style"] as const) {
						for (const height of [640, 240]) {
							await frame.evaluate(
								(element, size) => {
									if (size.method === "attribute") {
										element.style.removeProperty("height");
										element.setAttribute("height", String(size.height));
									} else {
										element.style.height = `${size.height}px`;
									}
								},
								{ method, height },
							);
							await expect
								.poll(async () => (await frame.boundingBox())?.height)
								.toBeCloseTo(height, 0);
							const frameBox = await frame.boundingBox();
							const followingBox = await page.getByText("Following article content").boundingBox();
							if (!frameBox || !followingBox) throw new Error("The article content is not visible");
							expect(followingBox.y).toBeGreaterThanOrEqual(frameBox.y + frameBox.height);
						}
					}
				}
			} finally {
				await page.request.delete(`/_emdash/api/content/posts/${id}`, { headers });
				await page.request.delete(`/_emdash/api/content/posts/${id}/permanent`, { headers });
			}
		});
	}

	test("saves and reopens the complete embed after explicit HTML conversion", async ({
		admin,
		page,
		serverInfo,
	}) => {
		const headers = { Authorization: `Bearer ${serverInfo.token}`, "X-EmDash-Request": "1" };
		const html =
			'<div class="chart"><iframe src="https://embed.example.test/chart" data-theme="auto"></iframe><script src="https://embed.example.test/resize.js"></script></div>';
		const created = await page.request.post("/_emdash/api/content/posts", {
			headers,
			data: {
				slug: `iframe-conversion-${crypto.randomUUID().slice(0, 8)}`,
				data: {
					title: "Iframe conversion",
					body: [{ _type: "iframe", _key: "chart", src: EMBED_URL }],
				},
			},
		});
		expect(created.ok(), await created.text()).toBe(true);
		const { data } = (await created.json()) as { data: { item: { id: string } } };
		const id = data.item.id;

		try {
			await admin.goToEditContent("posts", id);
			await admin.waitForLoading();
			await page.getByRole("tab", { name: "Code", exact: true }).click();
			await page.getByRole("textbox", { name: "Embed code", exact: true }).fill(html);
			await page.getByRole("button", { name: "Use as HTML block", exact: true }).click();
			await expect(page.getByRole("button", { name: "Run preview", exact: true })).toBeVisible();
			await admin.clickSave();
			await admin.waitForSaveComplete();
			await page.reload();
			await admin.waitForLoading();
			await page.getByRole("tab", { name: "HTML", exact: true }).click();
			await expect(page.getByRole("textbox", { name: "HTML code", exact: true })).toHaveText(html);

			const saved = await page.request.get(`/_emdash/api/content/posts/${id}?locale=en`, {
				headers,
			});
			expect(saved.ok(), await saved.text()).toBe(true);
			expect((await saved.json()).data.item.data.body).toEqual([
				{ _type: "htmlBlock", _key: "chart", html, isolated: true },
			]);
		} finally {
			await page.request.delete(`/_emdash/api/content/posts/${id}`, { headers });
			await page.request.delete(`/_emdash/api/content/posts/${id}/permanent`, { headers });
		}
	});
});
