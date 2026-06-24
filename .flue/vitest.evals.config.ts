import { defineConfig } from "vitest/config";

// Live-model evals run separately from any unit tests: different discovery,
// long timeouts (a real classifier call), and the vitest-evals reporter.
export default defineConfig({
	test: {
		include: ["evals/**/*.eval.ts"],
		reporters: ["default", "vitest-evals/reporter"],
		testTimeout: 120_000,
	},
});
