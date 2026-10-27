// Prints markdown tables for RESULTS.md from cases.json, grades.json and the
// raw results. Usage: node eval/summarize.ts [variant] [models] [cases]

import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

const EVAL_DIR = dirname(fileURLToPath(import.meta.url));
const [variant = "baseline", modelArg = "kimi,opus,sol", caseArg] = process.argv.slice(2);
const models = modelArg.split(",");

const cases = v
	.parse(
		v.object({
			cases: v.array(
				v.looseObject({
					pr: v.number(),
					origin: v.string(),
					expectedVerdict: v.picklist(["approve", "not_approve", "any"]),
					key: v.array(v.looseObject({ id: v.string(), severity: v.string() })),
				}),
			),
		}),
		JSON.parse(readFileSync(join(EVAL_DIR, "cases.json"), "utf8")),
	)
	.cases.filter((c) => !caseArg || caseArg.split(",").map(Number).includes(c.pr));

const gradeSchema = v.object({
	scores: v.record(v.string(), v.number()),
	falseClaims: v.array(v.string()),
	note: v.string(),
});
const grades = v.parse(
	v.record(v.string(), v.record(v.string(), v.record(v.string(), gradeSchema))),
	JSON.parse(readFileSync(join(EVAL_DIR, "grades.json"), "utf8")),
)[variant];
if (!grades) throw new Error(`no grades for variant ${variant}`);

const resultSchema = v.looseObject({
	status: v.string(),
	wallMs: v.number(),
	durationMs: v.optional(v.number()),
	costUsd: v.number(),
	usage: v.object({
		input: v.number(),
		output: v.number(),
		cacheRead: v.number(),
		cacheWrite: v.number(),
		turns: v.number(),
		toolCalls: v.number(),
	}),
	result: v.optional(v.looseObject({ verdict: v.string() })),
});

function result(pr: number, model: string) {
	const suffix = variant === "baseline" ? "" : `-${variant}`;
	const path = join(EVAL_DIR, "results", `${pr}-${model}${suffix}.json`);
	if (!existsSync(path)) return undefined;
	return v.parse(resultSchema, JSON.parse(readFileSync(path, "utf8")));
}

function verdictCorrect(expected: string, verdict: string | undefined): boolean | undefined {
	if (!verdict || expected === "any") return undefined;
	return expected === "approve" ? verdict === "approve" : verdict !== "approve";
}

const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));

console.log(`| PR | Key items | ${models.map((m) => `${m} score | ${m} verdict`).join(" | ")} |`);
console.log(`| --- | --- | ${models.map(() => "--- | ---").join(" | ")} |`);
for (const c of cases) {
	const cells = models.map((m) => {
		const r = result(c.pr, m);
		const g = grades[String(c.pr)]?.[m];
		if (!r || r.status !== "completed" || !g) return "not run | –";
		const score = Object.values(g.scores).reduce((a, b) => a + b, 0);
		const items = c.key.length ? `${fmt(score)}/${c.key.length}` : "clean";
		const ok = verdictCorrect(c.expectedVerdict, r.result?.verdict);
		const mark = ok === undefined ? "" : ok ? " ✓" : " ✗";
		const falses = g.falseClaims.length ? `, ${g.falseClaims.length} false` : "";
		return `${items}${falses} | ${r.result?.verdict}${mark}`;
	});
	const keys = c.key.length ? c.key.map((k) => k.id).join(", ") : "clean";
	console.log(`| ${c.pr} | ${keys} | ${cells.join(" | ")} |`);
}

console.log("");
console.log(
	"| Model | Runs | Key score | Bot PRs | Human PRs | False claims | Verdicts right | Mean time | Mean tool calls | Mean tokens | Mean cost | Total cost |",
);
console.log("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
for (const m of models) {
	let runs = 0;
	let score = 0;
	let possible = 0;
	let bot = 0;
	let botPossible = 0;
	let human = 0;
	let humanPossible = 0;
	let falses = 0;
	let right = 0;
	let decisive = 0;
	let seconds = 0;
	let tools = 0;
	let tokens = 0;
	let costTotal = 0;
	for (const c of cases) {
		const r = result(c.pr, m);
		const g = grades[String(c.pr)]?.[m];
		if (!r || r.status !== "completed" || !g) continue;
		runs++;
		const s = Object.values(g.scores).reduce((a, b) => a + b, 0);
		score += s;
		possible += c.key.length;
		if (c.origin === "bot") {
			bot += s;
			botPossible += c.key.length;
		} else {
			human += s;
			humanPossible += c.key.length;
		}
		falses += g.falseClaims.length;
		const ok = verdictCorrect(c.expectedVerdict, r.result?.verdict);
		if (ok !== undefined) {
			decisive++;
			if (ok) right++;
		}
		seconds += (r.durationMs ?? r.wallMs) / 1_000;
		tools += r.usage.toolCalls;
		tokens += r.usage.input + r.usage.output + r.usage.cacheRead + r.usage.cacheWrite;
		costTotal += r.costUsd;
	}
	if (runs === 0) continue;
	console.log(
		`| ${m} | ${runs} | ${fmt(score)}/${possible} | ${fmt(bot)}/${botPossible} | ${fmt(human)}/${humanPossible} | ${falses} | ${right}/${decisive} | ${Math.round(seconds / runs / 6) / 10} min | ${Math.round(tools / runs)} | ${(tokens / runs / 1e6).toFixed(2)}M | $${(costTotal / runs).toFixed(2)} | $${costTotal.toFixed(2)} |`,
	);
}
