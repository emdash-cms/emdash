import { describe, expect, it } from "vitest";

const sources = new Map(
	Object.entries(
		import.meta.glob<string>("../../src/**/*.{ts,tsx}", {
			query: "?raw",
			import: "default",
			eager: true,
		}),
	).map(([path, source]) => [path.replace(/^(\.\.\/)+/, ""), source]),
);

const IMPORT = /^\s*(?:import|export)\s+(type\s+)?(?:[^;]*?\sfrom\s+)?["']([^"']+)["']/gm;
const DYNAMIC_IMPORT = /\bimport\(\s*["']([^"']+)["']\s*\)/g;

function resolve(from: string, specifier: string): string | undefined {
	const base = new URL(specifier, `file:///${from}`).pathname.slice(1);
	const stem = base.replace(/\.js$/, "");
	return [`${stem}.ts`, `${stem}.tsx`, `${stem}/index.ts`].find((path) => sources.has(path));
}

/** The packages a module loads, directly or through the modules it loads. */
function packagesLoadedBy(entry: string): Set<string> {
	const packages = new Set<string>();
	const seen = new Set<string>();
	const pending = [entry];
	while (pending.length > 0) {
		const file = pending.pop()!;
		if (seen.has(file)) continue;
		seen.add(file);
		const source = sources.get(file)!;
		const specifiers = [
			...[...source.matchAll(IMPORT)].filter((match) => !match[1]).map((match) => match[2]!),
			...Array.from(source.matchAll(DYNAMIC_IMPORT), (match) => match[1]!),
		];
		for (const specifier of specifiers) {
			if (specifier.startsWith(".")) {
				const path = resolve(file, specifier);
				if (path) pending.push(path);
			} else {
				packages.add(specifier);
			}
		}
	}
	return packages;
}

describe("@emdash-cms/admin/internal/portable-text", () => {
	it("loads no Yjs code, since sites import it on the server", () => {
		const packages = [...packagesLoadedBy("src/internal/portable-text.ts")];
		expect(packages).toContain("@tiptap/core");
		const yjs = packages.filter((name) =>
			/^(yjs|lib0|y-protocols|@tiptap\/y-tiptap|@tiptap\/extension-collaboration)(\/|$)/.test(name),
		);
		expect(yjs).toEqual([]);
	});
});
