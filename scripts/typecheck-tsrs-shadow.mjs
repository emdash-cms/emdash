#!/usr/bin/env node
/**
 * Runs every `tsgo --noEmit` typecheck in the workspace a second time with
 * `tsrs` and reports where the two disagree: exit status, diagnostics
 * (including their indented elaboration lines), and median wall time.
 *
 * `tsgo` stays the authoritative checker; this script only reports. It always
 * exits 0 and emits a GitHub `::warning::` per disagreeing check. Packages
 * typechecked with `astro check` or `tsc` are not compared. With `--runs N`,
 * diagnostics come from the first run; later runs only add timing samples.
 *
 * Usage: node scripts/typecheck-tsrs-shadow.mjs [--runs N]
 */

import { spawnSync } from "node:child_process";
import { appendFileSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

const DIAGNOSTIC = /error TS\d+/;
const CONTINUATION = /^\s/;
const WHITESPACE = /\s+/;
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const binDir = resolve(repoRoot, "node_modules/.bin");
const { values } = parseArgs({ options: { runs: { type: "string", default: "1" } } });
const runs = Math.max(1, Number.parseInt(values.runs, 10) || 1);

const listed = spawnSync("pnpm", ["ls", "-r", "--depth", "-1", "--json"], {
	cwd: repoRoot,
	encoding: "utf8",
});
if (listed.status !== 0) throw new Error(`pnpm ls failed: ${listed.stderr}`);

/** One `tsgo --noEmit [...]` invocation per entry, split on `&&`. */
const checks = [];
for (const { name, path } of JSON.parse(listed.stdout)) {
	const { scripts = {} } = JSON.parse(readFileSync(resolve(path, "package.json"), "utf8"));
	const script = scripts.typecheck;
	if (!script) continue;
	for (const part of script.split("&&").map((p) => p.trim())) {
		const [bin, ...args] = part.split(WHITESPACE);
		if (bin === "tsgo") checks.push({ name, path, args });
	}
}

function version(bin) {
	return spawnSync(resolve(binDir, bin), ["--version"], { encoding: "utf8" }).stdout.trim();
}

/** Groups each `error TS` line with the indented lines that follow it. */
function parseDiagnostics(output) {
	const diagnostics = [];
	for (const line of output.split("\n")) {
		if (DIAGNOSTIC.test(line) && !CONTINUATION.test(line)) diagnostics.push(line.trim());
		else if (CONTINUATION.test(line) && line.trim() && diagnostics.length > 0) {
			diagnostics[diagnostics.length - 1] += `\n${line.trimEnd()}`;
		}
	}
	return diagnostics.toSorted((a, b) => a.localeCompare(b));
}

function run(bin, check) {
	const started = performance.now();
	const result = spawnSync(resolve(binDir, bin), [...check.args, "--pretty", "false"], {
		cwd: check.path,
		encoding: "utf8",
		maxBuffer: 64 * 1024 * 1024,
		timeout: 60_000,
	});
	const ms = performance.now() - started;
	const status = result.status ?? `${result.error?.code ?? result.signal}`;
	return { status, ms, diagnostics: parseDiagnostics(`${result.stdout}${result.stderr}`) };
}

/** Entries of `a` not matched one-for-one in `b`. */
function multisetMinus(a, b) {
	const rest = [...b];
	return a.filter((item) => {
		const index = rest.indexOf(item);
		if (index === -1) return true;
		rest.splice(index, 1);
		return false;
	});
}

function median(numbers) {
	const sorted = numbers.toSorted((a, b) => a - b);
	const middle = Math.floor(sorted.length / 2);
	return sorted.length % 2 === 0 ? (sorted[middle - 1] + sorted[middle]) / 2 : sorted[middle];
}

const rows = [];
for (const check of checks) {
	const label = `${check.name} ${check.args.join(" ")}`;
	const results = { tsgo: [], tsrs: [] };
	for (let i = 0; i < runs; i++) {
		for (const bin of ["tsgo", "tsrs"]) results[bin].push(run(bin, check));
	}
	const [tsgo, tsrs] = [results.tsgo[0], results.tsrs[0]];
	const onlyTsgo = multisetMinus(tsgo.diagnostics, tsrs.diagnostics);
	const onlyTsrs = multisetMinus(tsrs.diagnostics, tsgo.diagnostics);
	const same =
		typeof tsgo.status === "number" &&
		tsgo.status === tsrs.status &&
		onlyTsgo.length === 0 &&
		onlyTsrs.length === 0;
	const tsgoMs = median(results.tsgo.map((r) => r.ms));
	const tsrsMs = median(results.tsrs.map((r) => r.ms));
	const path = relative(repoRoot, check.path);
	rows.push({ label, path, same, tsgo, tsrs, tsgoMs, tsrsMs, onlyTsgo, onlyTsrs });
	console.error(
		`${same ? "same" : "DIFF"} ${label}: tsgo ${tsgoMs.toFixed(0)} ms, tsrs ${tsrsMs.toFixed(0)} ms`,
	);
	if (!same && process.env.GITHUB_ACTIONS) {
		console.error(`::warning title=tsrs shadow typecheck::${label} (${path}) differs from tsgo`);
	}
}

const mismatches = rows.filter((row) => !row.same).length;
const total = (key) => rows.reduce((sum, row) => sum + row[key], 0);
const lines = [
	`## tsrs shadow typecheck`,
	"",
	`- tsgo: ${version("tsgo")}`,
	`- tsrs: ${version("tsrs")}`,
	"",
	`${rows.length} checks, ${mismatches} with differences, median of ${runs} run(s). \`tsgo\` stays authoritative. Differences can come from the TypeScript versions above as well as from the port.`,
	"",
	"| Check | Same | tsgo exit | tsrs exit | tsgo ms | tsrs ms |",
	"| --- | --- | --- | --- | --- | --- |",
	...rows.map(
		(r) =>
			`| \`${r.label}\` | ${r.same ? "yes" : "**no**"} | ${r.tsgo.status} | ${r.tsrs.status} | ${r.tsgoMs.toFixed(0)} | ${r.tsrsMs.toFixed(0)} |`,
	),
	`| **Sum** | | | | ${total("tsgoMs").toFixed(0)} | ${total("tsrsMs").toFixed(0)} |`,
];
for (const r of rows.filter((row) => !row.same)) {
	lines.push("", `### \`${r.label}\` (${r.path})`, "", "```");
	for (const d of r.onlyTsgo) lines.push(`tsgo only: ${d}`);
	for (const d of r.onlyTsrs) lines.push(`tsrs only: ${d}`);
	lines.push("```");
}
const report = `${lines.join("\n")}\n`;
console.log(report);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, report);
