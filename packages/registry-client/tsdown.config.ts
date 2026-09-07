import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/listing-policy.ts",
		"src/withdrawal.ts",
		"src/conformance/index.ts",
		"src/credentials/index.ts",
		"src/direct-pds/index.ts",
		"src/discovery/index.ts",
		"src/env/index.ts",
		"src/publishing/index.ts",
		"src/release-service/index.ts",
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
		"@atcute/crypto",
		"@atcute/identity",
		"@atcute/identity-resolver",
		"@atcute/lexicons",
		"@atcute/lexicons/syntax",
		"@atcute/repo",
		"@emdash-cms/registry-lexicons",
		"@emdash-cms/registry-moderation",
	],
});
