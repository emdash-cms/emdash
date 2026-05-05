import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	outExtensions: () => ({ js: ".mjs" }),
	dts: false,
	clean: true,
	platform: "node",
	target: "node22",
	shims: false,
});
