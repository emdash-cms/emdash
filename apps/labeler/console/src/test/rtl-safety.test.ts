import { readdirSync, readFileSync } from "node:fs";
import { dirname } from "node:path";

import { describe, expect, it } from "vitest";

const SRC_ROOT = dirname(import.meta.dirname);

/** Tailwind classes that hard-code a physical side. RTL-safe layout uses the
 * logical equivalents (ms/me, ps/pe, start/end, border-s/e, rounded-s/e,
 * float-start/end, text-start/end). */
const PHYSICAL = [
	/^-?(ml|mr|pl|pr)-/,
	/^-?(left|right)-/,
	/^(text-left|text-right)$/,
	/^border-(l|r)(-|$)/,
	/^rounded-(l|r)(-|$)/,
	/^(float-left|float-right)$/,
];

const CLASS_VALUE = /className=(?:"([^"]*)"|\{`([^`]*)`\})/g;

function sourceFiles(dir: string): string[] {
	const files: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = `${dir}/${entry.name}`;
		if (entry.isDirectory()) {
			if (entry.name === "test") continue;
			files.push(...sourceFiles(path));
		} else if (/\.tsx?$/.test(entry.name) && !entry.name.includes(".test.")) {
			files.push(path);
		}
	}
	return files;
}

function physicalClasses(source: string): string[] {
	const hits: string[] = [];
	for (const match of source.matchAll(CLASS_VALUE)) {
		const value = match[1] ?? match[2] ?? "";
		for (const token of value.split(/\s+/)) {
			const base = (token.split(":").at(-1) ?? token).replace(/["'`]/g, "");
			if (PHYSICAL.some((re) => re.test(base))) hits.push(token);
		}
	}
	return hits;
}

describe("RTL safety: console source uses logical Tailwind classes", () => {
	const files = sourceFiles(SRC_ROOT);

	it("scans a non-trivial set of source files", () => {
		expect(files.length).toBeGreaterThan(10);
	});

	it.each(files.map((file) => [file.slice(SRC_ROOT.length), file] as const))(
		"%s has no physical-direction classes",
		(_label, file) => {
			expect(physicalClasses(readFileSync(file, "utf8"))).toEqual([]);
		},
	);
});
