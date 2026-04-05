import node from "@astrojs/node";
import react from "@astrojs/react";
import sitemap from "@astrojs/sitemap";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

const dbUrl = process.env.DATABASE_URL ?? "file:./data/data.db";
const uploadsDir = process.env.UPLOADS_DIR ?? "./uploads";

export default defineConfig({
	site: "https://rgb-animation.com",
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
		sitemap({
			i18n: {
				defaultLocale: "ja",
				locales: {
					ja: "ja-JP",
					en: "en-US",
				},
			},
		}),
		emdash({
			database: sqlite({ url: dbUrl }),
			storage: local({
				directory: uploadsDir,
				baseUrl: "/_emdash/api/media/file",
			}),
		}),
	],
	i18n: {
		defaultLocale: "ja",
		locales: ["ja", "en"],
		routing: {
			prefixDefaultLocale: false,
		},
	},
	compressHTML: true,
	build: {
		inlineStylesheets: "auto",
	},
	vite: {
		css: {
			modules: {
				localsConvention: "camelCaseOnly",
			},
		},
	},
	devToolbar: { enabled: false },
});
