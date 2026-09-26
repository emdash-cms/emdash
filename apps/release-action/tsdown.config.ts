import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	outExtensions: () => ({ js: ".js" }),
	dts: false,
	clean: true,
	platform: "node",
	target: "node24",
	noExternal: [/.*/],
	inlineOnly: false,
	outputOptions: { codeSplitting: false },
});
