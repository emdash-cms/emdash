import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/i18n/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	platform: "browser",
	// @tiptap/suggestion is intentionally bundled (devDependency)
	inlineOnly: false,
	external: [
		"react",
		"react-dom",
		"react/jsx-runtime",
		"react/jsx-dev-runtime",
		// Keep TanStack external - Vite in consumer project will need to resolve these
		"@tanstack/react-router",
		"@tanstack/react-query",
	],
});
