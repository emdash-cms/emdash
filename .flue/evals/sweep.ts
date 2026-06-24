// Model sweep for the command classifier. Runs the labeled dataset (shared
// with vitest-evals, see ./cases.ts) against each candidate model through one
// running `flue dev` and reports pass rate, speed, tokens, and cost (from the
// live Workers AI price sheet).
//
// Usage: with `flue dev --target node` running,
//   FLUE_BASE_URL=<url> node --experimental-strip-types evals/sweep.ts
// Override the model list:
//   MODELS=workers-ai/@cf/qwen/qwen3-30b-a3b-fp8,workers-ai/@cf/moonshotai/kimi-k2.7-code ...
// Per-call timeout cap (ms):
//   CALL_TIMEOUT_MS=45000 ...

import { createFlueClient } from "@flue/sdk";

import { CASES, commandsFor, type Case } from "./cases.ts";

const client = createFlueClient({ baseUrl: process.env.FLUE_BASE_URL ?? "http://127.0.0.1:3583" });

// $/M tokens, pulled from the Workers AI catalog (GET /ai/models/search).
const PRICING: Record<string, { in: number; out: number }> = {
	"workers-ai/@cf/zai-org/glm-4.7-flash": { in: 0.0605, out: 0.4 },
	"workers-ai/@cf/ibm-granite/granite-4.0-h-micro": { in: 0.017, out: 0.112 },
	"workers-ai/@cf/openai/gpt-oss-20b": { in: 0.2, out: 0.3 },
	"workers-ai/@cf/meta/llama-3.3-70b-instruct-fp8-fast": { in: 0.293, out: 2.253 },
	"workers-ai/@cf/qwen/qwen3-30b-a3b-fp8": { in: 0.0509, out: 0.335 },
	"workers-ai/@cf/google/gemma-4-26b-a4b-it": { in: 0.1, out: 0.3 },
	"workers-ai/@cf/mistralai/mistral-small-3.1-24b-instruct": { in: 0.351, out: 0.555 },
	"workers-ai/@cf/meta/llama-4-scout-17b-16e-instruct": { in: 0.27, out: 0.85 },
	"workers-ai/@cf/moonshotai/kimi-k2.7-code": { in: 0.95, out: 4 },
	"workers-ai/@cf/moonshotai/kimi-k2.6": { in: 0.95, out: 4 },
	"workers-ai/@cf/zai-org/glm-5.2": { in: 1.4, out: 4.4 },
	"workers-ai/@cf/nvidia/nemotron-3-120b-a12b": { in: 0.5, out: 1.5 },
	"workers-ai/@cf/openai/gpt-oss-120b": { in: 0.35, out: 0.75 },
};

const SHORTLIST = process.env.MODELS?.split(",")
	.map((s) => s.trim())
	.filter(Boolean) ?? [
	"workers-ai/@cf/qwen/qwen3-30b-a3b-fp8",
	"workers-ai/@cf/moonshotai/kimi-k2.7-code",
];

const CALL_TIMEOUT_MS = Number(process.env.CALL_TIMEOUT_MS ?? 45_000);

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
	return Promise.race([
		promise,
		new Promise<T>((_, rej) => setTimeout(() => rej(new Error(`call timeout ${ms}ms`)), ms)),
	]);
}

function fmt(n: number, d = 1): string {
	return Number.isFinite(n) ? n.toFixed(d) : "-";
}

interface CaseResult {
	case: Case;
	got: string | null;
	ok: boolean;
	error?: string;
}

interface ModelRow {
	model: string;
	pass: number;
	total: number;
	errors: number;
	/** Mean latency over SUCCESSFUL calls. Compare to avgMsWallClock for honesty. */
	avgMs: number;
	/** Mean latency over ALL cases (timeouts count as CALL_TIMEOUT_MS). */
	avgMsWallClock: number;
	avgInTok: number;
	avgOutTok: number;
	/** $ per 1k SUCCESSFUL classifications. Failed calls cost zero in the API
	 *  but burn real time/operator attention; quote both columns. */
	costPer1k: number | null;
	misses: CaseResult[];
}

