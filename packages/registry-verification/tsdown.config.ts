import { esmExternalRequirePlugin } from "rolldown/plugins";
import { defineConfig } from "tsdown";

export default defineConfig([
	{
		entry: [
			"src/artifact.ts",
			"src/bundle.ts",
			"src/checksum.ts",
			"src/fetch-entry.ts",
			"src/records-entry.ts",
			"src/repository.ts",
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
		// Workers adapters can shim createRequire with an unsupported implementation.
		plugins: [esmExternalRequirePlugin({ external: [/^(?:node:)?(?:crypto|util)$/] })],
		outputOptions: {
			codeSplitting: false,
			paths: { crypto: "node:crypto", util: "node:util" },
		},
		// Sigstore is bundled so the published workerd path carries our pinned
		// @sigstore/core algorithm-selection fix instead of resolving a pristine copy.
		inlineOnly: false,
		external: ["@emdash-cms/plugin-types", "modern-tar"],
	},
]);
