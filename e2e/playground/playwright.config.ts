import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "media-ready.spec.ts",
	fullyParallel: false,
	workers: 1,
	timeout: 120_000,
	use: {
		baseURL: "http://localhost:4450",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "ASTRO_DEV_BACKGROUND=0 ./node_modules/.bin/astro dev --host 127.0.0.1 --port 4450",
		cwd: new URL("../../demos/playground/", import.meta.url).pathname,
		url: "http://localhost:4450/playground",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
