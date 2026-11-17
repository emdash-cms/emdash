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
import { gatewayReviewModel, REASONING_LEVELS, type ReasoningLevel } from "../src/models.js";
import type { PluginReviewRequest, PluginReviewResponse, ReviewFile } from "../src/types.js";

const DEFAULT_MODELS = "workers-ai/@cf/thinkingmachines/inkling-2-small,openai/gpt-6.1-sol";
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
		prices: { type: "string" },
		reasoning: { type: "string" },
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
const prices = values.prices ? loadPrices(values.prices) : {};
const reasoning = values.reasoning;
if (reasoning !== undefined && !isReasoningLevel(reasoning)) {
	console.error(`--reasoning must be one of ${REASONING_LEVELS.join(", ")}.`);
	process.exit(2);
}
const outDir =
	values.out ?? join(casesDir, "..", "results", new Date().toISOString().replaceAll(":", "-"));
mkdirSync(outDir, { recursive: true });

let failures = 0;
for (const model of models) {
	const reviewer = gatewayReviewModel(process.env, model, reasoning ? { reasoning } : {});
	const modelTotal = emptyUsage();
	let modelSeconds = 0;
	for (const testCase of cases) {
		const started = Date.now();
		const usage = emptyUsage();
		let response: PluginReviewResponse | undefined;
		let error: string | undefined;
		try {
			// oxlint-disable-next-line no-await-in-loop -- one review at a time keeps gateway usage predictable
			response = await runReview(
				{
					model,
					subject: releaseSubject(testCase),
					listing: testCase.listing,
					declaredAccess: testCase.declaredAccess,
					files: testCase.files,
				},
				reviewer,
				{
					...(addendum ? { addendum } : {}),
					signal: AbortSignal.timeout(TIMEOUT_MS),
					onMessage: (message) => addUsage(usage, message.usage),
				},
			);
		} catch (caught) {
			error = caught instanceof Error ? caught.message : String(caught);
		}
		const found = new Set<string>(response?.findings.map((finding) => finding.category) ?? []);
		const passed =
			response !== undefined &&
			!response.declined &&
			(testCase.expect.length === 0
				? found.size === 0
				: testCase.expect.every((expected) =>
						expected.split("|").some((category) => found.has(category)),
					));
		if (!passed) failures += 1;
		const seconds = Math.round((Date.now() - started) / 1000);
		const cost = costOf(prices[model], usage);
		addUsage(modelTotal, usage);
		modelSeconds += seconds;
		console.log(
			`${passed ? "pass" : "FAIL"}\t${model}\t${testCase.name}\t${seconds}s\t${formatUsage(usage, cost)}\t${
				error ??
				(response?.declined
					? `declined: ${response.summary}`
					: [...found].join(",") || "no findings")
			}`,
		);
		writeFileSync(
			join(outDir, `${testCase.name}.${model.replaceAll("/", "_")}.json`),
			`${JSON.stringify({ model, case: testCase.name, expect: testCase.expect, passed, seconds, usage, cost, error, response }, null, 2)}\n`,
		);
	}
	console.log(
		`total\t${model}\t${cases.length} cases\t${modelSeconds}s\t${formatUsage(modelTotal, costOf(prices[model], modelTotal))}`,
	);
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

interface Usage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	turns: number;
}

/** US dollars per million tokens. Cache prices default to the input price. */
interface Price {
	input: number;
	output: number;
	cacheRead?: number;
	cacheWrite?: number;
}

function emptyUsage(): Usage {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, turns: 0 };
}

function addUsage(total: Usage, add: Omit<Usage, "turns"> & { turns?: number }): void {
	total.input += add.input;
	total.output += add.output;
	total.cacheRead += add.cacheRead;
	total.cacheWrite += add.cacheWrite;
	total.turns += add.turns ?? 1;
}

function costOf(price: Price | undefined, usage: Usage): number | undefined {
	if (!price) return undefined;
	const microdollars =
		usage.input * price.input +
		usage.output * price.output +
		usage.cacheRead * (price.cacheRead ?? price.input) +
		usage.cacheWrite * (price.cacheWrite ?? price.input);
	return Math.round(microdollars) / 1_000_000;
}

function formatUsage(usage: Usage, cost: number | undefined): string {
	const input = usage.input + usage.cacheRead + usage.cacheWrite;
	const tokens = `${usage.turns} turns, ${input} in, ${usage.output} out`;
	return cost === undefined ? tokens : `${tokens}, $${cost.toFixed(4)}`;
}

function loadPrices(path: string): Record<string, Price> {
	const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
	if (!isRecord(parsed)) throw new Error("--prices must be a JSON object keyed by model");
	const loaded: Record<string, Price> = {};
	for (const [model, value] of Object.entries(parsed)) {
		if (
			!isRecord(value) ||
			typeof value["input"] !== "number" ||
			typeof value["output"] !== "number"
		) {
			throw new Error(`--prices entry for ${model} needs numeric input and output prices`);
		}
		loaded[model] = {
			input: value["input"],
			output: value["output"],
			...(typeof value["cacheRead"] === "number" ? { cacheRead: value["cacheRead"] } : {}),
			...(typeof value["cacheWrite"] === "number" ? { cacheWrite: value["cacheWrite"] } : {}),
		};
	}
	return loaded;
}

// The subject URI is shown to the reviewer, so it is built from the listing
// rather than the case name, which would give the expected answer away.
function releaseSubject(testCase: EvalCase): PluginReviewRequest["subject"] {
	const text = (ref: string) => testCase.listing.find((item) => item.ref === ref)?.text;
	const slug = text("release.packageSlug") ?? "plugin";
	const version = text("release.version") ?? "1.0.0";
	return {
		uri: `at://did:plc:7kq3xv2m5n4p6r8t2w9yzabc/com.emdashcms.experimental.package.release/${slug}:${version}`,
		cid: "bafyreievalcaseplaceholdercid",
		version,
	};
}

function isReasoningLevel(value: string): value is ReasoningLevel {
	return REASONING_LEVELS.some((level) => level === value);
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
