import { test, expect } from "../fixtures";

test("menu content picker only offers entries in the menu locale", async ({
	admin,
	page,
	serverInfo,
}) => {
	await admin.devBypassAuth();
	const headers = {
		Authorization: `Bearer ${serverInfo.token}`,
		"X-EmDash-Request": "1",
		Origin: serverInfo.baseUrl,
	};
	const slug = `menu-contact-${Date.now()}`;
	let englishId = "";
	for (const locale of ["en", "fr"]) {
		const response = await page.request.post("/_emdash/api/content/pages", {
			headers,
			data: {
				data: { title: "Menu Contact" },
				slug,
				locale,
				translationOf: englishId || undefined,
			},
		});
		expect(response.ok()).toBeTruthy();
		const body = await response.json();
		if (locale === "en") englishId = body.data.item?.id ?? body.data.id;
	}
	const name = `picker-locale-${Date.now()}`;
	const response = await page.request.post("/_emdash/api/menus", {
		headers,
		data: { name, label: "French navigation", locale: "fr" },
	});
	expect(response.ok()).toBeTruthy();

	// Omit the URL locale to exercise the loaded menu's locale fallback.
	await page.goto(`/_emdash/admin/menus/${name}`);
	await admin.waitForLoading();
	await page.getByRole("button", { name: "Add Content" }).first().click();
	const dialog = page.getByRole("dialog", { name: "Select content" });
	await dialog.getByRole("combobox").click();
	await page.getByRole("option", { name: "Pages", exact: true }).click();
	await dialog.getByPlaceholder("Search content...").fill("Menu Contact");
	await expect(dialog.getByRole("button", { name: /Menu Contact/ })).toHaveCount(1);
	await dialog.getByRole("button", { name: /Menu Contact/ }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByRole("dialog", { name: "Item added", exact: true })).toBeVisible();
	const menuResponse = await page.request.get(`/_emdash/api/menus/${name}?locale=fr`, {
		headers,
	});
	const menuBody = await menuResponse.json();
	expect(menuBody.data.items).toHaveLength(1);
	expect(menuBody.data.items[0]).toMatchObject({
		type: "page",
		referenceCollection: "pages",
		label: "Menu Contact",
	});
});
