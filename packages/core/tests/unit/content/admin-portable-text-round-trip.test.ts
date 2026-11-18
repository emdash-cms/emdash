import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
	portableTextSchema,
	portableTextToProsemirror,
	type PortableTextBlock,
} from "@emdash-cms/admin/internal/portable-text";
import { describe, expect, it } from "vitest";

import {
	editorFixtures,
	roundTripThroughConverter,
	roundTripThroughSharedDocument,
} from "../../utils/admin-portable-text-round-trip.js";

const TEMPLATES_DIR = fileURLToPath(new URL("../../../../../templates/", import.meta.url));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** An array of Portable Text blocks that holds at least one text block. */
function isPortableText(value: unknown): value is PortableTextBlock[] {
	return (
		Array.isArray(value) &&
		value.length > 0 &&
		value.every((block) => isRecord(block) && typeof block._type === "string") &&
		value.some((block) => block._type === "block" && Array.isArray(block.children))
	);
}

function collectPortableText(
	value: unknown,
	path: string,
	found: Array<{ path: string; blocks: PortableTextBlock[] }>,
): void {
	if (isPortableText(value)) {
		found.push({ path, blocks: value });
		return;
	}
	if (Array.isArray(value)) {
		value.forEach((item, index) => collectPortableText(item, `${path}[${index}]`, found));
	} else if (isRecord(value)) {
		for (const [key, item] of Object.entries(value))
			collectPortableText(item, `${path}.${key}`, found);
	}
}

const seedValues = readdirSync(TEMPLATES_DIR, { withFileTypes: true })
	.filter((entry) => entry.isDirectory())
	.flatMap((entry) => {
		const file = join(TEMPLATES_DIR, entry.name, "seed", "seed.json");
		let seed: unknown;
		try {
			seed = JSON.parse(readFileSync(file, "utf8"));
		} catch {
			return [];
		}
		const found: Array<{ path: string; blocks: PortableTextBlock[] }> = [];
		collectPortableText(seed, entry.name, found);
		return found;
	});

describe("admin Portable Text through a shared document", () => {
	it.each(editorFixtures)("keeps $name unchanged", ({ blocks, pluginTypes }) => {
		expect(roundTripThroughSharedDocument(blocks, pluginTypes)).toEqual(blocks);
	});

	it.each(editorFixtures)(
		"keeps $name unchanged through the converter alone",
		({ blocks, pluginTypes }) => {
			expect(roundTripThroughConverter(blocks, pluginTypes)).toEqual(blocks);
		},
	);

	it("has a fixture for every node and mark", () => {
		const used = new Set<string>();
		const visit = (node: { type: string; content?: unknown[]; marks?: unknown[] }) => {
			used.add(node.type);
			for (const mark of node.marks ?? []) used.add((mark as { type: string }).type);
			for (const child of node.content ?? []) visit(child as typeof node);
		};
		for (const { blocks, pluginTypes } of editorFixtures) {
			visit(portableTextToProsemirror(blocks, pluginTypes));
		}
		const schema = portableTextSchema();
		const names = [...Object.keys(schema.nodes), ...Object.keys(schema.marks)];
		expect(names.filter((name) => !used.has(name))).toEqual([]);
	});

	it("finds Portable Text in the template seeds", () => {
		expect(seedValues.length).toBeGreaterThan(0);
	});

	// Seeds aren't always in the form the editor saves: an image can hold a
	// `$media` reference that seeding resolves. Such a value must come back as
	// the converter writes it with no shared document in between.
	it.each(seedValues)("keeps the seed value at $path unchanged", ({ blocks }) => {
		expect(roundTripThroughSharedDocument(blocks)).toEqual(roundTripThroughConverter(blocks));
	});
});
