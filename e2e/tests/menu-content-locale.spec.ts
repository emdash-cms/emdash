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
	await page.getByRole("button", { name: "Add items" }).first().click();
	const dialog = page.getByRole("dialog", { name: "Add items", exact: true });
	await dialog.getByRole("combobox", { name: "Source" }).click();
	await page.getByRole("option", { name: "Pages", exact: true }).click();
	await dialog.getByRole("textbox", { name: "Search" }).fill("Menu Contact");
	const pick = dialog.getByRole("checkbox", { name: "Menu Contact", exact: true });
	await expect(pick).toHaveCount(1);
	await pick.click();
	await dialog.getByRole("button", { name: "Add 1 item", exact: true }).click();
	await expect(dialog).not.toBeVisible();
	await expect(page.getByRole("dialog", { name: "Added 1 item", exact: true })).toBeVisible();
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
