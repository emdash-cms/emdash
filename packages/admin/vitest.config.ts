import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		react({
			babel: {
				plugins: ["@lingui/babel-plugin-lingui-macro"],
			},
		}),
	],
	test: {
		globals: true,
		include: ["tests/**/*.test.{ts,tsx}"],
		setupFiles: ["./tests/setup.ts"],
		browser: {
			enabled: true,
			// Pin a non-UTC timezone so timestamp-parsing tests catch local-vs-UTC bugs.
			provider: playwright({
				contextOptions: { timezoneId: "America/New_York" },
			}),
			instances: [{ browser: "chromium" }],
			headless: true,
		},
	},
});
