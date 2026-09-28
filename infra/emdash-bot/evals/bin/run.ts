// Operator CLI for the investigation-bot eval harness.
//
//   pnpm evals -- --case 917
//   pnpm evals -- --case 917 --case 895
//   pnpm evals -- --category not_reproducible
//   pnpm evals -- --all
//
// Requires a DEPLOYED worker and live bindings. Environment:
//   WORKER_URL    base URL of the deployed bot worker
//   ADMIN_TOKEN   bearer token for /agents/* (the worker's GITHUB_WEBHOOK_SECRET)
//   GH_TOKEN      GitHub token to read issue titles/bodies (read-only)
//   REPO          owner/name to investigate against (default emdash-cms/emdash)
//   TIMEOUT_MS    per-case verdict timeout (default 1800000)
//   POLL_MS       snapshot poll interval (default 15000)

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadDataset } from "../src/dataset.ts";
import { formatReport, toJson } from "../src/format.ts";
import { runEvals, type RunConfig, type Selection } from "../src/runner.ts";
import { summarize } from "../src/scorer.ts";
import type { Category } from "../src/types.ts";

const CATEGORY_ALIASES: Record<string, Category> = {
	confirmed_bug: "CONFIRMED_BUG",
	confirmed: "CONFIRMED_BUG",
	bug: "CONFIRMED_BUG",
	not_reproducible: "NOT_REPRODUCIBLE",
	"not-reproducible": "NOT_REPRODUCIBLE",
	not_repro: "NOT_REPRODUCIBLE",
	negative: "NOT_REPRODUCIBLE",
	needs_info: "NEEDS_INFO",
	"needs-info": "NEEDS_INFO",
};

function parseSelection(argv: readonly string[]): Selection {
	const numbers: number[] = [];
	let category: Category | undefined;
	let all = false;
	for (let i = 0; i < argv.length; i += 1) {
		const arg = argv[i];
		if (arg === "--all") {
			all = true;
		} else if (arg === "--case") {
			const value = argv[(i += 1)];
			if (!value) fail("--case needs an issue number");
			for (const part of value.split(",")) {
				const n = Number(part.trim());
				if (!Number.isInteger(n)) fail(`--case expects an integer, got "${part}"`);
				numbers.push(n);
			}
		} else if (arg === "--category") {
			const value = argv[(i += 1)];
			const resolved = value ? CATEGORY_ALIASES[value.toLowerCase()] : undefined;
			if (!resolved) fail(`--category expects one of ${Object.keys(CATEGORY_ALIASES).join(", ")}`);
			category = resolved;
		} else {
			fail(`unknown argument "${arg}"`);
		}
	}
	if (numbers.length > 0) return { kind: "cases", numbers };
	if (category) return { kind: "category", category };
	if (all) return { kind: "all" };
	fail("select cases with --case <n>, --category <c>, or --all");
}

function requireEnv(name: string): string {
	const value = process.env[name];
	if (!value) fail(`missing required env ${name}`);
	return value;
}

function fail(message: string): never {
	console.error(`error: ${message}`);
	process.exit(2);
}

async function main(): Promise<void> {
	const selection = parseSelection(process.argv.slice(2));
	const dataset = loadDataset();
	const [owner, repo] = (process.env.REPO ?? "emdash-cms/emdash").split("/");
	if (!owner || !repo) fail("REPO must be owner/name");

	const config: RunConfig = {
		baseUrl: requireEnv("WORKER_URL"),
		token: requireEnv("ADMIN_TOKEN"),
		githubToken: requireEnv("GH_TOKEN"),
		owner,
		repo,
		...(process.env.TIMEOUT_MS ? { timeoutMs: Number(process.env.TIMEOUT_MS) } : {}),
		...(process.env.POLL_MS ? { pollMs: Number(process.env.POLL_MS) } : {}),
	};

	const results = await runEvals(config, dataset, selection);
	const summary = summarize(results);

	console.log(`\n${formatReport(results, summary)}\n`);

	const dir = join(dirname(fileURLToPath(import.meta.url)), "../results");
	mkdirSync(dir, { recursive: true });
	const file = join(dir, `${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
	writeFileSync(file, `${JSON.stringify(toJson(results, summary), null, 2)}\n`);
	console.log(`results written to ${file}`);

	process.exit(summary.gatePassed ? 0 : 1);
}

await main();
