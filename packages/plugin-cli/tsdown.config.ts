import { defineConfig } from "tsdown";

// pnpm applies the image-size patch only inside this workspace, so both
// published entries must bundle the patched implementation.
const bundledPatchedDependencies = ["image-size"];

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
		noExternal: bundledPatchedDependencies,
		inlineOnly: bundledPatchedDependencies,
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
		noExternal: bundledPatchedDependencies,
		inlineOnly: bundledPatchedDependencies,
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
