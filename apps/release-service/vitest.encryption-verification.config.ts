import { defineConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

export default defineConfig({
	...baseConfig,
	test: {
		...baseConfig.test,
		include: ["test/encryption-verification-workflow.test.ts"],
		exclude: baseConfig.test.exclude.filter(
			(pattern) => pattern !== "test/encryption-verification-workflow.test.ts",
		),
	},
});
