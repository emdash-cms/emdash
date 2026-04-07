import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { postgres } from "emdash/db";

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	integrations: [
		react({ babel: { plugins: ["@lingui/babel-plugin-lingui-macro"] } }),
		emdash({
			database: postgres({
				connectionString: process.env.DATABASE_URL || "postgres://localhost:5432/emdash_dev",
			}),
		}),
	],
	devToolbar: { enabled: false },
});
