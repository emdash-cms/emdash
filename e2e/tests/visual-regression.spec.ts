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
 * Gated behind EMDASH_VISUAL=1 so it stays out of the default e2e suite until
 * baselines are committed (a fresh checkout has none, which would fail CI):
 *
 *   # first run writes baselines, reports them as "created" (non-zero exit)
 *   EMDASH_VISUAL=1 pnpm exec playwright test visual-regression --update-snapshots
 *   # subsequent runs diff against them
 *   EMDASH_VISUAL=1 pnpm exec playwright test visual-regression
 */

import type { Locator } from "@playwright/test";

import { test, expect, type AdminPage, type ServerInfo } from "../fixtures";

const VISUAL_ENABLED = process.env.EMDASH_VISUAL === "1";

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
 * `extraMasks` returns page regions to paint over on top of the always-masked
 * version footer -- use it for anything that changes every run (timestamps).
 */
interface PageCase {
	name: string;
	path: (info: ServerInfo) => string;
	extraMasks?: (admin: AdminPage) => Locator[];
}

const PAGES: PageCase[] = [
	{
		name: "dashboard",
		path: () => "/",
		// Recent Activity prints relative times ("just now") that drift over time.
		extraMasks: (admin) => [admin.page.getByTestId("activity-time")],
	},
	{
		name: "content-list",
		path: () => "/content/posts",
		// The Updated column is an absolute date (the seed day) -- guaranteed to
		// differ between a committed baseline and any later run.
		extraMasks: (admin) => [admin.page.getByTestId("content-updated")],
	},
	{
		name: "content-editor",
		path: (info) => `/content/posts/${info.contentIds.posts[0]}`,
		// The Publish panel prints Created/Updated timestamps seeded at test time.
		extraMasks: (admin) => [admin.page.getByTestId("content-timestamps")],
	},
	{ name: "content-new", path: () => "/content/posts/new" },
	{ name: "media", path: () => "/media" },
	{ name: "menus", path: () => "/menus" },
	{ name: "settings", path: () => "/settings" },
];

/** Set the admin locale cookie (SSR + client both read it). */
async function setLocale(admin: AdminPage, code: string): Promise<void> {
	await admin.page
		.context()
		.addCookies([{ name: "emdash-locale", value: code, domain: "localhost", path: "/_emdash" }]);
}

/**
 * Navigate to an admin path and wait for it to be ready without relying on any
 * localized selectors. The shared AdminPage.waitForShell() matches the sidebar
 * by its aria-label, which is translated -- so it can't be used once the locale
 * is Arabic. Here we wait on the hydration signal and the <aside> landmark
 * (both locale-independent), then confirm the document direction flipped.
 */
async function openAdmin(admin: AdminPage, path: string, dir: string): Promise<void> {
	await admin.goto(path);
	await admin.page.waitForSelector("astro-island:not([ssr])", { timeout: 30000 });
	await admin.page.locator("aside").first().waitFor({ state: "visible", timeout: 30000 });
	await expect(admin.page.locator("html")).toHaveAttribute("dir", dir);
	await admin.waitForLoading();
}

/** Settle fonts and freeze animation before capturing. */
async function stabilize(admin: AdminPage): Promise<void> {
	await admin.page.addStyleTag({ content: FREEZE_CSS });
	// Await font loading without returning the FontFaceSet that
	// document.fonts.ready fulfils with -- Playwright cannot serialize it.
	await admin.page.evaluate(async () => {
		await document.fonts.ready;
	});
}

test.describe("visual regression", () => {
	test.skip(!VISUAL_ENABLED, "Set EMDASH_VISUAL=1 to run visual regression snapshots");

	// Freeze OS-level motion preferences as well as our CSS override.
	test.use({ reducedMotion: "reduce" });

	test.beforeEach(async ({ admin }) => {
		await admin.devBypassAuth();
	});

	for (const locale of LOCALES) {
		for (const pageCase of PAGES) {
			test(`${pageCase.name} @${locale.name}`, async ({ admin, serverInfo }) => {
				await setLocale(admin, locale.code);
				await openAdmin(admin, pageCase.path(serverInfo), locale.dir);
				await stabilize(admin);

				await expect(admin.page).toHaveScreenshot(`${pageCase.name}-${locale.name}.png`, {
					fullPage: true,
					animations: "disabled",
					// The version/commit string changes every build; always mask it.
					mask: [admin.page.getByTestId("admin-version"), ...(pageCase.extraMasks?.(admin) ?? [])],
				});
			});
		}
	}
});
