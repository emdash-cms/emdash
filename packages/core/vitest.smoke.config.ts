import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: [
			"tests/integration/smoke/**/*.test.ts",
			"tests/integration/cli/**/*.test.ts",
			"tests/integration/client/**/*.test.ts",
		],
		// Smoke tests boot real Astro dev servers in beforeAll hooks.
		// Default hookTimeout (10s) is too short -- server startup +
		// migrations + seed can take 30-60s, especially on first run
		// when pnpm build hasn't been cached.
		testTimeout: 30_000,
		hookTimeout: 120_000,
	},
});
