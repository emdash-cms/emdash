// @ts-check
import node from "@astrojs/node";
import react from "@astrojs/react";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";
import { sqlite } from "emdash/db";

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: "file:./data.db" }),
		}),
	],
	// Optional: Add custom fonts
	// experimental: {
	// 	fonts: [
	// 		{
	// 			provider: "google",
	// 			family: "Inter",
	// 			weights: [400, 500, 600, 700],
	// 		},
	// 	],
	// },
});
