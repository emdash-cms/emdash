import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/**/*.test.ts"],
		exclude: ["tests/confidential-oauth-workerd.test.ts"],
	},
});
