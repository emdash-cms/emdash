import { defineConfig, devices } from "@playwright/test";

import { TEST_BINDINGS } from "./test/fixtures/oauth.js";

export default defineConfig({
	testDir: "./e2e",
	fullyParallel: false,
	workers: 1,
	retries: 0,
	reporter: "list",
	timeout: 30_000,
	use: {
		baseURL: "http://localhost:5185",
		trace: "on-first-retry",
		screenshot: "only-on-failure",
		...devices["Desktop Chrome"],
	},
	webServer: {
		command: "pnpm dev --host 127.0.0.1 --port 5185",
		url: "http://localhost:5185/health",
		reuseExistingServer: false,
		timeout: 60_000,
		env: { ...process.env, ...TEST_BINDINGS },
	},
});
