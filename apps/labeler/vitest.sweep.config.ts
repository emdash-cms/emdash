import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["evals/model-sweep.live.test.ts"],
		maxWorkers: 1,
		testTimeout: 2 * 60 * 60 * 1_000,
		hookTimeout: 2 * 60 * 60 * 1_000,
	},
});
