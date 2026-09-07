// Dataset loading + pre-fix ref resolution.
//
// Pure functions (`parseDataset`, `resolvePreFixRef`, `checkoutRefFor`) are
// unit-tested with literal fixtures -- no disk, no live GitHub. `loadDataset`
// reads the committed `dataset.json` for the operator CLI.

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import * as v from "valibot";

import type { Category, Dataset, EvalCase, PreFix } from "./types.ts";

const CATEGORIES = ["CONFIRMED_BUG", "NOT_REPRODUCIBLE", "NEEDS_INFO"] as const;
const COMMIT_SHA = /^[0-9a-f]{40}$/i;

const preFixSchema = v.object({
	merge_commit: v.pipe(v.string(), v.regex(COMMIT_SHA)),
	parents: v.pipe(v.array(v.pipe(v.string(), v.regex(COMMIT_SHA))), v.minLength(1)),
	note: v.optional(v.string()),
});

const caseSchema = v.object({
	number: v.number(),
	title: v.pipe(v.string(), v.minLength(1)),
	category: v.picklist(CATEGORIES),
	ground_truth: v.pipe(v.string(), v.minLength(1)),
	fixing_pr: v.nullable(v.number()),
	difficulty: v.picklist(["easy", "medium", "hard"]),
	repro_path: v.string(),
	area: v.string(),
	pre_fix: v.nullable(preFixSchema),
	fault_anchors: v.array(v.string()),
});

const datasetSchema = v.object({
	counts: v.record(v.string(), v.number()),
	cases: v.pipe(v.array(caseSchema), v.minLength(1)),
});

/**
 * Validate a raw object into a typed `Dataset`, enforcing the cross-field
 * invariants the harness relies on: a fixed confirmed bug always carries a
 * pre-fix commit; an unfixed one (`fixing_pr: null`) checks out `main`, where
 * the bug is still present. Every confirmed bug carries at least one fault
 * anchor; a negative case never carries a pre-fix. A malformed dataset throws
 * here rather than mis-scoring later.
 */
export function parseDataset(raw: unknown): Dataset {
	const parsed = v.parse(datasetSchema, raw);
	for (const c of parsed.cases) {
		if (c.category === "CONFIRMED_BUG") {
			if (!c.pre_fix && c.fixing_pr !== null)
				throw new Error(`case #${c.number}: CONFIRMED_BUG without pre_fix`);
			if (c.fault_anchors.length === 0)
				throw new Error(`case #${c.number}: CONFIRMED_BUG without fault_anchors`);
		} else if (c.pre_fix) {
			throw new Error(`case #${c.number}: ${c.category} must not carry pre_fix`);
		}
	}
	return parsed;
}

/** The pre-fix commit to check out: the first parent of the fixing merge commit. */
export function resolvePreFixRef(preFix: PreFix): string {
	const parent = preFix.parents[0];
	if (parent === undefined) throw new Error("pre_fix.parents is empty");
	return parent;
}

/**
 * The ref the investigation should stand up at. Fixed confirmed bugs check out
 * the pre-fix commit so the bug is present; unfixed confirmed bugs and
 * negatives check out `main` -- the bug is still live there, or (for
 * negatives) a correct investigation should fail to reproduce / ask for info.
 */
export function checkoutRefFor(evalCase: EvalCase): string {
	if (evalCase.category === "CONFIRMED_BUG" && evalCase.pre_fix) {
		return resolvePreFixRef(evalCase.pre_fix);
	}
	return "main";
}

export function filterByCategory(dataset: Dataset, category: Category): EvalCase[] {
	return dataset.cases.filter((c) => c.category === category);
}

export function findCase(dataset: Dataset, number: number): EvalCase | undefined {
	return dataset.cases.find((c) => c.number === number);
}

const DATASET_PATH = join(dirname(fileURLToPath(import.meta.url)), "../dataset.json");

/** Read and validate the committed dataset. */
export function loadDataset(path: string = DATASET_PATH): Dataset {
	return parseDataset(JSON.parse(readFileSync(path, "utf8")));
}
