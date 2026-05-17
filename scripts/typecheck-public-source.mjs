#!/usr/bin/env node
/**
 * Public-source typecheck harness.
 *
 * `emdash` ships most of its API as compiled `dist/*.mjs` + `dist/*.d.mts`.
 * `skipLibCheck` covers those for consumers. But a set of subpath exports
 * ship *raw TypeScript source* (`./routes/*`, `./ui`, `./api/*`,
 * `./auth/providers/*`). `skipLibCheck` does NOT skip `.ts` files, so when a
 * consumer's `tsc` resolves one of these subpaths it type-checks our source
 * and its entire transitive import graph against *their* strict config.
 *
 * Our own `pnpm typecheck` does not catch regressions here: it runs `tsgo`
 * against our own lenient tsconfig (no `@cloudflare/workers-types`, excludes
 * `src/astro/**`). A strict consumer on real `tsc`, deployed to Workers,
 * sees a different program. That gap shipped the type errors in #1053.
 *
 * This harness reconstructs the consumer view: it reads the source-exported
 * subpaths from `packages/core/package.json`, expands the `./routes/*` glob
 * over the real route files (only `.ts`/`.tsx` targets -- `.astro` targets
 * cannot be type-checked by tsc), writes a side-effect-import entry into the
 * `fixtures/public-types` consumer fixture, and runs real `tsc --noEmit`
 * with that fixture's strict, Workers-typed config.
 *
 * Boundary: `.astro` and the two `virtual:emdash/*` modules are filtered
 * (TS2307 only, message-anchored). A hermetic type-only harness cannot
 * resolve them; real sites resolve them via the Astro toolchain, covered by
 * the demo and template typecheck jobs. `node_modules/` diagnostics are also
 * dropped -- third-party `.ts` deps are the consumer's problem, not our
 * shipped source, and their pnpm-store paths embed an unstable lockfile hash.
 *
 * Remaining diagnostics are counted per `(file, errorCode)` and compared to a
 * committed baseline (`typecheck-public-source.baseline.json`), like the perf
 * harness's query-count snapshot. A count that grows, or a new `(file, code)`,
 * fails the run. Counts are used (not exact messages or line numbers) so
 * unrelated edits and message-wording drift don't cause churn, while a new
 * shipped-source error in any guarded file is still caught. Disappearing
 * diagnostics are fine; `--update` re-snapshots.
 *
 * Independent of the baseline, a hardcoded sentinel asserts the #1053 error
 * (`wordpress-plugin.ts` TS18046) never reappears, so the guard survives even
 * if the baseline file is corrupted or tsc output drifts.
 *
 * Hard sanity gates make every degenerate tsc outcome fail loudly rather than
 * silently pass: unexpected exit code, error lines that the parser cannot
 * match (format drift), exit 0 with error lines, or a kept diagnostic whose
 * path is not rooted under `packages/` (path-rooting drift) all FAIL.
 *
 * Usage:
 *   node scripts/typecheck-public-source.mjs           # check against baseline
 *   node scripts/typecheck-public-source.mjs --update  # rewrite the baseline
 *   node scripts/typecheck-public-source.mjs --keep    # leave .generated/
 */

