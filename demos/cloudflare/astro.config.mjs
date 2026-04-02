// @ts-check
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import {
	d1,
	r2,
	access,
	sandbox,
	cloudflareCache,
	cloudflareImages,
	cloudflareStream,
} from "@emdash-cms/cloudflare";
import { formsPlugin } from "@emdash-cms/plugin-forms";
import { webhookNotifierPlugin } from "@emdash-cms/plugin-webhook-notifier";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

export default defineConfig({
	output: "server",
	adapter: cloudflare({
		imageService: "cloudflare",
	}),
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr", "es", "pt-br"],
		fallback: {
			fr: "en",
			es: "en",
			"pt-br": "en",
		},
	},
	image: {
		// Enable responsive images globally
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			// D1 database - binding name must match wrangler.jsonc
			// session: "auto" enables read replicas (nearest replica for anon,
			// bookmark-based consistency for authenticated users)
			database: d1({ binding: "DB", session: "auto" }),
			// R2 storage for media
			storage: r2({ binding: "MEDIA" }),
			// Cloudflare Access authentication
			// Reads CF_ACCESS_AUDIENCE from env (wrangler secret or .dev.vars)
			auth: access({
				teamDomain: "cloudflare-cto.cloudflareaccess.com",
				autoProvision: true,
				defaultRole: 30, // Author
				// Map your IdP groups to roles (optional)
				// roleMapping: {
				// 	"Admins": 50,
				// 	"Editors": 40,
				// },
			}),
			// Media providers - Cloudflare Images and Stream
			// Reads from env vars at runtime: CF_ACCOUNT_ID, CF_IMAGES_TOKEN, CF_STREAM_TOKEN
			// Or customize with accountIdEnvVar/apiTokenEnvVar options
			mediaProviders: [
				cloudflareImages({
					accountIdEnvVar: "CF_MEDIA_ACCOUNT_ID",
					apiTokenEnvVar: "CF_MEDIA_API_TOKEN",
					accountHash: "5LGXGUnHU18h6ehN_xjpXQ",
				}),
				cloudflareStream({
					accountIdEnvVar: "CF_MEDIA_ACCOUNT_ID",
					apiTokenEnvVar: "CF_MEDIA_API_TOKEN",
				}),
			],
			// Trusted plugins (run in host worker)
			plugins: [
				// Test plugin that exercises all v2 APIs
				formsPlugin(),
			],
			// Sandboxed plugins (run in isolated workers)
			sandboxed: [webhookNotifierPlugin()],
			// Sandbox runner for Cloudflare
			sandboxRunner: sandbox(),
			// Plugin marketplace
			marketplace: "https://marketplace.emdashcms.com",
		}),
	],
	experimental: {
		cache: {
			provider: cloudflareCache(),
		},
		routeRules: {
			"/": {
				maxAge: 3_600,
				swr: 864_000,
			},
			"/[...slug]": {
				maxAge: 3_600,
				swr: 864_000,
			},
		},
	},
	devToolbar: { enabled: false },
});
