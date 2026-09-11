import { defineConfig, devices } from "@playwright/test";

import baseConfig from "./playwright.config";

export default defineConfig(baseConfig, {
	testMatch: "portable-text-table.spec.ts",
	testIgnore: [],
	timeout: 60_000,
	projects: [
		{
			name: "chromium",
			use: { ...devices["Desktop Chrome"] },
		},
		{
			name: "firefox",
			grep: /@table-cross-engine/,
			use: { ...devices["Desktop Firefox"] },
		},
		{
			name: "webkit",
			grep: /@table-cross-engine/,
			use: { ...devices["Desktop Safari"] },
		},
	],
});
