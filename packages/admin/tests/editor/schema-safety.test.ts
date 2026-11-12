/**
 * Concurrent edits never make y-tiptap delete rich text. y-tiptap deletes a
 * merged node the schema rejects, with everything in it, so three editors
 * with the shipped schema make random edits from fixed seeds and check that no
 * replica deletes content for a schema reason, that the replicas converge,
 * that ProseMirror matches Y on each, that tables stay under a size cap, and
 * that no normalizer writes while rendering another client's change.
 *
 * By default it runs 1,000 seeds of 100 edits, which still catches a list item
 * that must start with a paragraph. The acceptance gate is 10,000 runs of 200
 * edits. Run it, or one shard of it from SEED_START:
 *
 *   RUNS=10000 EDITS=200 SEED_START=1 pnpm --filter @emdash-cms/admin exec vitest run tests/editor/schema-safety.test.ts
 */

import { Editor } from "@tiptap/core";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import * as Y from "yjs";

import { portableTextExtensions } from "../../src/internal/portable-text.js";
import {
	COMMANDS,
	addToSummary,
	emptySummary,
	generateScript,
	installDetectors,
	minimize,
	runSeed,
	type RunReport,
} from "./schema-safety-harness.js";

const RUNS = Number(import.meta.env.RUNS || 1000);
const EDITS = Number(import.meta.env.EDITS || 100);
const SEED_START = Number(import.meta.env.SEED_START || 1);
const CHUNK = 50;
const CHUNK_TIMEOUT = CHUNK * EDITS * 20 + 300_000;

const summary = emptySummary();
let started = 0;
let minimized = false;
let uninstall: (() => void) | null = null;

beforeAll(() => {
	uninstall = installDetectors();
	started = performance.now();
});

afterAll(() => {
	uninstall?.();
	const seconds = Math.round((performance.now() - started) / 100) / 10;
	const { errorStacks, ...totals } = summary;
	console.log(
		`schema-safety ${JSON.stringify({ seedStart: SEED_START, edits: EDITS, seconds, ...totals, ...(summary.runsFailed > 0 && { errorStacks }) })}`,
	);
});

const yieldToBrowser = () => new Promise((resolve) => setTimeout(resolve));

function describeFailure(seed: number, run: RunReport): string {
	return [
		`seed ${seed} (RUNS=1 EDITS=${EDITS} SEED_START=${seed}):`,
		...run.failures.map((failure) => `  ${failure.message}`),
	].join("\n");
}

function minimizedRepro(seed: number, run: RunReport): string {
	const target = run.failures[0]!.kind;
	const { events, edits } = minimize(generateScript(seed, EDITS), (candidate) =>
		candidate.failures.some((failure) => failure.kind === target),
	);
	return [
		`  minimized to ${edits.length} edits that still fail with "${target}":`,
		...edits.map((edit) => `    event ${edit.event}: client ${edit.client} ${edit.op}`),
		`  events: ${JSON.stringify(events)}`,
	].join("\n");
}

describe("schema safety", () => {
	it("drives every editor command the edits call", () => {
		const editor = new Editor({ extensions: portableTextExtensions() });
		const missing = COMMANDS.filter((name) => !(name in editor.commands));
		editor.destroy();
		expect(missing).toEqual([]);
	});

	it("counts content y-tiptap deletes for a schema reason", () => {
		// A quote holds only paragraphs, so y-tiptap deletes one holding a heading.
		const run = runSeed(0, 0, (fragment) => {
			const quote = new Y.XmlElement("blockquote");
			const heading = new Y.XmlElement("heading");
			heading.insert(0, [new Y.XmlText("Lost")]);
			quote.insert(0, [heading]);
			fragment.insert(0, [quote]);
		});
		expect(run.nonEmptyDeletions.map((deletion) => deletion.text)).toContain("Lost");
		expect(run.failures.map((failure) => failure.kind)).toContain("schema loss");
	});

	for (let from = SEED_START; from < SEED_START + RUNS; from += CHUNK) {
		const to = Math.min(from + CHUNK, SEED_START + RUNS) - 1;
		it(
			`loses nothing in seeds ${from}-${to} of ${EDITS} edits`,
			async () => {
				const failures: string[] = [];
				for (let seed = from; seed <= to; seed++) {
					const run = runSeed(seed, EDITS);
					addToSummary(summary, seed, EDITS, run);
					if (run.failures.length > 0) {
						let description = describeFailure(seed, run);
						if (!minimized) {
							minimized = true;
							description += `\n${minimizedRepro(seed, run)}`;
						}
						failures.push(description);
					}
					await yieldToBrowser();
				}
				expect(failures).toEqual([]);
			},
			CHUNK_TIMEOUT,
		);
	}
});
