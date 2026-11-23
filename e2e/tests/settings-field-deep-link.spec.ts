import { test, expect } from "../fixtures";

const csrfHeaders = (token: string, origin: string) => ({
	Authorization: `Bearer ${token}`,
	"X-EmDash-Request": "1",
	"Content-Type": "application/json",
	Origin: origin,
});

test.describe("settings field deep links", () => {
	test("focuses settings aliases and preserves the locale", async ({ admin, page, serverInfo }) => {
		test.setTimeout(90_000);
		await page.addInitScript(() => {
			localStorage.setItem("emdash-editor-settings-panel", "hidden");
		});
		await admin.devBypassAuth();

		const headers = csrfHeaders(serverInfo.token, serverInfo.baseUrl);
		const suffix = crypto.randomUUID().slice(0, 8);
		const collection = `settings_link_${suffix}`;
		const slug = `settings-link-${suffix}`;

		const create = async (url: string, body: unknown) => {
			const response = await page.request.post(url, { headers, data: body });
			expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
			return response.json();
		};

		await create("/_emdash/api/schema/collections", {
			slug: collection,
			label: "Settings Link Pages",
			labelSingular: "Settings Link Page",
			supports: ["revisions", "drafts"],
			hasSeo: true,
			routable: false,
		});
		await create(`/_emdash/api/schema/collections/${collection}/fields`, {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		const entryResponse = await create(`/_emdash/api/content/${collection}`, {
			slug,
			data: { title: "Settings link entry" },
		});
		const id = entryResponse.data.item.id as string;
		await create(`/_emdash/api/content/${collection}/${id}/publish`, {});

		const edit = `/_emdash/admin/content/${collection}/${id}`;
		const settingsPanel = page
			.getByRole("complementary", { name: "Settings", includeHidden: true })
			.or(page.getByRole("navigation", { name: "Settings", includeHidden: true }));

		try {
			for (const viewport of [
				{ width: 1280, height: 800 },
				{ width: 390, height: 844 },
			]) {
				await page.setViewportSize(viewport);
				await page.goto(`${edit}?locale=en&field=slug`);
				if (viewport.width === 1280) await admin.waitForShell();
				await admin.waitForLoading();
				await expect(page.getByLabel("Slug", { exact: true })).toBeFocused();
				await expect(page).not.toHaveURL(/[?&]field=/);
				await expect(page).toHaveURL(/[?&]locale=en(?:&|$)/);
				await expect(settingsPanel).not.toHaveAttribute("inert");
				expect(
					await page.evaluate(() => localStorage.getItem("emdash-editor-settings-panel")),
				).toBe("hidden");
				if (viewport.width === 390) {
					await expect(page.getByRole("navigation", { name: "Settings" })).not.toHaveAttribute(
						"inert",
					);
				}
			}

			for (const [field, control] of [
				["publishedAt", page.getByRole("button", { name: /^Change publication date:/ })],
				["bylines", page.getByRole("button", { name: "Choose bylines" })],
				["slug", page.getByLabel("Slug", { exact: true })],
				["seo", page.getByLabel("SEO Title", { exact: true })],
			] as const) {
				await page.goto(`${edit}?locale=en&field=${field}`);
				await admin.waitForLoading();
				await expect(control).toBeFocused();
				await expect(page).toHaveURL(/[?&]locale=en(?:&|$)/);
				await expect(page).not.toHaveURL(/[?&]field=/);
			}

			await page
				.context()
				.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/" }]);
			await page.goto(`${edit}?locale=en&field=slug`);
			await admin.waitForLoading();
			await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
			await expect(
				page.locator('input[data-settings-field="slug"], [data-settings-field="slug"] input'),
			).toBeFocused();
			await expect(page).not.toHaveURL(/[?&]field=/);
		} finally {
			await page.request.delete(`/_emdash/api/content/${collection}/${id}`, { headers });
			await page.request.delete(`/_emdash/api/schema/collections/${collection}`, { headers });
		}
	});
});
