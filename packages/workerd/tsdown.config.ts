import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/sandbox/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	// miniflare is a devDependency, dynamically imported at runtime
	external: ["miniflare"],
});
