import { transformAsync } from "@babel/core";
import type { Plugin } from "rolldown";
import { defineConfig } from "tsdown";

const JS_TS_RE = /\.[jt]sx?$/;

function linguiMacroPlugin(): Plugin {
	return {
		name: "lingui-macro",
		transform: {
			filter: { id: JS_TS_RE },
			async handler(code: string, id: string) {
				if (!code.includes("@lingui")) return;
				const result = await transformAsync(code, {
					filename: id,
					plugins: ["@lingui/babel-plugin-lingui-macro"],
					parserOpts: { plugins: ["jsx", "typescript"] },
				});
				if (!result?.code) return;
				return { code: result.code, map: result.map ?? undefined };
			},
		},
	};
}

export default defineConfig({
	// locales/config and locales/emails are separate server-safe entries:
	// EmDash core imports them from API routes, where the locales barrel's
	// React/Kumo graph must not be pulled into the server bundle.
	entry: [
		"src/index.ts",
		"src/locales/index.ts",
		"src/locales/config.ts",
		"src/locales/emails.ts",
		"src/portable-text-table.ts",
		"src/slugify.ts",
	],
	format: ["esm"],
	dts: true,
	clean: true,
	platform: "browser",
	plugins: [linguiMacroPlugin()],
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
