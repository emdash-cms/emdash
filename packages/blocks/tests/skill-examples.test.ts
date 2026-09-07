// @vitest-environment node

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { validateBlocks } from "../src/validation.js";

const REFERENCE_PATH = fileURLToPath(
	new URL("../../../skills/creating-plugins/references/block-kit.md", import.meta.url),
);

type Example = {
	name: string;
	section: string;
	source: string;
};

const TO_BLOCKS: Record<string, (example: unknown) => unknown[]> = {
	"Block Syntax": (example) => [example],
	"Conditional Fields": (example) => [
		{
			type: "form",
			block_id: "example",
			fields: [example],
			submit: { label: "Save", action_id: "save" },
		},
	],
	"Button Confirmations": (example) => [{ type: "actions", elements: [example] }],
};

function extractJsonExamples(markdown: string): Example[] {
	const examples: Example[] = [];
	const lines = markdown.split("\n");

	let section = "";
	let heading = "";
	let fence: string[] | null = null;
	let fenceLine = 0;

	for (const [index, line] of lines.entries()) {
		if (fence) {
			if (line.startsWith("```")) {
				examples.push({
					name: `${heading} (line ${fenceLine})`,
					section,
					source: fence.join("\n"),
				});
				fence = null;
			} else {
				fence.push(line);
			}
			continue;
		}

		if (line.startsWith("## ")) {
			section = line.slice(3).trim();
			heading = section;
		} else if (line.startsWith("### ")) {
			heading = line.slice(4).trim();
		} else if (line.trim() === "```json") {
			fence = [];
			fenceLine = index + 2;
		}
	}

	return examples;
}

const examples = extractJsonExamples(readFileSync(REFERENCE_PATH, "utf8"));

describe("block kit reference examples", () => {
	it("finds JSON examples in the reference", () => {
		expect(examples.length).toBeGreaterThan(0);
	});

	it.each(examples.map((example) => [example.name, example] as const))("%s", (_name, example) => {
		const toBlocks = TO_BLOCKS[example.section];
		if (!toBlocks) {
			throw new Error(
				`Section "${example.section}" holds a JSON example but has no entry in TO_BLOCKS`,
			);
		}

		expect(validateBlocks(toBlocks(JSON.parse(example.source)))).toEqual({
			valid: true,
			errors: [],
		});
	});
});
