import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

import { emdashPluginTest } from "./src/config.js";

const fixture = fileURLToPath(new URL("./test/fixture", import.meta.url));

export default defineConfig({
	plugins: [emdashPluginTest({ dir: fixture })],
	test: {
		include: ["test/**/*.test.ts"],
		testTimeout: 30_000,
		hookTimeout: 30_000,
	},
});
