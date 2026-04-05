import node from "@astrojs/node";
import react from "@astrojs/react";
import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

// In Docker the SQLite file lives inside the volume-mounted ./data/ directory.
// Fall back to the repo root for local development.
const dbUrl = process.env.DATABASE_URL ?? "file:./data/data.db";
const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: dbUrl }),
			storage: local({
				directory: uploadsDir,
				baseUrl: "/_emdash/api/media/file",
			}),
			plugins: [auditLogPlugin()],
		}),
	],
	devToolbar: { enabled: false },
});
