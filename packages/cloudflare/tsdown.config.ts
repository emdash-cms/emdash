import { defineConfig } from "tsdown";

export default defineConfig({
	entry: [
		"src/index.ts",
		"src/db/d1.ts",
		"src/db/hyperdrive.ts",
		"src/db/do.ts",
		"src/db/do-sql.ts",
		"src/db/playground.ts",
		"src/db/playground-middleware.ts",
		"src/storage/r2.ts",
		"src/image-endpoint.ts",
		"src/auth/index.ts",
		"src/sandbox/index.ts",
		"src/worker.ts",
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
	// @astrojs/cloudflare's server entrypoint and `astro/app/entrypoint` both
	// resolve the build-time `virtual:astro:app` module — only available in the
	// consuming app's Astro build, never here. Keep them external so the bare
	// imports survive to be resolved downstream.
	external: ["cloudflare:workers", "cloudflare:email", /^@astrojs\/cloudflare/, /^astro($|\/)/],
});