import { spawnSync } from "node:child_process";
import { existsSync, globSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(__dirname, "..");
const coreDir = resolve(repoRoot, "packages/core");
const fixtureDir = resolve(repoRoot, "fixtures/public-types");
const generatedDir = resolve(fixtureDir, ".generated");
const entryFile = resolve(generatedDir, "entry.ts");
const baselineFile = resolve(__dirname, "typecheck-public-source.baseline.json");

const update = process.argv.includes("--update");
const keep = process.argv.includes("--keep");

const EXPORT_KEY_LEADING_DOT = /^\./;
const WILDCARD_SUFFIX = /\/\*$/;
const TSX_EXT = /\.tsx?$/;
const DIAGNOSTIC_LINE = /^(.+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/;
const RAW_ERROR = /: error TS\d+:/g;
const DOT_ASTRO_IMPORT = /Cannot find module '[^']*\.astro'/;
// Only the two virtual modules the integration actually generates. A typo'd
// or otherwise unknown `virtual:emdash/*` import is NOT filtered -- that is a
// real bug, not the documented boundary.
const KNOWN_VIRTUAL_IMPORT = /Cannot find module ['"]virtual:emdash\/(?:admin-registry|auth-providers)['"]/;

// Issue #1053. Asserted independently of the baseline file so this specific
// regression can never slip through, even if the baseline or tsc output drifts.
const SENTINEL_KEY = "packages/core/src/import/sources/wordpress-plugin.ts\tTS18046";

// Our shipped source (and its first-party workspace imports) all live here.
// A kept diagnostic outside this prefix means tsc path-rooting drifted.
const OUR_SOURCE_PREFIX = "packages/";

/** Stable lexicographic comparator (oxlint requires an explicit compare). */
const byString = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

function fail(message) {
	console.error(`[typecheck-public-source] FAIL -- ${message}`);
	process.exit(1);
}

/** Subpath export targets that ship raw source rather than compiled dist. */
function sourceExportSpecifiers() {
	const pkg = JSON.parse(readFileSync(resolve(coreDir, "package.json"), "utf-8"));
	const pkgName = pkg.name;
	const specifiers = [];
	for (const [key, value] of Object.entries(pkg.exports)) {
		const target = typeof value === "string" ? value : (value?.default ?? value?.types ?? "");
		if (typeof target !== "string" || !target.startsWith("./src/")) continue;

		// Map the export key to the bare specifier a consumer writes:
		// "./api/route-utils" -> "emdash/api/route-utils", "." -> "emdash".
		const toSpecifier = (exportKey) => pkgName + exportKey.replace(EXPORT_KEY_LEADING_DOT, "");

		if (key.includes("*")) {
			// Glob the real files behind the wildcard and emit one specifier each,
			// keeping the .ts(x) extension (resolved via allowImportingTsExtensions).
			const baseDir = resolve(coreDir, dirname(target).replace(WILDCARD_SUFFIX, ""));
			for (const abs of globSync("**/*.{ts,tsx}", { cwd: baseDir })) {
				const rel = abs.replaceAll("\\", "/");
				specifiers.push(toSpecifier(key.replace("*", rel)));
			}
		} else if (TSX_EXT.test(target)) {
			specifiers.push(toSpecifier(key));
		}
		// `.astro` targets (e.g. ./ui/search) are skipped: tsc can't check them.
	}
	return specifiers.toSorted(byString);
}

/** Parse `path(line,col): error TSxxxx: message` start lines. */
function parseDiagnostics(output) {
	const records = [];
	for (const line of output.split("\n")) {
		const m = DIAGNOSTIC_LINE.exec(line.trim());
		if (!m) continue;
		const [, rawPath, , , code, message] = m;
		// tsc paths are relative to the fixture dir; re-root to the repo.
		const relPath = relative(repoRoot, resolve(fixtureDir, rawPath)).replaceAll("\\", "/");
		records.push({ relPath, code, message });
	}
	return records;
}

/** Documented boundary: unresolvable `.astro` / known virtual modules. */
function isBoundary({ code, message }) {
	return code === "TS2307" && (DOT_ASTRO_IMPORT.test(message) || KNOWN_VIRTUAL_IMPORT.test(message));
}

const specifiers = sourceExportSpecifiers();
if (specifiers.length === 0) fail("no source-exported subpaths found -- export map changed?");

mkdirSync(generatedDir, { recursive: true });
const banner =
	"// GENERATED by scripts/typecheck-public-source.mjs -- do not edit, do not commit.\n" +
	`// ${specifiers.length} .ts/.tsx source-exported entrypoints, type-checked as a strict consumer.\n`;
writeFileSync(entryFile, banner + specifiers.map((s) => `import "${s}";`).join("\n") + "\n");

const tsc = resolve(fixtureDir, "node_modules/.bin/tsc");
const result = spawnSync(tsc, ["--noEmit", "--pretty", "false", "-p", resolve(fixtureDir, "tsconfig.json")], {
	cwd: fixtureDir,
	encoding: "utf-8",
});

if (!keep) rmSync(generatedDir, { recursive: true, force: true });

// --- Hard sanity gates: any degenerate tsc outcome must fail loudly. ---
if (result.status === null) {
	fail(`tsc did not run: ${result.error?.message ?? "unknown error"}`);
}
// tsc exits 0 (clean) or 2 (type errors). Anything else (1, 134/OOM, signals)
// means a crashed/partial run -- its truncated output must not look "clean".
if (result.status !== 0 && result.status !== 2) {
	fail(`tsc exited ${String(result.status)} (expected 0 or 2) -- crashed or partial run, output not trustworthy.`);
}

const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
const rawErrorCount = (output.match(RAW_ERROR) ?? []).length;

if (result.status === 0 && rawErrorCount > 0) {
	fail(`tsc exited 0 but emitted ${rawErrorCount} error line(s) -- inconsistent, refusing to trust.`);
}

const parsed = parseDiagnostics(output);
if (rawErrorCount > 0 && parsed.length === 0) {
	fail(
		`tsc reported ${rawErrorCount} error line(s) but the parser matched none -- ` +
			`diagnostic format drifted; the guard would silently pass. Fix DIAGNOSTIC_LINE.`,
	);
}

// Drop third-party deps (consumer's problem, unstable pnpm-store paths) and
// the documented Astro boundary. Everything kept must be our shipped source.
const kept = parsed.filter((d) => !d.relPath.includes("node_modules/") && !isBoundary(d));

const mislocated = kept.filter((d) => !d.relPath.startsWith(OUR_SOURCE_PREFIX));
if (mislocated.length > 0) {
	fail(
		`kept diagnostic(s) not rooted under '${OUR_SOURCE_PREFIX}' -- tsc path-rooting drifted, ` +
			`baseline comparison is invalid:\n  ${mislocated[0].relPath}`,
	);
}

const counts = {};
for (const { relPath, code } of kept) {
	const key = `${relPath}\t${code}`;
	counts[key] = (counts[key] ?? 0) + 1;
}

// #1053 sentinel: independent of the baseline file.
if (counts[SENTINEL_KEY]) {
	fail(`issue #1053 regressed -- ${SENTINEL_KEY.replace("\t", " ")} reappeared in shipped source.`);
}

if (update) {
	const sorted = Object.fromEntries(Object.entries(counts).toSorted((a, b) => byString(a[0], b[0])));
	writeFileSync(baselineFile, JSON.stringify(sorted, null, "\t") + "\n");
	console.log(
		`[typecheck-public-source] baseline updated -- ${Object.keys(sorted).length} known (file,code) ` +
			`group(s) across ${specifiers.length} entrypoints.`,
	);
	process.exit(0);
}

if (!existsSync(baselineFile)) {
	fail("no baseline file. Run with --update to create it after reviewing the diagnostics.");
}

const baseline = JSON.parse(readFileSync(baselineFile, "utf-8"));
const regressions = Object.entries(counts)
	.filter(([key, n]) => n > (baseline[key] ?? 0))
	.map(([key, n]) => `${key.replace("\t", "  ")}  (now ${String(n)}, baseline ${String(baseline[key] ?? 0)})`)
	.toSorted(byString);

if (regressions.length > 0) {
	console.error(
		`[typecheck-public-source] FAIL -- ${regressions.length} new/grown type error group(s) in shipped source.\n` +
			`These reach real installs; ${relative(repoRoot, fixtureDir)} reproduces the consumer view.\n` +
			`If intentional, review then run: node scripts/typecheck-public-source.mjs --update\n`,
	);
	for (const r of regressions) console.error("  " + r);
	process.exit(1);
}

const prunable = Object.keys(baseline).filter((k) => !counts[k] || counts[k] < baseline[k]).length;
console.log(
	`[typecheck-public-source] OK -- ${specifiers.length} entrypoints, no new type errors ` +
		`(${Object.keys(baseline).length} known group(s) tracked` +
		(prunable > 0 ? `, ${prunable} reduced -- run --update to prune` : "") +
		`).`,
);
process.exit(0);
