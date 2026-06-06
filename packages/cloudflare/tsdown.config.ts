import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/db/d1.ts",
		"src/db/do.ts",
		"src/db/playground.ts",
		"src/db/playground-middleware.ts",
		"src/storage/r2.ts",
		"src/auth/index.ts",
		"src/sandbox/index.ts",
		"src/plugins/index.ts",
		// Media provider runtimes
		"src/media/images-runtime.ts",
		"src/media/stream-runtime.ts",
		// Cache provider (full-page response cache)
		"src/cache/runtime.ts",
		"src/cache/config.ts",
		// Object cache backend (KV)
		"src/cache/kv.ts",
	],
	format: ["esm"],
	dts: true,
	clean: true,
	external: ["cloudflare:workers", "cloudflare:email"],
});
