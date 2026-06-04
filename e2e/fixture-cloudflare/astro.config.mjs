/**
 * Minimal Astro config for Playwright e2e tests against the Cloudflare runtime.
 *
 * Mirrors e2e/fixture but swaps the Node adapter + SQLite for the Cloudflare
 * adapter + D1/R2, so `astro dev` runs the workerd SSR module runner. Bindings
 * (DB, MEDIA) come from wrangler.jsonc via the adapter's local platform proxy.
 */
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2 } from "@emdash-cms/cloudflare";
import { colorPlugin } from "@emdash-cms/plugin-color";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

const marketplaceUrl = process.env.EMDASH_MARKETPLACE_URL || undefined;

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB" }),
			storage: r2({ binding: "MEDIA" }),
			plugins: [colorPlugin()],
			marketplace: marketplaceUrl,
			sandboxRunner: marketplaceUrl ? "./noop-sandbox.mjs" : undefined,
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
			fs: { strict: false },
		},
	},
});
