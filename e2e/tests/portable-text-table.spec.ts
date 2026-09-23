import AxeBuilder from "@axe-core/playwright";
import type { APIRequestContext, Locator, Page } from "@playwright/test";

import { test, expect, type AdminPage, type ServerInfo } from "../fixtures";

const EDITOR = "#field-body .ProseMirror";
const CROSS_ENGINE = "@table-cross-engine";
const csrfHeaders = (token: string) => ({
	Authorization: `Bearer ${token}`,
	"X-EmDash-Request": "1",
});

async function expectCaretIn(cell: Locator) {
	await expect
		.poll(() =>
			cell.evaluate((element) => element.contains(window.getSelection()?.anchorNode ?? null)),
		)
		.toBe(true);
}

async function openNewPost(admin: AdminPage, localized = false) {
	if (localized) {
		await admin.goto("/content/posts/new");
		await admin.page.waitForSelector("astro-island:not([ssr])", { timeout: 30_000 });
		await admin.page.locator("main").waitFor({ state: "visible", timeout: 30_000 });
	} else {
		await admin.goToNewContent("posts");
		await admin.waitForLoading();
	}
	const editor = admin.page.locator(EDITOR);
	await expect(editor).toBeEditable();
	return editor;
}

async function openTableMenu(page: Page) {
	const trigger = page.locator("#field-body [data-emdash-table-trigger]");
	const menu = page.locator('[role="menu"]:visible');
	if ((await trigger.getAttribute("aria-expanded")) !== "true") {
		await expect(menu).toHaveCount(0);
		await trigger.click();
	}
	await expect(menu).toBeVisible();
	return menu;
}

async function runTableAction(page: Page, name: string) {
	const menu = await openTableMenu(page);
	const item = menu.getByText(name, { exact: true });
	await expect(item).toBeVisible();
	await item.click();
}

async function insertTable(page: Page, rows: number, columns: number, header = true) {
	await page.locator("#field-body [data-emdash-table-trigger]").click();
	await page.locator('[role="menu"]:visible').getByRole("menuitem").first().click();
	const picker = page.getByRole("grid", { name: "Table size" });
	await expect(picker).toBeVisible();
	if (!header) await page.getByRole("switch", { name: "Header row" }).click();
	await picker.getByRole("gridcell", { name: `${rows} × ${columns} table` }).click();
	await expect(picker).not.toBeVisible();
}

async function paste(page: Page, data: Record<string, string>) {
	await page.locator(EDITOR).evaluate((editor, values) => {
		const event = new ClipboardEvent("paste", {
			bubbles: true,
			cancelable: true,
			clipboardData: new DataTransfer(),
		});
		for (const [type, value] of Object.entries(values)) event.clipboardData!.setData(type, value);
		editor.dispatchEvent(event);
	}, data);
}

async function createPost(
	request: APIRequestContext,
	info: ServerInfo,
	slug: string,
	body: unknown[],
) {
	const response = await request.post("/_emdash/api/content/posts", {
		headers: csrfHeaders(info.token),
		data: { data: { title: slug, body }, slug },
	});
	expect(response.ok()).toBe(true);
	const payload = (await response.json()) as { data: { item?: { id: string }; id?: string } };
	return payload.data.item?.id ?? payload.data.id!;
}

function monitorErrors(page: Page) {
	const errors: string[] = [];
	page.on("pageerror", (error) => errors.push(error.message));
	page.on("console", (message) => {
		if (message.type() === "error") errors.push(`${message.text()} (${message.location().url})`);
	});
	return () => expect(errors).toEqual([]);
}

