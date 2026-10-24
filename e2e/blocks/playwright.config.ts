import { fileURLToPath } from "node:url";

import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
	testDir: ".",
	testMatch: "*.spec.ts",
	outputDir: fileURLToPath(new URL("../../test-results/blocks", import.meta.url)),
	workers: 1,
	retries: process.env.CI ? 1 : 0,
	timeout: 60_000,
	expect: { timeout: 15_000 },
	use: {
		baseURL: "http://localhost:4451",
		trace: "retain-on-failure",
		screenshot: "only-on-failure",
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "pnpm --filter @emdash-cms/blocks-playground dev --host 127.0.0.1 --port 4451",
		cwd: fileURLToPath(new URL("../../", import.meta.url)),
		url: "http://localhost:4451",
		reuseExistingServer: false,
		timeout: 120_000,
	},
});
