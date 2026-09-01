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

async function installTimestampNormalizer(admin: AdminPage): Promise<void> {
	for (const url of TIMESTAMPED_API_ROUTES) {
		await admin.page.route(url, async (route) => {
			const response = await route.fetch();
			const contentType = response.headers()["content-type"] ?? "";
			if (!contentType.includes("application/json")) {
				await route.fulfill({ response });
				return;
			}

			const body: unknown = await response.json();
			await route.fulfill({ response, json: normalizeTimestamps(body) });
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

test.describe("visual regression", () => {
	test.skip(!VISUAL_ENABLED, "Set EMDASH_VISUAL=1 to run visual regression snapshots");

	// Freeze browser time, timezone, locale, and OS-level motion preferences.
	test.use({ locale: "en-US", reducedMotion: "reduce", timezoneId: "UTC" });

	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
		await admin.page.clock.setFixedTime(FIXED_VISUAL_TIME);
		// A screenshot mask changes pixels after layout, so masked timestamps can
		// still resize columns or cover an overlapping popover.
		await installTimestampNormalizer(admin);
	});

	test.afterEach(async ({ admin }) => {
		await admin.page.unrouteAll({ behavior: "ignoreErrors" });
	});

	for (const locale of LOCALES) {
		for (const pageCase of PAGES) {
			test(`${pageCase.name} @${locale.name}`, async ({ admin, serverInfo }) => {
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
});
