import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		environment: "node",
		include: ["evals/native-vision-sweep.live.test.ts"],
		maxWorkers: 1,
		testTimeout: 30 * 60 * 1_000,
	},
});
