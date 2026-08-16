import { defineConfig } from "tsdown";

export default defineConfig([
	// CLI binary: `emdash-plugin`. Bundled to a single .mjs.
	{
		entry: ["src/index.ts"],
		format: ["esm"],
		outExtensions: () => ({ js: ".mjs" }),
		dts: false,
		clean: true,
		platform: "node",
		target: "node22",
		shims: false,
		noExternal: ["image-size"],
		inlineOnly: ["image-size"],
	},
	// Programmatic API entry. With tsdown's ESM defaults this emits
	// `.mjs` + `.d.mts` (matching the `exports` field in package.json).
	{
		entry: ["src/api.ts"],
		format: ["esm"],
		dts: true,
		clean: false,
		platform: "node",
		target: "node22",
		noExternal: ["image-size"],
		inlineOnly: ["image-size"],
		external: [
			"@atcute/client",
			"@atcute/identity-resolver",
			"@atcute/lexicons",
			"@atcute/multibase",
			"@atcute/oauth-node-client",
			"@emdash-cms/plugin-types",
			"@emdash-cms/registry-client",
			"@emdash-cms/registry-lexicons",
			"@oslojs/crypto",
			"chokidar",
			"citty",
			"consola",
			"jsonc-parser",
			"modern-tar",
			"picocolors",
			"tsdown",
			"zod",
		],
	},
]);
