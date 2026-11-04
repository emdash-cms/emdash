import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Minimal Astro config for Playwright e2e tests against the Cloudflare runtime.
 *
 * Mirrors e2e/fixture but swaps the Node adapter + SQLite for the Cloudflare
 * adapter + D1/R2, so `astro dev` runs the workerd SSR module runner. Bindings
 * (DB, MEDIA) come from wrangler.jsonc via the adapter's local platform proxy.
 */
import cloudflare from "@astrojs/cloudflare";
import react from "@astrojs/react";
import { d1, r2, sandbox } from "@emdash-cms/cloudflare";
import { colorPlugin } from "@emdash-cms/plugin-color";
import registryTestPlugin from "@emdash-cms/plugin-marketplace-test";
import { defineConfig } from "astro/config";
import emdash from "emdash/astro";

const marketplaceUrl = process.env.EMDASH_MARKETPLACE_URL || undefined;
const registryUrl = process.env.EMDASH_REGISTRY_URL || undefined;
const registryFixturePath = process.env.EMDASH_REGISTRY_FIXTURE;
const registryFixture = registryFixturePath
	? JSON.parse(readFileSync(registryFixturePath, "utf8"))
	: null;
const e2eHookNames = new Set([
	"content:afterSave",
	"content:beforeDelete",
	"content:afterDelete",
	"content:beforePublish",
	"content:beforeSchedule",
	"content:beforeUnpublish",
	"content:afterPublish",
	"content:afterUnpublish",
	"content:afterRestore",
	"content:afterSchedule",
	"content:afterUnschedule",
	"media:afterUpload",
	"comment:beforeCreate",
	"comment:afterCreate",
	"comment:afterModerate",
	"email:beforeSend",
	"email:deliver",
	"email:afterSend",
	"cron",
	"page:metadata",
]);
const e2eHooks = registryTestPlugin.hooks.filter((hook) =>
	e2eHookNames.has(typeof hook === "string" ? hook : hook.name),
);
const deniedPlugin = {
	id: "sandbox-denied-test",
	version: "1.0.0",
	format: "standard",
	entrypoint: fileURLToPath(new URL("../fixtures/sandbox-denied-plugin.mjs", import.meta.url)),
	capabilities: [],
	allowedHosts: [],
	storage: {},
	hooks: [],
	routes: [
		{ name: "admin", permission: "plugins:manage" },
		{ name: "authority-probe", permission: "plugins:manage" },
	],
	adminPages: [{ path: "/denials", label: "Denied authority", icon: "shield" }],
};

// Mirrors a server dependency introduced by Astro after the initial dependency scan.
const lateManifestImport = {
	name: "late-manifest-import",
	apply: "serve",
	enforce: "post",
	transform(code, id) {
		if (!id.endsWith("/src/pages/index.astro")) return undefined;
		return `import * as manifest from "astro/app/manifest";\nvoid manifest;\n${code}`;
	},
};

export default defineConfig({
	output: "server",
	adapter: cloudflare(),
	integrations: [
		react(),
		emdash({
			database: d1({ binding: "DB" }),
			middleware: { outer: "./src/outer-middleware.ts" },
			storage: r2({ binding: "MEDIA" }),
			plugins: [colorPlugin()],
			sandboxed: [{ ...registryTestPlugin, hooks: e2eHooks }, deniedPlugin],
			marketplace: marketplaceUrl,
			registry: registryUrl,
			sandboxRunner: sandbox(),
		}),
	],
	i18n: {
		defaultLocale: "en",
		locales: ["en", "fr", "es"],
		fallback: { fr: "en", es: "en" },
	},
	devToolbar: { enabled: false },
	vite: {
		define: {
			__EMDASH_REGISTRY_FIXTURE__: JSON.stringify(registryFixture),
		},
		plugins: [lateManifestImport],
		server: {
			fs: { strict: false },
		},
	},
});
