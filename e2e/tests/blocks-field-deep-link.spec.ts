import { test, expect } from "../fixtures";

const csrfHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	"X-EmDash-Request": "1",
	"Content-Type": "application/json",
});

test.describe("blocks field deep links", () => {
	test("opens the addressed block and focuses nested fields", async ({
		admin,
		page,
		serverInfo,
	}) => {
		test.setTimeout(90_000);
		await admin.devBypassAuth();
		const headers = csrfHeaders(serverInfo.token);
		const suffix = crypto.randomUUID().slice(0, 8);
		const collection = `deep_link_${suffix}`;
		const blockType = `deep_link_block_${suffix}`;
		const slug = `deep-link-${suffix}`;

		const create = async (url: string, body: unknown) => {
			const response = await page.request.post(url, { headers, data: body });
			expect(response.ok(), `${url}: ${await response.text()}`).toBe(true);
			return response.json();
		};

		await create("/_emdash/api/schema/block-types", {
			slug: blockType,
			label: "Deep Link Block",
			fields: [
				{ slug: "heading", label: "Heading", type: "string" },
				{
					slug: "anchor_id",
					label: "Section ID",
					type: "string",
					validation: { pattern: "^(?:$|[a-z][a-z0-9_-]*)$" },
				},
				{
					slug: "items",
					label: "Items",
					type: "repeater",
					validation: {
						subFields: [{ slug: "label", label: "Label", type: "string" }],
					},
				},
			],
		});
		await create("/_emdash/api/schema/collections", {
			slug: collection,
			label: "Deep Link Pages",
			labelSingular: "Deep Link Page",
			routable: false,
		});
		await create(`/_emdash/api/schema/collections/${collection}/fields`, {
			slug: "title",
			label: "Title",
			type: "string",
			required: true,
		});
		await create(`/_emdash/api/schema/collections/${collection}/fields`, {
			slug: "layout",
			label: "Layout",
			type: "blocks",
			validation: { allowedTypes: [blockType] },
		});
		const entryResponse = await create(`/_emdash/api/content/${collection}`, {
			slug,
			data: {
				title: "Top-level title",
				layout: [
					{
						_type: blockType,
						_key: "services",
						_version: 1,
						heading: "Services heading",
						anchor_id: "services-section",
						items: [{ label: "Service item" }],
					},
				],
			},
		});
		const id = entryResponse.data.item.id;

		try {
			const edit = `/_emdash/admin/content/${collection}/${id}`;
			await page.goto(`${edit}?locale=en&field=layout.services.heading`);
			await admin.waitForShell();
			await admin.waitForLoading();

			const heading = page.locator('[id="field-layout.services.heading"]');
			await expect(
				page.getByRole("button", { name: "Deep Link Block", exact: true }),
			).toHaveAttribute("aria-expanded", "true");
			await expect(heading).toBeVisible();
			await expect(heading).toBeFocused();
			await expect(page).not.toHaveURL(/[?&]field=/);
			await expect(page).toHaveURL(/[?&]locale=en/);
			await expect(page.getByRole("button", { name: /^Advanced/ })).toHaveAttribute(
				"aria-expanded",
				"false",
			);

			await page.goto(`${edit}?field=layout.services.anchor_id`);
			await admin.waitForLoading();
			const advanced = page.locator('[id="field-layout.services.anchor_id"]');
			await expect(advanced).toBeVisible();
			await expect(advanced).toBeFocused();
			await expect(page.getByRole("button", { name: /^Advanced/ })).toHaveAttribute(
				"aria-expanded",
				"true",
			);

			await page.goto(`${edit}?field=layout.services.items`);
			await admin.waitForLoading();
			await expect(page.getByRole("textbox", { name: "Label 1", exact: true })).toBeFocused();

			await page.goto(`${edit}?field=layout.missing.heading`);
			await admin.waitForLoading();
			await expect(
				page.getByRole("button", { name: "Deep Link Block", exact: true }),
			).toHaveAttribute("aria-expanded", "false");
			await expect(page).toHaveURL(/field=layout.missing.heading/);
			await expect(page.locator('[id="field-layout.missing.heading"]')).toHaveCount(0);
		} finally {
			await page.request.delete(`/_emdash/api/content/${collection}/${id}`, { headers });
			await page.request.delete(`/_emdash/api/schema/collections/${collection}`, { headers });
			await page.request.delete(`/_emdash/api/schema/block-types/${blockType}`, { headers });
		}
	});
});
