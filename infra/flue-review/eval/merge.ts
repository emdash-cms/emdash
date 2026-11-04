// Offline merge eval: merges each pair of Opus and Sol issue+framing results
// (same PR and run label) with several merge models, plus the deterministic
// fallback, and records the outcome, latency and token cost of each merge.
// Usage: node --import ./eval/ts-resolve.mjs eval/merge.ts --gateway-env <file>

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs, parseEnv } from "node:util";

import * as v from "valibot";

import { fallbackMerge, mergeReviews, type ReviewerResult } from "../.flue/lib/review-merge.js";
import { reviewResultSchema } from "../.flue/lib/review-schema.js";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const RESULTS_DIR = join(EVAL_DIR, "results");
const OUT_DIR = join(RESULTS_DIR, "merge");

const BOT_PRS = [4226, 4225, 4224, 4221, 4201];
const HUMAN_PRS = [4208, 4128, 4167, 4150, 4203, 4186, 4172, 4157];
const PAIRS = [
	...BOT_PRS.flatMap((pr) => ["v1", "v2", "v3"].map((label) => ({ pr, label }))),
	...HUMAN_PRS.map((pr) => ({ pr, label: "v1" })),
];

interface Merger {
	readonly key: string;
	readonly model: string;
	readonly protocol: "anthropic" | "openai";
	// USD per million tokens: input, output, cache read.
	readonly price: readonly [number, number, number];
}

const MERGERS: readonly Merger[] = [
	{ key: "haiku", model: "claude-haiku-5-5", protocol: "anthropic", price: [0.1, 0.5, 0.01] },
	{ key: "sonnet", model: "claude-sonnet-5-5", protocol: "anthropic", price: [2, 10, 0.2] },
	{ key: "luna", model: "gpt-5.6-luna", protocol: "openai", price: [0.2, 1.2, 0.02] },
];

const { values: args } = parseArgs({
	options: {
		"gateway-env": { type: "string" },
		mergers: { type: "string", default: MERGERS.map((m) => m.key).join(",") },
		concurrency: { type: "string", default: "4" },
		force: { type: "boolean", default: false },
	},
});

const gatewaySource: Record<string, string | undefined> = args["gateway-env"]
	? parseEnv(readFileSync(args["gateway-env"], "utf8"))
	: process.env;
const {
	AI_GATEWAY_ACCOUNT_ID: account,
	AI_GATEWAY_NAME: gateway,
	AI_GATEWAY_TOKEN: token,
} = gatewaySource;

const resultFileSchema = v.looseObject({
	status: v.string(),
	result: v.optional(reviewResultSchema),
});

function loadPair(pr: number, label: string): ReviewerResult[] | undefined {
	const pair: ReviewerResult[] = [];
	for (const reviewer of ["opus", "sol"]) {
		const path = join(RESULTS_DIR, `${pr}-${reviewer}-issue+framing-${label}.json`);
		if (!existsSync(path)) return undefined;
		const file = v.parse(resultFileSchema, JSON.parse(readFileSync(path, "utf8")));
		if (file.status !== "completed" || !file.result) return undefined;
		pair.push({ reviewer, result: file.result });
	}
	return pair;
}

function parseJsonObject(text: string): unknown {
	const start = text.indexOf("{");
	const end = text.lastIndexOf("}");
	if (start === -1 || end <= start) throw new Error("merge reply contained no JSON object");
	return JSON.parse(text.slice(start, end + 1));
}

interface CallUsage {
	input: number;
	output: number;
	cacheRead: number;
	reasoning: number;
}

const anthropicReplySchema = v.looseObject({
	content: v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
	usage: v.looseObject({
		input_tokens: v.number(),
		output_tokens: v.number(),
		cache_read_input_tokens: v.optional(v.nullable(v.number())),
	}),
});

const openaiReplySchema = v.looseObject({
	output: v.array(
		v.looseObject({
			type: v.string(),
			content: v.optional(
				v.array(v.looseObject({ type: v.string(), text: v.optional(v.string()) })),
			),
		}),
	),
	usage: v.looseObject({
		input_tokens: v.number(),
		output_tokens: v.number(),
		input_tokens_details: v.optional(v.looseObject({ cached_tokens: v.optional(v.number()) })),
		output_tokens_details: v.optional(v.looseObject({ reasoning_tokens: v.optional(v.number()) })),
	}),
});

