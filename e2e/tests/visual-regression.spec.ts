/**
 * Visual regression proof-of-concept.
 *
 * Captures pixel snapshots of key admin screens in both LTR (English) and
 * RTL (Arabic) and diffs them against committed baselines via Playwright's
 * built-in `toHaveScreenshot()` assertion. This is the *local runner* approach:
 * the browser is whatever `playwright install chromium` gave you. That makes it
 * environment-sensitive -- baselines generated on macOS will NOT match a Linux
 * CI runner. For stable CI, regenerate baselines inside the pinned Playwright
 * Docker image (mcr.microsoft.com/playwright) or run this against Cloudflare
 * Browser Rendering so the render environment is fixed. See the PR discussion.
 *
 * Gated behind EMDASH_VISUAL=1 so visual snapshots stay out of the default e2e
 * suite; they are slow and platform-sensitive, so CI runs them explicitly:
 *
 *   # first run writes baselines, reports them as "created" (non-zero exit)
 *   EMDASH_VISUAL=1 pnpm exec playwright test visual-regression --update-snapshots
 *   # subsequent runs diff against them
 *   EMDASH_VISUAL=1 pnpm exec playwright test visual-regression
 */

import { test, expect, type AdminPage, type ServerInfo } from "../fixtures";

const VISUAL_ENABLED = process.env.EMDASH_VISUAL === "1";
const FIXED_VISUAL_TIME = "2026-08-27T12:00:00.000Z";
const DYNAMIC_TIMESTAMP_KEYS = new Set(["createdAt", "updatedAt", "publishedAt", "scheduledAt"]);
const TIMESTAMPED_API_ROUTES = ["**/_emdash/api/dashboard", "**/_emdash/api/content/**"];

// Kill the usual sources of pixel nondeterminism: animations, transitions,
// the blinking text caret, and smooth-scroll. Re-injected after every reload
// because a full navigation drops injected styles.
const FREEZE_CSS = `
	*, *::before, *::after {
		animation-duration: 0s !important;
		animation-delay: 0s !important;
		transition-duration: 0s !important;
		transition-delay: 0s !important;
		caret-color: transparent !important;
		scroll-behavior: auto !important;
	}
`;

// Admin locale is driven by the `emdash-locale` cookie (path /_emdash); Arabic
// is enabled with dir: "rtl", so this flips the whole shell to RTL.
const LOCALES = [
	{ name: "ltr", code: "en", dir: "ltr" },
	{ name: "rtl", code: "ar", dir: "rtl" },
] as const;

/**
 * A screen to snapshot.
 *
 * `path` may depend on seeded data (e.g. a post id for the editor).
 */
interface PageCase {
	name: string;
	path: (info: ServerInfo) => string;
	viewport?: { width: number; height: number };
	prepare?: (admin: AdminPage) => Promise<void>;
}

function openFilter(trigger: string, popup: string): (admin: AdminPage) => Promise<void> {
	return async (admin) => {
		await admin.page.locator(trigger).click();
		await admin.page.locator(popup).waitFor({ state: "visible" });
	};
}

const PAGES: PageCase[] = [
	{
		name: "dashboard",
		path: () => "/",
	},
	{ name: "content-list", path: () => "/content/posts" },
	{
		name: "content-list-status-filter",
		path: () => "/content/posts",
		prepare: openFilter(".emdash-status-filter-trigger", '[role="listbox"]:visible'),
	},
	{
		name: "content-list-date-field-filter",
		path: () => "/content/posts",
		prepare: openFilter(".emdash-date-field-filter-trigger", '[role="listbox"]:visible'),
	},
	{
		name: "content-list-byline-filter",
		path: () => "/content/posts",
		prepare: openFilter(".emdash-byline-filter-trigger", ".kumo-popover-popup:visible"),
	},
	{
		name: "content-list-date-range-filter",
		path: () => "/content/posts",
		prepare: openFilter(".emdash-date-range-trigger", ".kumo-popover-popup:visible"),
	},
	{ name: "content-editor", path: (info) => `/content/posts/${info.contentIds.posts[0]}` },
	{ name: "content-new", path: () => "/content/posts/new" },
	{ name: "media", path: () => "/media" },
	{ name: "media-mobile", path: () => "/media", viewport: { width: 320, height: 800 } },
	{ name: "menus", path: () => "/menus" },
	{ name: "settings", path: () => "/settings" },
];

/** Set the admin locale cookie (SSR + client both read it). */
async function setLocale(admin: AdminPage, code: string): Promise<void> {
	await admin.page
		.context()
		.addCookies([{ name: "emdash-locale", value: code, domain: "localhost", path: "/_emdash" }]);
}

