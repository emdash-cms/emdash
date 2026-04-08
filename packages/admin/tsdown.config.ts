import { transformAsync } from "@babel/core";
import type { Plugin } from "rolldown";
import { defineConfig } from "tsdown";

const JS_TS_RE = /\.[jt]sx?$/;

function linguiBabelPlugin(): Plugin {
	return {
		name: "lingui-babel-macro",
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
	entry: ["src/index.ts", "src/locales/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	platform: "browser",
	plugins: [linguiBabelPlugin()],
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
