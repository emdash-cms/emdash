import { defineConfig } from "vitest/config";

import base from "./vitest.config.ts";

// Host tests start servers and child processes, and what they observe depends on the Node.js
// release that runs them, so they run on their own.
export default defineConfig({
	plugins: base.plugins,
	test: {
		globals: true,
		environment: "node",
		include: ["tests/hosts/**/*.test.ts"],
		// Child processes and fixture servers load the built package; test-only child scripts are
		// bundled from source.
		globalSetup: ["tests/integration/global-setup.ts", "tests/hosts/global-setup.ts"],
		testTimeout: 60_000,
		hookTimeout: 240_000,
	},
});
