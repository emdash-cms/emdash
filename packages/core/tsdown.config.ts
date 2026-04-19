import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

import { defineConfig } from "tsdown";

const pkg = JSON.parse(readFileSync("package.json", "utf-8")) as { version: string };
const commit = (() => {
	try {
		return execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim();
	} catch {
		return "unknown";
	}
})();

export default defineConfig({
	entry: [
		"src/index.ts",
		// Request context (ALS singleton - must be a separate entry for dedup)
		"src/request-context.ts",
		// Astro integration (build-time)
		"src/astro/index.ts",
		"src/astro/middleware.ts",
		"src/astro/middleware/setup.ts",
		"src/astro/middleware/auth.ts",
		"src/astro/middleware/redirect.ts",
		"src/astro/middleware/request-context.ts",
		"src/astro/types.ts",
		// Database adapters (config-time + runtime via virtual:emdash/dialect)
		"src/db/index.ts",
		"src/db/sqlite.ts",
		"src/db/libsql.ts",
		"src/db/postgres.ts",
		// Query instrumentation (used by first-party adapters like @emdash-cms/cloudflare)
		"src/database/instrumentation.ts",
		// Storage adapters (runtime - loaded via virtual:emdash/storage)
		"src/storage/local.ts",
		"src/storage/s3.ts",
		// Media providers
		"src/media/index.ts",
		"src/media/local-runtime.ts",
		// Runtime exports (depends on virtual modules - for live.config.ts)
		"src/runtime.ts",
		// Seed engine
		"src/seed/index.ts",
		// CLI
		"src/cli/index.ts",
		// Client (programmatic editing API)
		"src/client/index.ts",
		"src/client/cf-access.ts",
		// SEO helpers
		"src/seo/index.ts",
		// Public page contributions
		"src/page/index.ts",
		// Plugin admin utilities (shared helpers for plugin admin.tsx files)
		"src/plugin-utils.ts",
		// Standard plugin adapter (loaded by virtual:emdash/plugins at runtime)
		"src/plugins/adapt-sandbox-entry.ts",
	],
	format: "esm",
	dts: true,
	clean: true,
	define: {
		__EMDASH_VERSION__: JSON.stringify(pkg.version),
		__EMDASH_COMMIT__: JSON.stringify(commit),
	},
	// Externalize native modules, dialect-specific packages, and internal shared modules
	external: [
		// Native modules that use __filename
		"better-sqlite3",
		"bindings",
		"file-uri-to-path",
		// Dialect-specific packages
		"@libsql/kysely-libsql",
		"pg",
		// Build tooling (CLI-time dependency with native bindings)
		"tsdown",
		// Astro virtual modules
		"astro:middleware",
		"astro:content",
		// EmDash virtual modules (resolved at runtime by Vite)
		/^virtual:emdash\//,
	],
});
