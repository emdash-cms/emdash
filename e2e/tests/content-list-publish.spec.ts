import { expect, pinSingleEditor, test } from "../fixtures";

for (const collection of ["posts", "pages"]) {
	for (const navigation of ["browser back", "editor back", "sidebar"]) {
		test(`${collection} list shows the published title after ${navigation}`, async ({
			admin,
			context,
			page,
			serverInfo,
		}) => {
			await pinSingleEditor(context, serverInfo.baseUrl);
			await admin.devBypassAuth();
			const headers = { "X-EmDash-Request": "1" };
			const originalTitle = "Original published title";
			const updatedTitle = "Updated published title";
			const created = await page.request.post(`/_emdash/api/content/${collection}`, {
				headers,
				data: {
					slug: `list-publish-${Date.now()}`,
					data: { title: originalTitle },
				},
			});
			expect(created.ok()).toBe(true);
			const { data } = await created.json();
			const contentUrl = `/_emdash/api/content/${collection}/${data.item.id}`;
			try {
				const published = await page.request.post(`${contentUrl}/publish`, {
					headers,
					data: {},
				});
				expect(published.ok()).toBe(true);
				await admin.goToContent(collection);
				await page.getByRole("link", { name: originalTitle, exact: true }).click();
				await expect(page.locator("#field-title")).toHaveValue(originalTitle);
				await page.locator("#field-title").fill(updatedTitle);
				await page.getByRole("button", { name: "Publish changes", exact: true }).click();
				const publishResponse = page.waitForResponse(
					(response) =>
						new URL(response.url()).pathname === `${contentUrl}/publish` &&
						response.request().method() === "POST",
				);
				await page
					.getByRole("dialog", { name: "Publish changes?" })
					.getByRole("button", { name: "Publish changes", exact: true })
					.click();
				expect((await publishResponse).ok()).toBe(true);
				await expect(page.getByText("Content is now live", { exact: true })).toBeVisible();

				if (navigation === "browser back") {
					await page.goBack();
				} else if (navigation === "editor back") {
					await page
						.getByRole("link", {
							name: `Back to ${collection === "posts" ? "Posts" : "Pages"} list`,
						})
						.click();
				} else {
					await page
						.getByRole("complementary", { name: "Admin navigation" })
						.getByRole("link", { name: collection === "posts" ? "Posts" : "Pages", exact: true })
						.click();
				}
				await expect(page.getByRole("link", { name: updatedTitle, exact: true })).toBeVisible();
				await expect(page.getByRole("link", { name: originalTitle, exact: true })).toHaveCount(0);
			} finally {
				await page.request.delete(contentUrl, { headers });
			}
		});
	}
}
