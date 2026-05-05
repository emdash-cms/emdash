import { defineConfig } from "tsdown";

export default defineConfig([
	// CLI binary: `emdash-registry`. Bundled to a single .mjs.
	{
		entry: ["src/index.ts"],
		format: ["esm"],
		outExtensions: () => ({ js: ".mjs" }),
		dts: false,
		clean: true,
		platform: "node",
		target: "node22",
		shims: false,
	},
	// Programmatic API entry. Ships .js + .d.ts so consumers get types.
	{
		entry: ["src/api.ts"],
		format: ["esm"],
		dts: true,
		clean: false,
		platform: "node",
		target: "node22",
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
			"citty",
			"consola",
			"image-size",
			"modern-tar",
			"picocolors",
			"tsdown",
		],
	},
]);
