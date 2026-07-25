import { defineConfig } from "tsdown";

export default defineConfig([
	{
		entry: ["src/bundle.ts", "src/checksum.ts", "src/fetch-entry.ts"],
		format: ["esm"],
		outExtensions: () => ({ js: ".js" }),
		dts: true,
		clean: true,
		platform: "neutral",
		target: "es2024",
		external: ["@emdash-cms/plugin-types", "modern-tar"],
	},
	{
		entry: ["src/index.ts"],
		format: ["esm"],
		outExtensions: () => ({ js: ".js" }),
		dts: true,
		clean: false,
		platform: "node",
		target: "es2024",
		// Sigstore is bundled so the published workerd path carries our pinned
		// @sigstore/core algorithm-selection fix instead of resolving a pristine copy.
		inlineOnly: false,
		external: ["@emdash-cms/plugin-types", "modern-tar"],
	},
]);
