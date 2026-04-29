import cloudflare from "@astrojs/cloudflare";
import node from "@astrojs/node";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

const target = process.env.EMDASH_FIXTURE_TARGET ?? "sqlite";

const sqliteIntegration = emdash({
	database: sqlite({ url: "file:./data.db" }),
	storage: local({
		directory: "./uploads",
		baseUrl: "/_emdash/api/media/file",
	}),
});

const d1Integration = emdash({
	database: d1({ binding: "DB", session: "auto" }),
	storage: r2({ binding: "MEDIA" }),
});

export default defineConfig({
	output: "server",
	adapter:
		target === "d1"
			? cloudflare()
			: node({
					mode: "standalone",
				}),
	integrations: [react(), target === "d1" ? d1Integration : sqliteIntegration],
	devToolbar: { enabled: false },
});
