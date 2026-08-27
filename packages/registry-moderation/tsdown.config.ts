import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/fixtures/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	platform: "neutral",
	target: "es2023",
});
