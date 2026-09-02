import { configDefaults, defineConfig } from "vitest/config";

import baseConfig from "./vitest.config.js";

export default defineConfig({
	...baseConfig,
	test: {
		...baseConfig.test,
		include: ["test/encryption-verification-workflow.test.ts"],
		exclude: [...configDefaults.exclude, "src/ui/**/*.test.{ts,tsx}", "e2e/**/*.spec.ts"],
	},
});
