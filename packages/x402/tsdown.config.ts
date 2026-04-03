import { defineConfig } from "tsdown";

export default defineConfig({
	entry: ["src/index.ts", "src/middleware.ts"],
	format: ["esm"],
	dts: true,
	clean: true,
	inlineOnly: false,
	external: ["astro:middleware", "virtual:x402/config"],
});
