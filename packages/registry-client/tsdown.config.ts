import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/credentials/index.ts",
		"src/discovery/index.ts",
		"src/publishing/index.ts",
	],
	format: ["esm"],
	outExtensions: () => ({ js: ".js" }),
	dts: true,
	clean: true,
	platform: "node",
	target: "node22",
	external: [
		"@atcute/atproto",
		"@atcute/client",
		"@atcute/lexicons",
		"@atcute/lexicons/syntax",
		"@emdash-cms/registry-lexicons",
	],
});
