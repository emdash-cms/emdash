import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "media-ready.spec.ts",
	outputDir: fileURLToPath(new URL("../../test-results", import.meta.url)),
	fullyParallel: false,
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	timeout: 360_000,
	expect: { timeout: 60_000 },
	use: {
		baseURL: "http://localhost:4450",
		trace: "retain-on-failure",
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
