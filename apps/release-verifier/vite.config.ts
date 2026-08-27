import { fileURLToPath } from "node:url";

import { cloudflare } from "@cloudflare/vite-plugin";
import { defineConfig } from "vite";

export default defineConfig({
	plugins: [cloudflare()],
	resolve: {
		alias: {
			"@emdash-cms/registry-verification": fileURLToPath(
				new URL("../../packages/registry-verification/src/index.ts", import.meta.url),
			),
		},
	},
});
