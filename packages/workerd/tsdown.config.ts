import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/sandbox/index.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	external: [
		// Native Node modules
		"better-sqlite3",
		// miniflare is a devDependency, dynamically imported at runtime
		"miniflare",
	],
});