test.describe("Portable Text tables", () => {
	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	test(`inserts from the toolbar and slash picker with complete keyboard focus ${CROSS_ENGINE}`, async ({
		admin,
	}) => {
		test.setTimeout(60_000);
		const { page } = admin;
		const assertNoErrors = monitorErrors(page);
		const editor = await openNewPost(admin);

		await insertTable(page, 2, 3);
		const table = editor.locator("table");
		await expect(table.locator("tr")).toHaveCount(2);
		await expect(table.locator("th")).toHaveCount(3);
		await expect(table.locator("td")).toHaveCount(3);
		await expect(page.getByText("Table inserted", { exact: true })).toBeAttached();
		await expectCaretIn(table.locator("th").first());

		await page.keyboard.press("Tab");
		await expectCaretIn(table.locator("th").nth(1));
		await page.keyboard.press("Shift+Tab");
		await expectCaretIn(table.locator("th").first());
		for (let index = 0; index < 5; index++) await page.keyboard.press("Tab");
		await expectCaretIn(table.locator("td").last());
		await page.keyboard.press("Tab");
		await expect(table.locator("tr")).toHaveCount(3);
		await page.getByRole("button", { name: "Undo" }).click();
		await expect(table.locator("tr")).toHaveCount(2);
		await page.getByRole("button", { name: "Redo" }).click();
		await expect(table.locator("tr")).toHaveCount(3);

		await runTableAction(page, "Delete table");
		const trailing = editor.locator(":scope > p").last();
		await trailing.click();
		await page.keyboard.type("/table");
		const slash = page.getByRole("dialog", { name: "Insert block" });
		await slash.getByText("Table", { exact: true }).click();
		const picker = page.getByRole("grid", { name: "Table size" });
		await expect(picker.getByRole("gridcell", { name: "1 × 1 table" })).toBeFocused();
		const accessibility = await new AxeBuilder({ page })
			.include('[role="dialog"]:has([role="grid"][aria-label="Table size"])')
			.exclude("[data-base-ui-focus-guard]")
			.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
			.analyze();
		expect(accessibility.violations).toEqual([]);
		await page.keyboard.press("Control+End");
		await expect(picker.getByRole("gridcell", { name: "10 × 10 table" })).toBeFocused();
		await page.keyboard.press("Escape");
		await expect(editor).toContainText("/table");

		const slashEditor = await openNewPost(admin);
		await slashEditor.locator("p").first().click();
		await page.keyboard.type("/table");
		await slash.getByText("Table", { exact: true }).click();
		await page.keyboard.press("ArrowRight");
		await page.keyboard.press("ArrowDown");
		await page.keyboard.press("Enter");
		await expect(slashEditor.locator("table tr")).toHaveCount(2);
		await expect(slashEditor.locator("table tr").first().locator("th")).toHaveCount(2);
		assertNoErrors();
	});

	test("runs every grouped structural action and history path", async ({ admin }) => {
		const { page } = admin;
		let editor = await openNewPost(admin);
		await insertTable(page, 3, 3, false);
		let table = editor.locator("table");

		await table.locator("td").first().click();
		await runTableAction(page, "Select row");
		await expect(table.locator(".selectedCell")).toHaveCount(3);
		await runTableAction(page, "Add row above");
		await expect(table.locator("tr")).toHaveCount(4);
		await runTableAction(page, "Add row below");
		await expect(table.locator("tr")).toHaveCount(5);
		await runTableAction(page, "Delete row");
		await expect(table.locator("tr")).toHaveCount(4);
		await runTableAction(page, "Select row");
		await page.keyboard.press("Backspace");
		await expect(table.locator("tr")).toHaveCount(3);
		await expect(page.getByText("Row deleted", { exact: true })).toBeAttached();
		await page.keyboard.press("ControlOrMeta+z");
		await expect(table.locator("tr")).toHaveCount(4);

		await table.locator("td").first().click();
		await runTableAction(page, "Select column");
		await expect(table.locator(".selectedCell")).toHaveCount(4);
		await runTableAction(page, "Add column before");
		await expect(table.locator("tr").first().locator("td")).toHaveCount(4);
		await runTableAction(page, "Add column after");
		await expect(table.locator("tr").first().locator("td")).toHaveCount(5);
		await runTableAction(page, "Delete column");
		await expect(table.locator("tr").first().locator("td")).toHaveCount(4);
		await expect(table.locator(".selectedCell")).toHaveCount(4);
		await page.keyboard.press("Delete");
		await expect(table.locator("tr").first().locator("td")).toHaveCount(3);
		await expect(page.getByText("Column deleted", { exact: true })).toBeAttached();
		await page.keyboard.press("ControlOrMeta+z");
		await expect(table.locator("tr").first().locator("td")).toHaveCount(4);

		await table.locator("td").first().click();
		await runTableAction(page, "Toggle header row");
		await expect(table.locator("tr").first().locator("th")).toHaveCount(4);
		await runTableAction(page, "Toggle header column");
		await expect(table.locator("tr").nth(1).locator("th")).toHaveCount(1);

		editor = await openNewPost(admin);
		await insertTable(page, 2, 3, false);
		table = editor.locator("table");
		await page.keyboard.press("Shift+ArrowRight");
		await expect(table.locator(".selectedCell")).toHaveCount(2);
		await runTableAction(page, "Merge selected cells");
		await expect(table.locator("td[colspan='2']")).toHaveCount(1);
		await runTableAction(page, "Split merged cell");
		await expect(table.locator("td[colspan='2']")).toHaveCount(0);

		await table.locator("td").first().click();
		await runTableAction(page, "Increase column width");
		await expect(table.locator("col").first()).toHaveAttribute("style", /width/);
		await runTableAction(page, "Decrease column width");
		await runTableAction(page, "Distribute columns evenly");
		await runTableAction(page, "Reset column widths");
		await expect(table.locator("col").first()).not.toHaveAttribute("style", /width/);

		await runTableAction(page, "Insert paragraph before");
		await table.locator("td").first().click();
		await runTableAction(page, "Insert paragraph after");
		await expect(editor.locator(":scope > p")).toHaveCount(2);
		await table.locator("td").first().click();
		await runTableAction(page, "Select table");
		await runTableAction(page, "Delete table");
		await expect(editor.locator("table")).toHaveCount(0);
	});

	for (const locale of ["en", "ar"]) {
		test(`keeps contextual header controls anchored in ${locale} ${CROSS_ENGINE}`, async ({
			admin,
		}) => {
			const { page } = admin;
			await page
				.context()
				.addCookies([
					{ name: "emdash-locale", value: locale, domain: "localhost", path: "/_emdash" },
				]);
			await openNewPost(admin, true);
			await insertTable(page, 3, 3);
			const toolbar = page.locator("#field-body [data-emdash-table-bubble-menu]");
			const more = toolbar.getByRole("button").last();
			await more.click();
			const menu = page.locator('[role="menu"]:visible');
			await expect(menu).toBeVisible();
			for (const index of [0, 1, 0, 1]) {
				const toggle = menu.getByRole("menuitemcheckbox").nth(index);
				await toggle.scrollIntoViewIfNeeded();
				const before = (await menu.boundingBox())!;
				const scroll = await menu.evaluate((element) => element.scrollTop);
				const checked = await toggle.getAttribute("aria-checked");
				await toggle.click();
				await expect(toggle).toHaveAttribute("aria-checked", checked === "true" ? "false" : "true");
				await expect(more).toBeVisible();
				const after = (await menu.boundingBox())!;
				expect(after.x).toBeCloseTo(before.x, 0);
				expect(after.y).toBeCloseTo(before.y, 0);
				expect(await menu.evaluate((element) => element.scrollTop)).toBe(scroll);
				const last = menu.getByRole("menuitem").last();
				await page.keyboard.press("End");
				await expect(last).toBeFocused();
				expect(
					await last.evaluate((element) => {
						const bounds = element.getBoundingClientRect();
						return element.contains(
							document.elementFromPoint(bounds.x + bounds.width / 2, bounds.y + bounds.height / 2),
						);
					}),
				).toBe(true);
			}
			await page.locator("#field-title").click();
			await expect(menu).toHaveCount(0);
			await expect(page.locator("#field-title")).toBeFocused();
		});

		test(`keeps the Table menu compact, aligned, and visibly highlighted in ${locale}`, async ({
			admin,
		}) => {
			const { page } = admin;
			await page.setViewportSize({ width: 1280, height: 800 });
			await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
			await page.addInitScript(() => localStorage.setItem("emdash-theme", "light"));
			await page
				.context()
				.addCookies([
					{ name: "emdash-locale", value: locale, domain: "localhost", path: "/_emdash" },
				]);
			await openNewPost(admin, true);
			await expect(page.locator("html")).toHaveAttribute("dir", locale === "ar" ? "rtl" : "ltr");
			await insertTable(page, 3, 3);
			const menu = await openTableMenu(page);
			const initial = (await menu.boundingBox())!;
			expect.soft(initial.height).toBeLessThanOrEqual(400);
			const deleteLabel = locale === "ar" ? "حذف الجدول" : "Delete table";
			const header = menu.getByRole("menuitemcheckbox", {
				name: locale === "ar" ? "تبديل صف الرأس" : "Toggle header row",
			});
			await header.hover();
			const headerBackground = await header.evaluate(
				(element) => getComputedStyle(element).backgroundColor,
			);
			const tickGap = await header.evaluate((element) => {
				const text = [...element.childNodes].find(
					(node) => node.nodeType === Node.TEXT_NODE && node.textContent?.trim(),
				)!;
				const range = document.createRange();
				range.selectNodeContents(text);
				const label = range.getBoundingClientRect();
				const tick = element.querySelector("svg")!.getBoundingClientRect();
				return getComputedStyle(element).direction === "rtl"
					? tick.left - label.right
					: label.left - tick.right;
			});
			expect.soft(tickGap).toBeGreaterThanOrEqual(4);
			for (const name of [
				"Select row",
				"Add row below",
				locale === "ar" ? "إضافة عمود بعده" : "Add column after",
				deleteLabel,
			]) {
				const item = menu.getByRole("menuitem", { name, exact: true });
				await item.hover();
				const background = await item.evaluate(
					(element) => getComputedStyle(element).backgroundColor,
				);
				expect.soft(background).toBe(headerBackground);
				expect
					.soft(background)
					.not.toBe(await menu.evaluate((element) => getComputedStyle(element).backgroundColor));
			}
			const pageScroll = await page.evaluate(() => scrollY);
			for (const delta of [-10_000, 10_000, -10_000]) {
				await menu.hover();
				await page.mouse.wheel(0, delta);
				await expect
					.poll(() => menu.evaluate((element) => element.scrollTop))
					.toBe(
						delta > 0
							? await menu.evaluate((element) => element.scrollHeight - element.clientHeight)
							: 0,
					);
				const position = (await menu.boundingBox())!;
				expect(position.x).toBeCloseTo(initial.x, 0);
				expect(position.y).toBeCloseTo(initial.y, 0);
				expect(await page.evaluate(() => scrollY)).toBe(pageScroll);
			}
			await page.keyboard.press("End");
			const last = menu.getByRole("menuitem", { name: deleteLabel, exact: true });
			await expect(last).toBeFocused();
			expect(
				(await last.boundingBox())!.y + (await last.boundingBox())!.height,
			).toBeLessThanOrEqual(initial.y + initial.height);
			await page.keyboard.press("Home");
			await expect(menu.getByRole("menuitem", { name: "Select row", exact: true })).toBeFocused();
			await page.keyboard.press("Escape");
			await expect(page.locator(EDITOR)).toBeFocused();
		});
	}

	test(`preserves HTML and TSV clipboard data through save, reload, and publish ${CROSS_ENGINE}`, async ({
		admin,
		browserName,
		serverInfo,
	}) => {
		const { page } = admin;
		const assertNoErrors = monitorErrors(page);
		const editor = await openNewPost(admin);
		const title = `Table E2E ${Date.now()}`;
		await page.getByRole("textbox", { name: "Title" }).fill(title);
		await insertTable(page, 2, 2);
		const cells = editor.locator("th, td");
		await cells.first().click();
		await paste(page, { "text/plain": "A\tB\nC\tD" });
		await expect(cells.nth(3)).toContainText("D");

		await cells.first().click();
		await paste(page, {
			"text/html": "<table><tr><th><strong>Rich</strong></th><th>HTML</th></tr></table>",
			"text/plain": "Rich\tHTML",
		});
		await expect(cells.first().locator("strong")).toHaveText("Rich");
		await cells.first().locator("p").click();
		await page.keyboard.press("Shift+ArrowRight");
		await page.keyboard.press("Shift+ArrowDown");
		const copied = await editor.evaluate((element) => {
			const event = new ClipboardEvent("copy", {
				bubbles: true,
				cancelable: true,
				clipboardData: new DataTransfer(),
			});
			element.dispatchEvent(event);
			return {
				html: event.clipboardData!.getData("text/html"),
				text: event.clipboardData!.getData("text/plain"),
			};
		});
		expect(copied.text).toBe("Rich\tHTML\nC\tD");
		expect(copied.html).toContain("<table");
		expect(copied.html).toContain("<strong>Rich</strong>");
		if (browserName === "chromium") {
			await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
			await page.keyboard.press("ControlOrMeta+C");
			expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(copied.text);
		}

		const savedResponse = page.waitForResponse(
			(response) =>
				response.request().method() === "POST" &&
				new URL(response.url()).pathname === "/_emdash/api/content/posts",
		);
		await admin.clickSave();
		expect((await savedResponse).ok()).toBe(true);
		await admin.waitForSaveComplete();
		const id = new URL(page.url()).pathname.split("/").pop()!;
		const response = await page.request.get(`/_emdash/api/content/posts/${id}`, {
			headers: { Authorization: `Bearer ${serverInfo.token}` },
		});
		expect(response.ok()).toBe(true);
		const payload = (await response.json()) as {
			data: { item?: { data: { body: any[] } }; data?: { body: any[] } };
		};
		const saved = payload.data.item?.data.body ?? payload.data.data!.body;
		const savedTable = saved.find((block) => block._type === "table");
		const keys = [
			savedTable._key,
			...savedTable.rows.flatMap((row: any) => [
				row._key,
				...row.cells.map((cell: any) => cell._key),
			]),
		];
		expect(new Set(keys).size).toBe(keys.length);

		await page.reload();
		await admin.waitForShell();
		await expect(page.locator(EDITOR).getByText("Rich", { exact: true })).toBeVisible();
		await cells.last().locator("p").click();
		await page.keyboard.press("End");
		await page.keyboard.insertText(" edited");
		await admin.clickSave();
		await admin.waitForSaveComplete();
		const reloaded = await page.request.get(`/_emdash/api/content/posts/${id}`, {
			headers: { Authorization: `Bearer ${serverInfo.token}` },
		});
		const reloadedPayload = (await reloaded.json()) as typeof payload;
		const reloadedTable = (
			reloadedPayload.data.item?.data.body ?? reloadedPayload.data.data!.body
		).find((block: any) => block._type === "table");
		expect([
			reloadedTable._key,
			...reloadedTable.rows.flatMap((row: any) => [
				row._key,
				...row.cells.map((cell: any) => cell._key),
			]),
		]).toEqual(keys);

		const publish = await page.request.post(`/_emdash/api/content/posts/${id}/publish`, {
			headers: csrfHeaders(serverInfo.token),
			data: {},
		});
		expect(publish.ok()).toBe(true);
		const slug = await page.getByRole("textbox", { name: "Slug" }).inputValue();
		await page.goto(`/posts/${slug}`);
		const published = page.locator("#body table");
		await expect(published).toContainText("Rich");
		await expect(published.locator("th").first()).toHaveAttribute("scope", "col");
		await expect(page.locator("#body .emdash-table-wrapper")).toHaveCSS("overflow-x", "auto");
		assertNoErrors();
	});

	test("rejects malformed TSV without mutating the table", async ({ admin }) => {
		const { page } = admin;
		const editor = await openNewPost(admin);
		await insertTable(page, 1, 1, false);
		await editor.locator("td").click();
		const before = await editor.innerText();
		await paste(page, {
			"text/plain": '"unfinished\tvalue',
			"text/tab-separated-values": '"unfinished\tvalue',
		});
		await expect(page.getByRole("alert")).toContainText("invalid quoted cells");
		expect(await editor.innerText()).toBe(before);
	});
});

