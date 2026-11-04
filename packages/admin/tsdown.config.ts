import { transformAsync } from "@babel/core";
import type { Plugin } from "rolldown";
import { defineConfig } from "tsdown";

const JS_TS_RE = /\.[jt]sx?$/;
const LOCALE_CATALOG_RE = /[/\\]src[/\\]locales[/\\]([^/\\]+)[/\\]messages\.mjs$/;

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

/**
 * Emits `locales-manifest.json`, mapping each locale code to the chunk that
 * holds its compiled catalog. EmDash core reads it to apply `admin.locales`.
 */
function localeManifestPlugin(): Plugin {
	return {
		name: "emdash-locale-manifest",
		generateBundle(_options, bundle) {
			const entries: [string, string][] = [];
			for (const output of Object.values(bundle)) {
				if (output.type !== "chunk" || !output.facadeModuleId) continue;
				const code = LOCALE_CATALOG_RE.exec(output.facadeModuleId)?.[1];
				if (code) entries.push([code, output.fileName]);
			}
			if (entries.length === 0) {
				this.error("No locale catalog chunks were emitted. Run `pnpm locale:compile` first.");
			}
			const locales = Object.fromEntries(entries.toSorted(([a], [b]) => a.localeCompare(b)));
			this.emitFile({
				type: "asset",
				fileName: "locales-manifest.json",
				source: `${JSON.stringify({ locales }, null, "\t")}\n`,
			});
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
		"src/locales/server.ts",
		"src/locales/config.ts",
		"src/locales/emails.ts",
		"src/portable-text-table.ts",
		"src/html-block.ts",
		"src/slugify.ts",
	],
	format: ["esm"],
	dts: true,
	clean: true,
	platform: "browser",
	plugins: [linguiMacroPlugin(), localeManifestPlugin()],
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
