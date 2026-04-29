/**
 * Minimal Astro config for e2e tests.
 *
 * Uses EMDASH_TEST_DB env var for the database path so each
 * test run gets an isolated database.
 */
import node from "@astrojs/node";
import react from "@astrojs/react";
import { colorPlugin } from "@emdash-cms/plugin-color";
import { defineConfig } from "astro/config";
import emdash, { local } from "emdash/astro";
import { sqlite } from "emdash/db";

const dbUrl = process.env.EMDASH_TEST_DB || "file:./test.db";
const uploadsDir = process.env.EMDASH_TEST_UPLOADS || "./uploads";
const _rawMaxUploadSize = process.env.EMDASH_MAX_UPLOAD_SIZE
	? parseInt(process.env.EMDASH_MAX_UPLOAD_SIZE, 10)
	: undefined;
const maxUploadSize =
	_rawMaxUploadSize !== undefined && Number.isFinite(_rawMaxUploadSize) && _rawMaxUploadSize > 0
		? _rawMaxUploadSize
		: undefined;

export default defineConfig({
	output: "server",
	adapter: node({ mode: "standalone" }),
	integrations: [
		react(),
		emdash({
			database: sqlite({ url: dbUrl }),
			storage: local({ directory: uploadsDir, baseUrl: "/_emdash/api/media/file" }),
			maxUploadSize,
			plugins: [colorPlugin()],
		}),
	],
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr", "es"],
		fallback: { fr: "en", es: "en" },
	},
	devToolbar: { enabled: false },
	vite: {
		server: {
			fs: {
				// When running from a temp dir, node_modules is symlinked back to the
				// monorepo. Vite needs permission to serve files from the real paths.
				strict: false,
			},
		},
	},
});
