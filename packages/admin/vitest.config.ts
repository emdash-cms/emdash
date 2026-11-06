import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { configDefaults, defineConfig } from "vitest/config";

// Pin a non-UTC timezone so timestamp-parsing tests catch local-vs-UTC bugs.
const contextOptions = { timezoneId: "America/New_York" };
const touchScreenTests = "tests/**/*.touch.test.{ts,tsx}";

export default defineConfig({
	resolve: { dedupe: ["react", "react-dom"] },
	optimizeDeps: {
		include: [
			"@cloudflare/kumo/primitives/scroll-area",
			"@codemirror/autocomplete",
			"@codemirror/commands",
			"@codemirror/lang-css",
			"@codemirror/lang-html",
			"@codemirror/lang-javascript",
			"@codemirror/language",
			"@codemirror/state",
			"@codemirror/view",
			"@lezer/highlight",
			"react-image-crop",
			"date-fns",
			"react-day-picker/locale/*",
		],
	},
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
			provider: playwright({ contextOptions }),
			instances: [
				{ browser: "chromium", exclude: [...configDefaults.exclude, touchScreenTests] },
				// Test files run one after another on a shared page, and turning touch
				// emulation off resets its hover and pointer to the machine's own devices,
				// none on Linux CI. Touch-screen tests get pages that start as touch screens.
				{
					browser: "chromium",
					name: "chromium-touch",
					include: [touchScreenTests],
					provider: playwright({ contextOptions: { ...contextOptions, hasTouch: true } }),
				},
			],
			headless: true,
			// Desktop-width viewport: the content editor's settings panel is a
			// slide-in sheet below lg (1024px), which would make its controls
			// unreachable for the tests that exercise them directly.
			viewport: { width: 1280, height: 800 },
		},
	},
});
