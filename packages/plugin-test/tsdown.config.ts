import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/config.ts", "src/worker.ts"],
	format: "esm",
	dts: true,
	clean: true,
	external: ["cloudflare:workers", "cloudflare:test"],
});