test.describe("Portable Text table responsive accessibility", () => {
	test.use({
		contextOptions: { forcedColors: "active", reducedMotion: "reduce" },
		viewport: { width: 320, height: 800 },
	});

	test.beforeEach(async ({ admin, page }) => {
		await page.setViewportSize({ width: 1280, height: 800 });
		await admin.devBypassAuth();
		await admin.page
			.context()
			.addCookies([{ name: "emdash-locale", value: "ar", domain: "localhost", path: "/_emdash" }]);
	});

	test("contains wide RTL tables, menus, selection, and forced colors", async ({ admin }) => {
		const { page } = admin;
		const editor = await openNewPost(admin, true);
		expect(await page.evaluate(() => matchMedia("(forced-colors: active)").matches)).toBe(true);
		await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
		await editor.locator(":scope > p").first().click();
		await page.keyboard.insertText("جدول");
		await page.keyboard.press("Enter");
		await insertTable(page, 2, 10);
		await expect(editor.locator("table")).toHaveCSS("direction", "rtl");
		const wrapper = editor.locator(".tableWrapper");
		for (const viewport of [
			{ width: 320, height: 800 },
			{ width: 375, height: 812 },
			{ width: 768, height: 1024 },
			{ width: 1280, height: 800 },
			{ width: 1440, height: 900 },
		]) {
			await page.setViewportSize(viewport);
			const geometry = await wrapper.evaluate((element) => ({
				page: document.documentElement.scrollWidth - document.documentElement.clientWidth,
				scroll: element.scrollWidth,
				visible: element.clientWidth,
			}));
			expect(geometry.page).toBe(0);
			expect(geometry.scroll).toBeGreaterThanOrEqual(geometry.visible);
			await editor.locator("th").first().locator("p").click();
			await expectCaretIn(editor.locator("th").first());
			await expect(editor.locator("th").first()).not.toHaveCSS("outline-style", "none");
			for (let column = 1; column < 10; column++) await page.keyboard.press("Tab");
			await expectCaretIn(editor.locator("th").last());
			const edge = await editor.locator("th").last().boundingBox();
			const frame = await wrapper.boundingBox();
			expect(edge!.x).toBeGreaterThanOrEqual(frame!.x - 1);
			expect(edge!.x + edge!.width).toBeLessThanOrEqual(frame!.x + frame!.width + 1);
			const menu = await openTableMenu(page);
			const box = await menu.boundingBox();
			expect(box!.x).toBeGreaterThanOrEqual(0);
			expect(box!.y).toBeGreaterThanOrEqual(0);
			expect(box!.x + box!.width).toBeLessThanOrEqual(viewport.width);
			expect(box!.y + box!.height).toBeLessThanOrEqual(viewport.height);
			await page.keyboard.press("Escape");
			await expect(editor).toBeFocused();
			await expectCaretIn(editor.locator("th").last());
		}

		const cells = editor.locator("th, td");
		await cells.first().locator("p").click();
		await runTableAction(page, "Select row");
		await expect(editor.locator(".selectedCell")).toHaveCount(10);
		const outline = await editor
			.locator(".selectedCell")
			.first()
			.evaluate((cell) => getComputedStyle(cell).outlineStyle);
		expect(outline).not.toBe("none");
		const menu = await openTableMenu(page);
		const box = await menu.boundingBox();
		expect(box).not.toBeNull();
		expect(box!.x).toBeGreaterThanOrEqual(0);
		expect(box!.x + box!.width).toBeLessThanOrEqual(page.viewportSize()!.width);

		await expect(menu).toBeFocused();
		await page.keyboard.press("ArrowDown");
		await expect(menu.locator('[role="menuitem"]:focus')).toHaveCount(1);
		await page.keyboard.press("End");
		const last = menu.getByRole("menuitem").last();
		await expect(last).toBeFocused();
		const lastBox = (await last.boundingBox())!;
		expect(lastBox.y + lastBox.height).toBeLessThanOrEqual(box!.y + box!.height);
		const results = await new AxeBuilder({ page })
			.include("[data-emdash-editor-surface]")
			.include('[role="menu"]')
			// Base UI guards redirect focus; keyboard workflows verify their destinations.
			.exclude("[data-base-ui-focus-guard]")
			.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
			.analyze();
		expect(results.violations).toEqual([]);
	});
});