async function callModel(
	merger: Merger,
	prompt: string,
): Promise<{ text: string; usage: CallUsage }> {
	if (!account || !gateway || !token) throw new Error("AI Gateway settings are missing");
	const base = `https://gateway.ai.cloudflare.com/v1/${account}/${gateway}`;
	const headers = {
		"content-type": "application/json",
		"cf-aig-authorization": `Bearer ${token}`,
		"cf-aig-skip-cache": "true",
	};
	if (merger.protocol === "anthropic") {
		const res = await fetch(`${base}/anthropic/v1/messages`, {
			method: "POST",
			headers: { ...headers, "x-api-key": token, "anthropic-version": "2023-06-01" },
			body: JSON.stringify({
				model: merger.model,
				max_tokens: 16_000,
				// Match the production merge request, which the registered model sends with adaptive thinking.
				thinking: { type: "adaptive" },
				output_config: { effort: "low" },
				messages: [{ role: "user", content: prompt }],
			}),
			signal: AbortSignal.timeout(300_000),
		});
		if (!res.ok) throw new Error(`${merger.model} returned ${res.status}`);
		const reply = v.parse(anthropicReplySchema, await res.json());
		return {
			text: reply.content
				.map((block) => (block.type === "text" ? (block.text ?? "") : ""))
				.join(""),
			usage: {
				input: reply.usage.input_tokens,
				output: reply.usage.output_tokens,
				cacheRead: reply.usage.cache_read_input_tokens ?? 0,
				reasoning: 0,
			},
		};
	}
	const res = await fetch(`${base}/openai/responses`, {
		method: "POST",
		headers: { ...headers, authorization: `Bearer ${token}` },
		body: JSON.stringify({
			model: merger.model,
			input: prompt,
			reasoning: { effort: "low" },
			max_output_tokens: 16_000,
		}),
		signal: AbortSignal.timeout(300_000),
	});
	if (!res.ok) throw new Error(`${merger.model} returned ${res.status}`);
	const reply = v.parse(openaiReplySchema, await res.json());
	const cached = reply.usage.input_tokens_details?.cached_tokens ?? 0;
	return {
		text: reply.output
			.flatMap((item) => item.content ?? [])
			.map((part) => (part.type === "output_text" ? (part.text ?? "") : ""))
			.join(""),
		usage: {
			input: reply.usage.input_tokens - cached,
			output: reply.usage.output_tokens,
			cacheRead: cached,
			reasoning: reply.usage.output_tokens_details?.reasoning_tokens ?? 0,
		},
	};
}

async function runMerge(merger: Merger, pr: number, label: string, pair: ReviewerResult[]) {
	const out = join(OUT_DIR, `${pr}-${label}-${merger.key}.json`);
	if (!args.force && existsSync(out)) return;
	let usage: CallUsage = { input: 0, output: 0, cacheRead: 0, reasoning: 0 };
	let reply = "";
	const started = Date.now();
	const outcome = await mergeReviews(pair, async (prompt) => {
		const call = await callModel(merger, prompt);
		usage = call.usage;
		reply = call.text;
		return parseJsonObject(call.text);
	});
	const latencyMs = Date.now() - started;
	const [input, output, cacheRead] = merger.price;
	const costUsd = (usage.input * input + usage.output * output + usage.cacheRead * cacheRead) / 1e6;
	mkdirSync(OUT_DIR, { recursive: true });
	writeFileSync(
		out,
		`${JSON.stringify({ pr, label, merger: merger.key, model: merger.model, latencyMs, usage, costUsd, outcome, reply: outcome.source === "fallback" ? reply : undefined }, null, "\t")}\n`,
	);
	console.log(
		`${pr} ${label} ${merger.key}: ${outcome.source} in ${Math.round(latencyMs / 1000)}s, $${costUsd.toFixed(4)}, ${outcome.result.findings.length} findings, ${outcome.uncoveredInputs.length} uncovered, ${outcome.repairedAnchors} repaired, ${outcome.droppedAnchors} dropped`,
	);
}

async function main(): Promise<void> {
	mkdirSync(OUT_DIR, { recursive: true });
	const mergers = (args.mergers ?? "").split(",").map((key) => {
		const merger = MERGERS.find((m) => m.key === key);
		if (!merger) throw new Error(`unknown merger ${key}`);
		return merger;
	});
	const jobs: (() => Promise<void>)[] = [];
	for (const { pr, label } of PAIRS) {
		const pair = loadPair(pr, label);
		if (!pair) {
			console.log(`${pr} ${label}: missing a completed review; skipped`);
			continue;
		}
		writeFileSync(
			join(OUT_DIR, `${pr}-${label}-fallback.json`),
			`${JSON.stringify({ pr, label, merger: "fallback", result: fallbackMerge(pair) }, null, "\t")}\n`,
		);
		for (const merger of mergers) jobs.push(() => runMerge(merger, pr, label, pair));
	}
	const worker = async () => {
		for (let job = jobs.shift(); job; job = jobs.shift()) {
			try {
				await job();
			} catch (error) {
				console.log(`merge job failed: ${String(error)}`);
			}
		}
	};
	await Promise.all(Array.from({ length: Number(args.concurrency) }, worker));
}

await main();
