import node from "@astrojs/node";
import react from "@astrojs/react";
import { apiTestPlugin } from "@emdash-cms/plugin-api-test";
import { embedsPlugin } from "@emdash-cms/plugin-embeds";
import { localPlugin } from "@emdash-cms/registry-cli/dev";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

// Sandboxed plugins are loaded directly from their source dirs via
// localPlugin(). The trusted plugins (api-test, embeds) keep their
// factory-based imports for now — they haven't migrated to the new
// shape yet.
const auditLog = await localPlugin("../../packages/plugins/audit-log");
const webhookNotifier = await localPlugin("../../packages/plugins/webhook-notifier");

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	integrations: [
		react(),
		emdash({
			// SQLite database for demo
			database: sqlite({ url: "file:./data.db" }),

			// Register plugins - order matters for hook execution!
			plugins: [
				// 1. Audit log runs last (priority 200) to capture final state
				auditLog,

				// 2. Webhook notifier sends events to external URLs
				webhookNotifier,

				// 3. Embeds plugin for YouTube, Vimeo, Twitter, etc.
				embedsPlugin(),

				// 4. API Test plugin - exercises all v2 APIs
				apiTestPlugin(),
			],
		}),
	],
});
