import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	sourcemap: false,
	banner: {
		js: "#!/usr/bin/env node",
	},
});
