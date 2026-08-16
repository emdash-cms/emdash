import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import react from "@vitejs/plugin-react";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig } from "vitest/config";

const phosphorPackageDir = dirname(
	fileURLToPath(import.meta.resolve("@phosphor-icons/react/package.json")),
);
const phosphorCsrDir = join(phosphorPackageDir, "dist", "csr");
const PHOSPHOR_DEEP_IMPORT_RE = /^@phosphor-icons\/react\/([A-Z][A-Za-z0-9]*)$/;

export default defineConfig({
	plugins: [
		{
			name: "phosphor-icon-source",
			enforce: "pre",
			resolveId(id) {
				const iconName = id.match(PHOSPHOR_DEEP_IMPORT_RE)?.[1];
				if (iconName) return join(phosphorCsrDir, `${iconName}.es.js`);
			},
		},
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
			// Pin a non-UTC timezone so timestamp-parsing tests catch local-vs-UTC bugs.
			provider: playwright({
				contextOptions: { timezoneId: "America/New_York" },
			}),
			instances: [{ browser: "chromium" }],
			headless: true,
			// Desktop-width viewport: the content editor's settings panel is a
			// slide-in sheet below lg (1024px), which would make its controls
			// unreachable for the tests that exercise them directly.
			viewport: { width: 1280, height: 800 },
		},
	},
});
