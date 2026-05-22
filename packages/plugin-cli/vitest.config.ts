import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["tests/**/*.test.ts"],
		// Bundle / build tests run a full tsdown probe + transpile,
		// which is fast locally but can take >5s on cold CI runners.
		testTimeout: 30_000,
	},
});
