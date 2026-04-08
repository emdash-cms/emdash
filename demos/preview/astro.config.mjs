import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { previewDatabase } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	integrations: [
		react(),
		emdash({
			// DO-backed preview database — populated from source site snapshots
			database: previewDatabase({ binding: "PREVIEW_DB" }),
		}),
	],
	devToolbar: { enabled: false },
});