function normalizeTimestamps(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(normalizeTimestamps);
	if (value === null || typeof value !== "object") return value;

	return Object.fromEntries(
		Object.entries(value).map(([key, nested]) => [
			key,
			DYNAMIC_TIMESTAMP_KEYS.has(key) && typeof nested === "string"
				? FIXED_VISUAL_TIME
				: normalizeTimestamps(nested),
		]),
	);
}

function representPublishedWithChanges(value: unknown, entryId?: string): unknown {
	if (!entryId || value === null || typeof value !== "object") return value;
	const response = value as { data?: { item?: Record<string, unknown> } };
	const item = response.data?.item;
	if (!item || item.id !== entryId) return value;
	const draftRevisionId = item.draftRevisionId ?? item.liveRevisionId;
	if (typeof draftRevisionId !== "string") return value;

	return {
		...response,
		data: {
			...response.data,
			item: {
				...item,
				status: "published",
				draftRevisionId,
				liveRevisionId: `visual-live-${entryId}`,
			},
		},
	};
}

async function installTimestampNormalizer(
	admin: AdminPage,
	publishedWithChangesId?: string,
): Promise<void> {
	for (const url of TIMESTAMPED_API_ROUTES) {
		await admin.page.route(url, async (route) => {
			const response = await route.fetch();
			const contentType = response.headers()["content-type"] ?? "";
			if (!contentType.includes("application/json")) {
				await route.fulfill({ response });
				return;
			}

			const body: unknown = await response.json();
			const normalized = normalizeTimestamps(body);
			await route.fulfill({
				response,
				json: representPublishedWithChanges(normalized, publishedWithChangesId),
			});
		});
	}
}

/**
 * Navigate to an admin path and wait for it to be ready without relying on any
 * localized selectors. The shared AdminPage.waitForShell() matches the sidebar
 * by its aria-label, which is translated -- so it can't be used once the locale
 * is Arabic. Here we wait on the hydration signal and the <main> landmark
 * (both locale-independent), then confirm the document direction flipped.
 */
async function openAdmin(admin: AdminPage, path: string, dir: string): Promise<void> {
	await admin.goto(path);
	await admin.page.waitForSelector("astro-island:not([ssr])", { timeout: 30000 });
	await admin.page.locator("main").first().waitFor({ state: "visible", timeout: 30000 });
	await expect(admin.page.locator("html")).toHaveAttribute("dir", dir);
	await admin.waitForLoading();
}

/** Settle fonts and freeze animation before capturing. */
async function stabilize(admin: AdminPage): Promise<void> {
	await admin.page.addStyleTag({ content: FREEZE_CSS });
	// Drop focus before capturing. The editor pages mount a TipTap toolbar
	// whose buttons reflect the editor's focus/active state; whether the editor
	// grabs focus during hydration is a race, so a run can capture a focused
	// (highlighted) toolbar button or an unfocused one. Blurring makes the
	// capture depend on the rendered page, not on who won the focus race.
	await admin.page.evaluate(() => {
		const active = document.activeElement;
		if (active instanceof HTMLElement && active !== document.body) {
			active.blur();
		}
	});
	// Await font loading without returning the FontFaceSet that
	// document.fonts.ready fulfils with -- Playwright cannot serialize it.
	await admin.page.evaluate(async () => {
		await document.fonts.ready;
	});
}

async function freezeTableVisual(admin: AdminPage): Promise<void> {
	await admin.page.addStyleTag({ content: FREEZE_CSS });
	await admin.page.evaluate(async () => {
		await document.fonts.ready;
	});
}

async function openTableVisual(
	admin: AdminPage,
	rows = 3,
	columns = 3,
	header = true,
	locale: { code: string; dir: string } = LOCALES[0],
	theme = "light",
) {
	await setLocale(admin, locale.code);
	await admin.page.evaluate((mode) => localStorage.setItem("emdash-theme", mode), theme);
	await openAdmin(admin, "/content/posts/new", locale.dir);
	await freezeTableVisual(admin);
	const page = admin.page;
	await expect(page.locator("html")).toHaveAttribute("data-mode", theme);
	const editor = page.locator("#field-body .ProseMirror");
	if (locale.dir === "rtl") {
		await editor.locator(":scope > p").first().click();
		await page.keyboard.insertText("جدول");
		await page.keyboard.press("Enter");
	}
	await page.locator("#field-body [data-emdash-table-trigger]").click();
	await page.locator('[role="menu"]:visible').getByRole("menuitem").first().click();
	if (!header) await page.getByRole("switch").click();
	await page
		.getByRole("gridcell")
		.nth((rows - 1) * 10 + columns - 1)
		.click();
	await expect(editor.locator("table")).toHaveCSS("direction", locale.dir);
	return { editor, table: editor.locator(".tableWrapper") };
}