async function sweepModel(bareId: string): Promise<ModelRow> {
	const model = `cf-wai/${bareId}`;
	let pass = 0;
	let errors = 0;
	let latencySuccess = 0;
	let latencyAll = 0;
	let inTok = 0;
	let outTok = 0;
	let n = 0;
	const misses: CaseResult[] = [];
	for (const c of CASES) {
		const input = {
			issueNumber: 0,
			state: c.state,
			comment: c.comment,
			commands: commandsFor(c.state),
			model,
		};
		const t0 = performance.now();
		try {
			const inv: {
				result?: { event?: string; _meta?: { tokens?: { input?: number; output?: number } } };
			} = await withTimeout(
				client.workflows.invoke("classify-command", { input, wait: "result" }) as Promise<{
					result?: { event?: string; _meta?: { tokens?: { input?: number; output?: number } } };
				}>,
				CALL_TIMEOUT_MS,
			);
			const elapsed = performance.now() - t0;
			latencySuccess += elapsed;
			latencyAll += elapsed;
			const r = inv.result ?? {};
			const got = r.event ?? null;
			if (got === c.expected) pass++;
			else misses.push({ case: c, got, ok: false });
			inTok += r._meta?.tokens?.input ?? 0;
			outTok += r._meta?.tokens?.output ?? 0;
			n++;
		} catch (err) {
			errors++;
			// Timeouts/errors count as the full CALL_TIMEOUT_MS budget for the
			// wall-clock average: a model that times out 10/43 times is not
			// "faster" than one that returns successfully in 8s every time.
			latencyAll += CALL_TIMEOUT_MS;
			misses.push({ case: c, got: null, ok: false, error: String(err).slice(0, 110) });
			if (errors === 1) console.error(`  ! ${bareId}: ${String(err).slice(0, 110)}`);
		}
	}
	const price = PRICING[bareId];
	const costPer1k = price && n ? ((inTok * price.in + outTok * price.out) / 1e6 / n) * 1000 : null;
	return {
		model: bareId.replace("workers-ai/@cf/", ""),
		pass,
		total: CASES.length,
		errors,
		avgMs: n ? latencySuccess / n : NaN,
		avgMsWallClock: latencyAll / CASES.length,
		avgInTok: n ? inTok / n : NaN,
		avgOutTok: n ? outTok / n : NaN,
		costPer1k,
		misses,
	};
}

const rows: ModelRow[] = [];
for (const id of SHORTLIST) {
	console.error(`sweeping ${id} ...`);
	const r = await sweepModel(id);
	const passPct = (r.pass / r.total) * 100;
	console.error(
		`  -> ${r.model}: ${fmt(passPct, 0)}% (${r.pass}/${r.total}), ${fmt(r.avgMs, 0)}ms (wall ${fmt(r.avgMsWallClock, 0)}ms), ${fmt(r.avgInTok, 0)}/${fmt(r.avgOutTok, 0)} tok, ${r.costPer1k == null ? "-" : "$" + fmt(r.costPer1k, 3) + "/1k"}, ${r.errors} err`,
	);
	rows.push(r);
}

// Sort by accuracy first, then wall-clock latency: a model that fails fast
// loses to one that succeeds slowly.
rows.sort((a, b) => b.pass / b.total - a.pass / a.total || a.avgMsWallClock - b.avgMsWallClock);

console.log(
	"\n" +
		"model".padEnd(34) +
		"pass".padEnd(12) +
		"err".padEnd(5) +
		"ok ms".padEnd(8) +
		"wall ms".padEnd(9) +
		"in/out tok".padEnd(14) +
		"$/1k (ok only)",
);
console.log("-".repeat(95));
for (const r of rows) {
	const pct = (r.pass / r.total) * 100;
	console.log(
		r.model.padEnd(34) +
			`${fmt(pct, 0)}% (${r.pass}/${r.total})`.padEnd(12) +
			String(r.errors).padEnd(5) +
			fmt(r.avgMs, 0).padEnd(8) +
			fmt(r.avgMsWallClock, 0).padEnd(9) +
			`${fmt(r.avgInTok, 0)}/${fmt(r.avgOutTok, 0)}`.padEnd(14) +
			(r.costPer1k == null ? "-" : `$${fmt(r.costPer1k, 3)}`),
	);
}

// Per-miss detail, grouped by model + tag, for fast pattern spotting.
for (const r of rows) {
	if (!r.misses.length) continue;
	console.log(`\n--- misses: ${r.model} ---`);
	const byTag = new Map<string, CaseResult[]>();
	for (const m of r.misses) {
		const arr = byTag.get(m.case.tag) ?? [];
		arr.push(m);
		byTag.set(m.case.tag, arr);
	}
	for (const [tag, ms] of byTag) {
		console.log(`  [${tag}]`);
		for (const m of ms) {
			const detail = m.error
				? `error: ${m.error}`
				: `expected ${m.case.expected}, got ${m.got ?? "-"}`;
			console.log(`    ${m.case.state}: "${m.case.comment.slice(0, 60)}" -> ${detail}`);
		}
	}
}
