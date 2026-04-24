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
			provider: playwright(),
			instances: [{ browser: "chromium" }],
			headless: true,
		},
	},
});