async function visualAction(admin: AdminPage, name: string) {
	const trigger = admin.page.locator("#field-body [data-emdash-table-trigger]");
	if ((await trigger.getAttribute("aria-expanded")) !== "true") await trigger.click();
	await admin.page.locator('[role="menu"]:visible').getByText(name, { exact: true }).click();
}

async function settleTableGeometry(admin: AdminPage): Promise<void> {
	const page = admin.page;
	if (await page.locator('[role="menu"]:visible').count()) await page.keyboard.press("Escape");
	await expect(page.locator('[role="menu"]:visible')).toHaveCount(0);
	await page.locator("#field-title").focus();
	await expect(page.locator("#field-title")).toBeFocused();
	await expect(page.locator("[data-emdash-table-bubble-menu]")).toBeHidden();
}

const tableShot = { animations: "disabled" as const, caret: "hide" as const };

test.describe("visual regression", () => {
	test.skip(!VISUAL_ENABLED, "Set EMDASH_VISUAL=1 to run visual regression snapshots");

	// Freeze browser time, timezone, locale, and OS-level motion preferences.
	test.use({ locale: "en-US", contextOptions: { reducedMotion: "reduce" }, timezoneId: "UTC" });

	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
		await admin.page.clock.setFixedTime(FIXED_VISUAL_TIME);
	});

	test.afterEach(async ({ admin }) => {
		await admin.page.unrouteAll({ behavior: "ignoreErrors" });
	});

	for (const locale of LOCALES) {
		for (const pageCase of PAGES) {
			test(`${pageCase.name} @${locale.name}`, async ({ admin, serverInfo }) => {
				// A screenshot mask changes pixels after layout, so masked timestamps can
				// still resize columns or cover an overlapping popover. The editor case
				// also presents the seeded live entry as having a distinct draft revision
				// without mutating shared fixture data.
				await installTimestampNormalizer(
					admin,
					pageCase.name === "content-editor" ? serverInfo.contentIds.posts[0] : undefined,
				);
				await setLocale(admin, locale.code);
				if (pageCase.viewport) await admin.page.setViewportSize(pageCase.viewport);
				await openAdmin(admin, pageCase.path(serverInfo), locale.dir);
				await stabilize(admin);
				await pageCase.prepare?.(admin);

				await expect(admin.page).toHaveScreenshot(`${pageCase.name}-${locale.name}.png`, {
					fullPage: true,
					animations: "disabled",
					// The version/commit string changes every build; always mask it.
					mask: [admin.page.getByTestId("admin-version")],
				});
			});
		}
	}

	test("portable table pairwise states", async ({ admin, serverInfo }, testInfo) => {
		test.setTimeout(120_000);
		const page = admin.page;
		let view = await openTableVisual(admin);
		await settleTableGeometry(admin);
		await expect(view.table).toHaveScreenshot("table-a-default.png", tableShot);
		await visualAction(admin, "Delete table");
		await page.locator("#field-body [data-emdash-table-trigger]").click();
		await page.locator('[role="menu"]:visible').getByRole("menuitem").first().click();
		await expect(page.locator(".kumo-popover-popup:visible")).toHaveScreenshot(
			"table-a-picker-open.png",
			tableShot,
		);

		await page.setViewportSize({ width: 375, height: 812 });
		view = await openTableVisual(admin, 3, 3, true, LOCALES[1], "dark");
		await view.table.locator("th").first().locator("p").click();
		await expect(view.table).toHaveScreenshot("table-b-active-cell.png", tableShot);
		await page.keyboard.press("Shift+ArrowLeft");
		await expect(view.table.locator(".selectedCell")).toHaveCount(2);
		await expect(view.table).toHaveScreenshot("table-b-multi-cell-selection.png", tableShot);
		await page.setViewportSize({ width: 1280, height: 800 });
		view = await openTableVisual(admin, 3, 3, false);
		await view.table.locator("td").first().locator("p").click();
		await expect(page.getByRole("group", { name: "Table controls" })).toHaveScreenshot(
			"table-c-contextual-toolbar.png",
			tableShot,
		);
		await page.getByRole("button", { name: "More table actions" }).click();
		await expect(page.locator('[role="menu"]:visible')).toHaveScreenshot(
			"table-c-full-menu.png",
			tableShot,
		);
		view = await openTableVisual(admin, 3, 3, false, LOCALES[1], "dark");
		await view.table.locator("td").first().locator("p").click();
		await page.locator("#field-body [data-emdash-table-trigger]").click();
		await expect(page.getByRole("menuitem", { name: "حذف الصف", exact: true })).toBeEnabled();
		await expect(page.locator('[role="menu"]:visible')).toHaveScreenshot(
			"table-d-delete-enabled.png",
			tableShot,
		);
		await page.keyboard.press("Escape");
		await visualAction(admin, "Select table");
		await page.locator("#field-body [data-emdash-table-trigger]").click();
		await expect(page.getByRole("menuitem", { name: /Delete.*rows/ })).toBeDisabled();
		await expect(page.locator('[role="menu"]:visible')).toHaveScreenshot(
			"table-d-delete-disabled.png",
			tableShot,
		);

		await page.setViewportSize({ width: 320, height: 800 });
		view = await openTableVisual(admin, 2, 10, true, LOCALES[1]);
		for (const [cell, text] of [
			[view.table.locator("th").first(), "First"],
			[view.table.locator("th").last(), "Last"],
		] as const) {
			await cell.locator("p").click();
			await page.keyboard.insertText(text);
		}
		await view.table.evaluate((wrapper) => {
			wrapper.scrollLeft = 0;
		});
		await expect(view.table).toHaveScreenshot("table-e-scroll-start.png", tableShot);
		await view.table.evaluate((wrapper) => {
			wrapper.scrollLeft = -wrapper.scrollWidth;
		});
		expect(await view.table.evaluate((wrapper) => wrapper.scrollLeft)).toBeLessThan(0);
		await expect(view.table).toHaveScreenshot("table-e-scroll-end.png", tableShot);
		await page.setViewportSize({ width: 1440, height: 900 });
		view = await openTableVisual(admin, 2, 10, true, LOCALES[1], "dark");
		for (const [name, cell] of [
			["table-f-resize-first-column.png", view.table.locator("th").first()],
			["table-f-resize-last-column.png", view.table.locator("th").last()],
		] as const) {
			await cell.scrollIntoViewIfNeeded();
			const box = await cell.boundingBox();
			await page.mouse.move(box!.x + 1, box!.y + box!.height / 2);
			await expect(cell.locator(".column-resize-handle")).toBeVisible();
			await page.mouse.down();
			await expect(view.table).toHaveScreenshot(name, tableShot);
			await page.mouse.up();
		}

		await page.setViewportSize({ width: 768, height: 1024 });
		view = await openTableVisual(admin, 3, 3, false);
		await visualAction(admin, "Increase column width");
		await settleTableGeometry(admin);
		await expect(view.table).toHaveScreenshot("table-g-custom-widths.png", tableShot);
		await visualAction(admin, "Reset column widths");
		await settleTableGeometry(admin);
		await expect(view.table).toHaveScreenshot("table-g-reset-widths.png", tableShot);
		await page.setViewportSize({ width: 375, height: 812 });
		view = await openTableVisual(admin, 3, 3, false, LOCALES[1], "dark");
		await visualAction(admin, "تبديل صف الرأس");
		await visualAction(admin, "Toggle header column");
		await settleTableGeometry(admin);
		await expect(view.table).toHaveScreenshot("table-h-header-row-column.png", tableShot);
		await visualAction(admin, "تبديل صف الرأس");
		await visualAction(admin, "Toggle header column");
		await settleTableGeometry(admin);
		await expect(view.table).toHaveScreenshot("table-h-body-only.png", tableShot);

		await page.setViewportSize({ width: 1280, height: 800 });
		view = await openTableVisual(admin, 3, 3, false);
		await view.table.locator("td").first().locator("p").click();
		await page.keyboard.press("Shift+ArrowRight");
		await visualAction(admin, "Merge selected cells");
		await expect(view.table).toHaveScreenshot("table-i-merged.png", tableShot);
		await visualAction(admin, "Split merged cell");
		await expect(view.table).toHaveScreenshot("table-i-split.png", tableShot);

		await page.setViewportSize({ width: 1440, height: 900 });
		view = await openTableVisual(admin, 3, 3, true, { code: "pseudo", dir: "ltr" }, "dark");
		await expect(page.locator("html")).toHaveAttribute("lang", "pseudo");
		await expect(page.locator("[data-emdash-editor-surface]")).toHaveScreenshot(
			"table-k-full-editor.png",
			tableShot,
		);
		await page.locator("#field-body").evaluate((field) => {
			field.style.inlineSize = "360px";
		});
		await expect(page.locator("[data-emdash-editor-surface]")).toHaveScreenshot(
			"table-k-split-pane-360.png",
			tableShot,
		);
		await page.locator("#field-body [data-emdash-table-trigger]").click();
		const pseudoMenu = page.locator('[role="menu"]:visible');
		await expect(pseudoMenu.getByRole("menuitem").first()).toContainText("Śēĺēćţ ŕōŵ");
		const menuBounds = (await pseudoMenu.boundingBox())!;
		const viewport = page.viewportSize()!;
		expect(menuBounds.x).toBeGreaterThanOrEqual(0);
		expect(menuBounds.y).toBeGreaterThanOrEqual(0);
		expect(menuBounds.x + menuBounds.width).toBeLessThanOrEqual(viewport.width);
		expect(menuBounds.y + menuBounds.height).toBeLessThanOrEqual(viewport.height);
		await expect(pseudoMenu).toHaveScreenshot("table-k-pseudo-menu.png", tableShot);

		const slug = `visual-table-published-${testInfo.retry}`;
		const response = await page.request.post("/_emdash/api/content/posts", {
			headers: {
				Authorization: `Bearer ${serverInfo.token}`,
				"X-EmDash-Request": "1",
			},
			data: {
				slug,
				data: {
					title: "Visual table",
					body: [
						{
							_type: "table",
							_key: "visual-table",
							hasHeaderRow: true,
							rows: [0, 1].map((row) => ({
								cells: [0, 1, 2].map((column) => `خلية ${row}:${column}`),
							})),
						},
					],
				},
			},
		});
		const created = (await response.json()) as { data: { item?: { id: string }; id?: string } };
		const id = created.data.item?.id ?? created.data.id!;
		await page.request.post(`/_emdash/api/content/posts/${id}/publish`, {
			headers: { Authorization: `Bearer ${serverInfo.token}`, "X-EmDash-Request": "1" },
			data: {},
		});
		await page.setViewportSize({ width: 320, height: 800 });
		await setLocale(admin, "ar");
		await page.evaluate(() => localStorage.setItem("emdash-theme", "light"));
		await openAdmin(admin, `/content/posts/${id}`, "rtl");
		await expect(page.locator("#field-body table")).toHaveCSS("direction", "rtl");
		await freezeTableVisual(admin);
		await expect(page.locator("#field-body .tableWrapper")).toHaveScreenshot(
			"table-j-editor.png",
			tableShot,
		);
		await page.goto(`/posts/${slug}`);
		await page.locator("html").evaluate((html) => {
			html.dir = "rtl";
		});
		await expect(page.locator("#body table")).toHaveCSS("direction", "rtl");
		await freezeTableVisual(admin);
		await expect(page.locator("#body .emdash-table-wrapper")).toHaveScreenshot(
			"table-j-published.png",
			tableShot,
		);
	});

	test("portable table fine picker", async ({ admin }) => {
		await admin.page.setViewportSize({ width: 320, height: 800 });
		await admin.page.evaluate(() => localStorage.setItem("emdash-theme", "dark"));
		await setLocale(admin, "en");
		await openAdmin(admin, "/content/posts/new", "ltr");
		await admin.page.locator("#field-body [data-emdash-table-trigger]").click();
		await admin.page.locator('[role="menu"]:visible').getByRole("menuitem").first().click();
		await freezeTableVisual(admin);
		await expect(admin.page.locator(".kumo-popover-popup:visible")).toHaveScreenshot(
			"table-l-fine-picker.png",
			tableShot,
		);
	});
});

test.describe("visual regression coarse table picker", () => {
	test.skip(!VISUAL_ENABLED, "Set EMDASH_VISUAL=1 to run visual regression snapshots");
	test.use({ hasTouch: true, viewport: { width: 320, height: 800 } });

	test("portable table coarse picker", async ({ admin }) => {
		await admin.page.setViewportSize({ width: 1280, height: 800 });
		await admin.devBypassAuth();
		await admin.page.evaluate(() => localStorage.setItem("emdash-theme", "dark"));
		await admin.goToNewContent("posts");
		await admin.page.setViewportSize({ width: 320, height: 800 });
		await admin.page.locator("#field-body [data-emdash-table-trigger]").tap();
		await admin.page.locator('[role="menu"]:visible').getByRole("menuitem").first().tap();
		await freezeTableVisual(admin);
		await expect(admin.page.locator(".kumo-popover-popup:visible")).toHaveScreenshot(
			"table-l-coarse-picker.png",
			tableShot,
		);
	});
});
