import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

export default defineConfig({
	plugins: [
		react({
			babel: {
				plugins: [
					// Match the admin package build so production-fallback tests keep source messages.
					["@lingui/babel-plugin-lingui-macro", { stripMessageField: false }],
				],
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
			// Desktop-width viewport: the content editor's settings panel is a
			// slide-in sheet below lg (1024px), which would make its controls
			// unreachable for the tests that exercise them directly.
			viewport: { width: 1280, height: 800 },
		},
	},
});
