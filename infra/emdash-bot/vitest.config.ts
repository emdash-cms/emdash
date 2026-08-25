// Pure-vitest config for tests/unit/. Anything that needs bindings (DOs, AI,
// Sandbox) goes in tests/integration/ and runs under vitest.workers.config.ts
// against @cloudflare/vitest-pool-workers.
import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		include: ["tests/unit/**/*.test.ts"],
	},
});
