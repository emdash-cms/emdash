import { defineConfig, devices } from "@playwright/test";

/**
 * Playwright E2E test configuration for EmDash CMS
 *
 * Tests run against an isolated fixture (not a demo app).
 * Global setup creates a temp directory, starts a fresh dev server,
 * runs setup via dev-bypass, and seeds collections with test data.
 * Port 4444 is used to avoid conflicts with development servers.
 */
export default defineConfig({
	testDir: "./e2e/tests",
	// Disable parallel to avoid shared database state issues
	fullyParallel: false,
	workers: 1,
	forbidOnly: !!process.env.CI,
	retries: process.env.CI ? 1 : 0,
	reporter: "html",
	// The Cloudflare (workerd) dev runner compiles each admin route slowly on
	// first hit; give it headroom so cold compilation doesn't time out specs.
	timeout: process.env.EMDASH_E2E_TARGET === "cloudflare" ? 90_000 : 30000,

	globalSetup: "./e2e/global-setup.ts",
	globalTeardown: "./e2e/global-teardown.ts",

	use: {
		baseURL: "http://localhost:4444",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
	},

	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
	],

	// No webServer — global-setup.ts handles server lifecycle
});
