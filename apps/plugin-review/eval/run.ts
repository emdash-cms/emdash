// Runs the reviewer against a private set of plugin bundles and reports, per
// model, whether each case produced the expected finding categories.
//
// Cases live outside the repository, in the directory named by
// EVAL_CASES_DIR or --cases-dir. Each case is a directory:
//
//   <case>/case.json   { "expect": ["malicious-code"], "listing": [...], "declaredAccess": {...} }
//   <case>/bundle/...  the unpacked bundle files
//
// An empty "expect" list marks a clean case that should produce no findings.

import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { parseArgs } from "node:util";

import { runReview } from "../src/agent.js";
import { gatewayReviewModel } from "../src/models.js";
import type { PluginReviewResponse, ReviewFile } from "../src/types.js";

const DEFAULT_MODELS = "anthropic/claude-opus-5-5,openai/gpt-6.1-sol";
const TIMEOUT_MS = 20 * 60 * 1000;

interface EvalCase {
	name: string;
	expect: string[];
	listing: { ref: string; text: string }[];
	declaredAccess: Record<string, unknown>;
	files: ReviewFile[];
}

const { values } = parseArgs({
	options: {
		"cases-dir": { type: "string" },
		models: { type: "string", default: DEFAULT_MODELS },
		cases: { type: "string" },
		out: { type: "string" },
		addendum: { type: "string" },
	},
});

const casesDir = values["cases-dir"] ?? process.env.EVAL_CASES_DIR;
if (!casesDir) {
	console.error("Set EVAL_CASES_DIR or pass --cases-dir.");
	process.exit(2);
}
const repoRoot = resolve(import.meta.dirname, "../../..");
if (!relative(repoRoot, resolve(casesDir)).startsWith("..")) {
	console.error("Keep evaluation cases outside the repository.");
	process.exit(2);
}

const only = values.cases ? new Set(values.cases.split(",")) : undefined;
const cases = readdirSync(casesDir)
	.filter((name) => (!only || only.has(name)) && statSync(join(casesDir, name)).isDirectory())
	.toSorted()
	.map((name) => loadCase(join(casesDir, name), name));
const models = values.models
	.split(",")
	.map((model) => model.trim())
	.filter(Boolean);
const addendum = values.addendum ? readFileSync(values.addendum, "utf8") : undefined;
const outDir =
	values.out ?? join(casesDir, "..", "results", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const model of models) {
	const reviewer = gatewayReviewModel(process.env, model);
	for (const testCase of cases) {
		const started = Date.now();
		let response: PluginReviewResponse | undefined;
		let error: string | undefined;
		try {
			// oxlint-disable-next-line no-await-in-loop -- one review at a time keeps gateway usage predictable
			response = await runReview(
				{
					model,
					subject: { uri: `eval:${testCase.name}`, cid: "eval", version: "0.0.0" },
					listing: testCase.listing,
					declaredAccess: testCase.declaredAccess,
					files: testCase.files,
				},
				reviewer,
				{ ...(addendum ? { addendum } : {}), signal: AbortSignal.timeout(TIMEOUT_MS) },
			);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		const found = new Set<string>(response?.findings.map((finding) => finding.category) ?? []);
		const passed =
			response !== undefined &&
			(testCase.expect.length === 0
				? found.size === 0
				: testCase.expect.every((category) => found.has(category)));
		if (!passed) failures += 1;
		const seconds = Math.round((Date.now() - started) / 1000);
		console.log(
			`${passed ? "pass" : "FAIL"}\t${model}\t${testCase.name}\t${seconds}s\t${
				error ?? ([...found].join(",") || "no findings")
			}`,
		);
		writeFileSync(
			join(outDir, `${testCase.name}.${model.replaceAll("/", "_")}.json`),
			`${JSON.stringify({ model, case: testCase.name, expect: testCase.expect, passed, seconds, error, response }, null, 2)}\n`,
		);
	}
}
console.log(`${failures} failing of ${models.length * cases.length}. Results in ${outDir}`);
process.exitCode = failures > 0 ? 1 : 0;

function loadCase(dir: string, name: string): EvalCase {
	const config: unknown = JSON.parse(readFileSync(join(dir, "case.json"), "utf8"));
	if (!isRecord(config)) throw new Error(`${name}/case.json must be an object`);
	const { expect, listing, declaredAccess } = config;
	const bundleDir = join(dir, "bundle");
	return {
		name,
		expect: Array.isArray(expect) ? expect.map(String) : [],
		listing: Array.isArray(listing)
			? listing.flatMap((item) =>
					isRecord(item) && typeof item["ref"] === "string" && typeof item["text"] === "string"
						? [{ ref: item["ref"], text: item["text"] }]
						: [],
				)
			: [],
		declaredAccess: isRecord(declaredAccess) ? declaredAccess : {},
		files: readBundle(bundleDir, bundleDir),
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readBundle(root: string, dir: string): ReviewFile[] {
	return readdirSync(dir).flatMap((entry) => {
		const path = join(dir, entry);
		if (statSync(path).isDirectory()) return readBundle(root, path);
		const bytes = readFileSync(path);
		let text: string | undefined;
		try {
			text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: false }).decode(bytes);
		} catch {
			text = undefined;
		}
		return [
			{
				path: relative(root, path),
				byteLength: bytes.byteLength,
				...(text === undefined ? {} : { text }),
			},
		];
	});
}