test.describe("Portable Text table coarse pointer", () => {
	test.use({ hasTouch: true, viewport: { width: 375, height: 812 } });

	test("uses reachable non-overlapping coarse controls", async ({ admin, browserName }) => {
		test.skip(browserName !== "chromium", "Chromium provides the full coarse-pointer workflow");
		const { page } = admin;
		await page.setViewportSize({ width: 1280, height: 800 });
		await admin.devBypassAuth();
		await openNewPost(admin);
		await page.setViewportSize({ width: 375, height: 812 });
		expect(await page.evaluate(() => matchMedia("(any-pointer: coarse)").matches)).toBe(true);
		await page.getByRole("button", { name: "Table", exact: true }).tap();
		await page.getByRole("menuitem", { name: "Insert table" }).tap();
		await expect(page.getByRole("grid", { name: "Table size" })).toHaveCount(0);
		const accessibility = await new AxeBuilder({ page })
			.include(".kumo-popover-popup")
			.exclude("[data-base-ui-focus-guard]")
			.withTags(["wcag2a", "wcag2aa", "wcag21aa"])
			.analyze();
		expect(accessibility.violations).toEqual([]);
		await page
			.locator(".kumo-popover-popup:visible")
			.evaluate(async (popup) =>
				Promise.all(popup.getAnimations().map((animation) => animation.finished)),
			);
		const rows = page.getByRole("combobox", { name: "Rows" });
		const columns = page.getByRole("combobox", { name: "Columns" });
		const header = page.locator('[data-kumo-part="item-label"]');
		const insert = page.getByRole("button", { name: "Insert table" });
		for (const target of [rows, columns, header, insert]) {
			const box = await target.boundingBox();
			expect(box).not.toBeNull();
			expect(box!.height).toBeGreaterThanOrEqual(44);
		}
		await rows.tap();
		await page.getByRole("option", { name: "3" }).tap();
		await columns.tap();
		await page.getByRole("option", { name: "4" }).tap();
		await header.getByRole("switch").tap();
		await insert.tap();
		await expect(page.locator(EDITOR).locator("table tr")).toHaveCount(3);
		await expect(page.locator(EDITOR).locator("table tr").first().locator("td")).toHaveCount(4);
	});
});

