#!/usr/bin/env node
/**
 * Guard: no subpath export ships raw TypeScript source.
 *
 * `emdash` used to expose `./routes/*`, `./api/*`, `./auth/providers/*` (and
 * more) as raw `./src/*.ts`. `skipLibCheck` does not skip `.ts`, so a strict
 * consumer's `tsc` type-checked our source and its transitive graph against
 * their config -- and, because the raw source imported `Database` etc. from
 * `src` while `emdash/locals` provided the compiled `dist` identity, hit a
 * dual-package type-identity wall (issue #1053 was one symptom).
 *
 * The fix was structural: those subpaths are now compiled to
 * `dist/*.mjs` + `dist/*.d.mts`, so consumers only ever see declarations
 * (`skipLibCheck` covers them). This guard keeps it that way: it fails CI if
 * any subpath export target is a raw `.ts`/`.tsx` file again.
 *
 * Documented exception: modules that bridge into `.astro` cannot be compiled
 * (the consumer's Astro build must process the `.astro`), so they ship as
 * source by necessity, exactly like the `.astro` files themselves. The
 * allowlist below names them; `.astro` targets are always fine.
 *
 * This replaced an earlier fixture-based consumer-typecheck harness: once raw
 * source is not shipped, there is no raw-source graph to type-check, so a
 * static export-shape check is the whole guarantee.
 */

import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkgPath = resolve(repoRoot, "packages/core/package.json");

/**
 * Export keys allowed to ship raw source because they bridge into `.astro`
 * components the consumer's Astro build must process (same class as the
 * `.astro` targets themselves). Keep this list short and justified.
 */
const ASTRO_COUPLED = new Set([
	"./ui", // src/ui.ts -- re-exports Astro <Image>/<PortableText> components
]);

// `.ts`/`.tsx` source, but NOT `.d.ts` declarations (those are the desired
// shipping form -- `skipLibCheck` covers them).
const RAW_SOURCE = /(?<!\.d)\.tsx?$/;

/** Walk an exports value (string | conditions object) collecting targets. */
function targets(value) {
	if (typeof value === "string") return [value];
	if (value && typeof value === "object") return Object.values(value).flatMap(targets);
	return [];
}

const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
const offenders = [];
for (const [key, value] of Object.entries(pkg.exports ?? {})) {
	if (ASTRO_COUPLED.has(key)) continue;
	for (const target of targets(value)) {
		if (RAW_SOURCE.test(target)) offenders.push(`${key} -> ${target}`);
	}
}

if (offenders.length > 0) {
	console.error(
		"[public-source-guard] FAIL -- subpath export(s) ship raw .ts/.tsx source.\n" +
			"Raw source is type-checked by strict consumers and reintroduces the\n" +
			"dual-package identity hazard (#1053). Compile these to dist (.mjs +\n" +
			".d.mts) via tsdown, or -- only if they bridge into .astro -- add the\n" +
			"key to ASTRO_COUPLED in this script with a justification.\n",
	);
	for (const o of offenders) console.error("  " + o);
	process.exit(1);
}

console.log(
	`[public-source-guard] OK -- no subpath export ships raw .ts/.tsx ` +
		`(${ASTRO_COUPLED.size} documented .astro-coupled exception(s)).`,
);
