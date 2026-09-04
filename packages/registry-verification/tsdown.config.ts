import { defineConfig } from "tsdown";

// Consumers rebundle this artifact, where import.meta.url may no longer name a file.
// The generated require only resolves Node builtins, so a stable absolute base is sufficient.
const rebundleSafeRequire = {
	name: "rebundle-safe-require",
	renderChunk(code: string) {
		return code.replace(
			"createRequire(import.meta.url)",
			'createRequire("file:///emdash-registry-verification.js")',
		);
	},
};

export default defineConfig([
	{
		entry: [
			"src/artifact.ts",
			"src/bundle.ts",
			"src/checksum.ts",
			"src/fetch-entry.ts",
			"src/records-entry.ts",
		],
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
		plugins: [rebundleSafeRequire],
		outputOptions: { codeSplitting: false },
		// Sigstore is bundled so the published workerd path carries our pinned
		// @sigstore/core algorithm-selection fix instead of resolving a pristine copy.
		inlineOnly: false,
		external: ["@emdash-cms/plugin-types", "modern-tar"],
	},
]);
