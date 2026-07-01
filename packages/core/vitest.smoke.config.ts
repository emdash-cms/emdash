import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/integration/smoke/**/*.test.ts"],
		// Smoke tests boot real Astro dev servers in beforeAll hooks.
		// Default hookTimeout (10s) is too short -- server startup +
		// migrations + seed can take 30-60s, especially on first run
		// when pnpm build hasn't been cached.
		testTimeout: 30_000,
		hookTimeout: 120_000,
		// Smoke files boot real dev servers against shared template/demo
		// sites. Two files booting the same site concurrently would race on
		// that site's node_modules/.vite cache (the cold-cache dep-optimizer
		// guard wipes it). Run smoke files one at a time.
		fileParallelism: false,
	},
});