test.describe("Portable Text table performance evidence", () => {
	test.skip(process.env.EMDASH_TABLE_PERF !== "1", "Set EMDASH_TABLE_PERF=1 to capture the trace");

	test("captures a 50 × 20 interaction trace", async ({ admin, page, serverInfo }, testInfo) => {
		await admin.devBypassAuth();
		const body = [
			{
				_type: "table",
				_key: "large-table",
				rows: Array.from({ length: 50 }, (_, row) => ({
					cells: Array.from({ length: 20 }, (_value, column) => `${row}:${column}`),
				})),
			},
		];
		const id = await createPost(page.request, serverInfo, "table-performance", body);
		await page.context().tracing.start({ screenshots: true, snapshots: true });
		await admin.goToEditContent("posts", id);
		await admin.waitForLoading();
		const editor = page.locator(EDITOR);
		const table = editor.locator("table");
		await expect(table.locator("tr")).toHaveCount(50);
		const cdp = await page.context().newCDPSession(page);
		const traceEvents: unknown[] = [];
		cdp.on("Tracing.dataCollected", ({ value }) => traceEvents.push(...value));
		await cdp.send("Tracing.start", {
			categories: "devtools.timeline,blink.user_timing,toplevel,v8",
			options: "record-as-much-as-possible",
		});
		await table.locator("td").first().click();
		await page.evaluate(() => performance.mark("table-menu"));
		await openTableMenu(page);
		await page.keyboard.press("Escape");
		await expect(editor).toBeFocused();
		await expectCaretIn(table.locator("td").first());
		await page.evaluate(() => performance.mark("table-selection"));
		await page.keyboard.press("End");
		await page.keyboard.press("Shift+ArrowRight");
		await expect(table.locator(".selectedCell")).toHaveCount(2);
		await page.evaluate(() => performance.mark("table-structure"));
		await runTableAction(page, "Add row below");
		await expect(table.locator("tr")).toHaveCount(51);
		await runTableAction(page, "Add column after");
		await expect(table.locator("tr").first().locator("td")).toHaveCount(21);
		await page.evaluate(() => performance.mark("table-resize"));
		for (const cell of [
			table.locator("tr").first().locator("td").first(),
			table.locator("tr").first().locator("td").last(),
		]) {
			await cell.evaluate((element) =>
				element.scrollIntoView({ block: "center", inline: "nearest" }),
			);
			const box = await cell.boundingBox();
			await page.mouse.move(box!.x + box!.width - 1, box!.y + box!.height / 2);
			await expect(cell.locator(".column-resize-handle")).toBeVisible();
			await page.mouse.down();
			await page.mouse.move(box!.x + box!.width + 16, box!.y + box!.height / 2);
			await page.mouse.up();
		}
		await page.evaluate(() => performance.mark("table-history"));
		await page.getByRole("button", { name: "Undo" }).click();
		await page.getByRole("button", { name: "Redo" }).click();
		const completed = new Promise<void>((resolve) =>
			cdp.once("Tracing.tracingComplete", () => resolve()),
		);
		await cdp.send("Tracing.end");
		await completed;
		await testInfo.attach("table-chrome-trace.json", {
			body: JSON.stringify({ traceEvents }),
			contentType: "application/json",
		});
		await admin.clickSave();
		await expect(page.getByRole("button", { name: "Saved", exact: true }).first()).toBeVisible();
		const lifecycle = [];
		for (let cycle = 0; cycle < 5; cycle++) {
			await page.getByRole("link", { name: "Posts", exact: true }).click();
			await expect(editor).toHaveCount(0);
			await cdp.send("HeapProfiler.collectGarbage");
			lifecycle.push(await cdp.send("Memory.getDOMCounters"));
			await page.goBack();
			await expect(table.locator("tr")).toHaveCount(51);
		}
		await testInfo.attach("table-lifecycle.json", {
			body: JSON.stringify(lifecycle),
			contentType: "application/json",
		});
		await cdp.detach();
		await page.context().tracing.stop({ path: testInfo.outputPath("table-performance.zip") });
	});
});
