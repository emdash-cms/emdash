import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		globals: true,
		environment: "node",
		include: ["tests/integration/cli/**/*.test.ts", "tests/integration/client/**/*.test.ts"],
		// These tests boot real Astro dev servers in beforeAll hooks.
		// Default hookTimeout (10s) is too short -- server startup +
		// migrations + seed can take 30-60s.
		testTimeout: 30_000,
		hookTimeout: 120_000,
	},
});
