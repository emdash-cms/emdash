import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

/**
 * Node-only Vitest configuration for build/output assertions that cannot run
 * in the browser environment.
 */
export default defineConfig({
	resolve: { dedupe: ["react", "react-dom"] },
	plugins: [
		react({
			babel: {
				plugins: [["@lingui/babel-plugin-lingui-macro", { stripMessageField: false }]],
			},
		}),
	],
	test: {
		globals: true,
		include: ["tests/**/*.node.test.{ts,tsx}"],
		// Browser-only setup imports vitest-browser-react, so keep it out of
		// the Node test runner.
		setupFiles: [],
		// Build/output assertions need the Node stdlib, so keep browser mode off.
		browser: { enabled: false },
	},
});
