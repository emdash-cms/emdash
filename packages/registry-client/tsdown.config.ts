import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/credentials/index.ts",
		"src/discovery/index.ts",
		"src/env/index.ts",
		"src/publishing/index.ts",
	],
	format: ["esm"],
	outExtensions: () => ({ js: ".js" }),
	dts: true,
	clean: true,
	platform: "node",
	target: "node22",
	// semver (a devDependency) is bundled on purpose so its CJS `require` never
	// reaches workerd (#1292). Disable tsdown's bundled-dependency advisory,
	// which CI escalates to an error.
	inlineOnly: false,
	external: [
		"@atcute/atproto",
		"@atcute/client",
		"@atcute/lexicons",
		"@atcute/lexicons/syntax",
		"@emdash-cms/registry-lexicons",
	],
});
