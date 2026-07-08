import { execSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { relative, resolve as resolvePath } from "node:path";

import { defineConfig } from "tsdown";

import { routeArtifactName } from "./src/astro/integration/route-naming.ts";

const srcDir = resolvePath(import.meta.dirname, "src");
const TS_EXT = /\.tsx?$/;

/**
 * Mirror each entry's path under src/ into dist/, preserving the original
 * filename verbatim. tsdown/rolldown's default name template rewrites `[` and
 * `]` to `_`, which would mangle dynamic-route entrypoints
 * (`[collection]`, `[...path]`) and decouple `emdash/routes/*` resolution from
 * the real filenames. Mirroring keeps dist a 1:1 image of src so route
 * injection resolves entrypoints by their actual paths.
 */
function entryFileName(facadeModuleId: string | null, ext: string): string {
	if (facadeModuleId) {
		const rel = relative(srcDir, facadeModuleId);
		if (!rel.startsWith("..")) return routeArtifactName(rel.replace(TS_EXT, "")) + ext;
	}
	return `[name]${ext}`;
}

/**
 * Explicit name -> absolute-path input map for every .ts/.tsx file under
 * src/astro/routes. Fed to rolldown via `inputOptions.input` (an object,
 * resolved literally) rather than tsdown's `entry` (resolved as globs):
 * dynamic-route dirnames like `[collection]` / `[...path]` are glob
 * character-classes, so any glob-based entry silently drops routes nested
 * under a bracketed segment. The map key is the src-relative path (no
 * extension); `entryFileName` turns it back into a 1:1 dist mirror. .astro
 * routes are excluded -- they ship as source for the consumer's Astro build.
 */
function routeInputMap(): Record<string, string> {
	const routesDir = resolvePath(srcDir, "astro/routes");
	const map: Record<string, string> = {};
	for (const d of readdirSync(routesDir, { recursive: true, withFileTypes: true })) {
		if (!d.isFile() || !TS_EXT.test(d.name)) continue;
		const abs = resolvePath(d.parentPath, d.name);
		const key = relative(srcDir, abs).replaceAll("\\", "/").replace(TS_EXT, "");
		map[key] = abs;
	}
	return map;
}

function readPackageVersion(): string {
	const parsed: unknown = JSON.parse(readFileSync("package.json", "utf-8"));
	if (
		typeof parsed === "object" &&
		parsed !== null &&
		"version" in parsed &&
		typeof parsed.version === "string"
	) {
		return parsed.version;
	}
	throw new Error("package.json is missing a string `version` field");
}
const pkg = { version: readPackageVersion() };
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
		// Object-cache memory backend (runtime - loaded via virtual:emdash/object-cache)
		"src/object-cache/memory.ts",
		// Media providers
		"src/media/index.ts",
		"src/media/local-runtime.ts",
		// Image-endpoint helpers (portable) + the Node image endpoint
		"src/media/image-endpoint.ts",
		"src/astro/image-endpoint.ts",
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
		// `emdash/plugin` — type-only subpath for sandboxed plugin authors.
		"src/plugin-types.ts",
		// Standard plugin adapter (loaded by virtual:emdash/plugins at runtime)
		"src/plugins/adapt-sandbox-entry.ts",
		// Public source-exported subpaths -- compiled so consumers never
		// type-check our raw .ts (avoids the dual-package identity hazard).
		// `./ui`, `./ui/search` and the `*-admin.tsx` providers stay source:
		// they bridge runtimes the consumer supplies (Astro components,
		// the admin's React + @cloudflare/kumo), which their own build
		// must process.
		"src/api/route-utils.ts",
		"src/api/schemas/index.ts",
		"src/auth/providers/github.ts",
		"src/auth/providers/google.ts",
		// Injected API/page routes are added via inputOptions below (their
		// `[param]` filenames are hostile to tsdown's glob-based `entry`).
	],
	format: "esm",
	dts: true,
	clean: true,
	// Deps are externalized via `external` + package.json deps; nothing is
	// unintentionally bundled. Suppress tsdown's advisory (CI escalates it).
	inlineOnly: false,
	inputOptions: (options) => {
		// tsdown has already normalized the `entry` array into an input record
		// by this hook; we only augment it with the route map.
		// eslint-disable-next-line typescript/no-unsafe-type-assertion -- normalized input record at the inputOptions hook
		options.input = { ...(options.input as Record<string, string>), ...routeInputMap() };
		return options;
	},
	outputOptions: {
		entryFileNames: (chunk) => entryFileName(chunk.facadeModuleId, ".mjs"),
	},
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
		// Optional S3 storage deps -- resolved at runtime only when used
		/^@aws-sdk\//,
		// Build tooling (CLI-time dependency with native bindings)
		"tsdown",
		// Self-import: compiled route entrypoints `import ... from "emdash"`,
		// resolved at the consumer's runtime where the package is installed.
		"emdash",
		// Astro virtual modules (astro:assets, astro:middleware, astro:content, ...)
		/^astro:/,
		// .astro components/pages -- compiled by the consumer's Astro build
		/\.astro$/,
		// EmDash virtual modules (resolved at runtime by Vite)
		/^virtual:emdash\//,
	],
});
