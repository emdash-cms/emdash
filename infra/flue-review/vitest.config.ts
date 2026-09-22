import { fileURLToPath } from "node:url";

import { defineConfig } from "vitest/config";

export default defineConfig({
	test: {
		server: {
			deps: { inline: ["@flue/runtime"] },
		},
	},
	resolve: {
		alias: {
			"cloudflare:workers": fileURLToPath(
				new URL("./test/stubs/cloudflare-workers.ts", import.meta.url),
			),
		},
	},
});
