import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import { convertToTSX } from "@astrojs/compiler";
import { build } from "tsdown";
import ts from "typescript";

const external = [/^astro:/, /^virtual:emdash\//];

/** Build UI declarations separately: Astro still compiles the runtime source. */
export async function buildUiTypes(): Promise<void> {
	const root = import.meta.dirname;
	const cache = join(root, ".emdash");
	await mkdir(cache, { recursive: true });
	const temporary = await mkdtemp(join(cache, "emdash-ui-types-"));
	try {
		// Keep relative imports and package import aliases intact, without writing
		// generated sidecars into the source tree (including in watch mode).
		await cp(join(root, "src"), join(temporary, "src"), { recursive: true });
		await cp(join(root, "package.json"), join(temporary, "package.json"));
		const src = join(temporary, "src");
		for (const file of await readdir(src, { recursive: true })) {
			if (!file.endsWith(".astro")) continue;
			const filename = join(src, file);
			const { code, diagnostics } = await convertToTSX(await readFile(filename, "utf8"), {
				// The compiler writes this name into the sourcemap JSON verbatim and parses
				// that JSON back, so Windows separators must not reach it as backslashes.
				filename: filename.replaceAll("\\", "/"),
				includeScripts: false,
				includeStyles: false,
				sourcemap: "external",
			});
			const errors = diagnostics.filter((diagnostic) => Number(diagnostic.severity) === 1);
			if (errors.length) {
				throw new Error(
					errors
						.map(({ location, text }) => `${file}:${location.line}:${location.column}: ${text}`)
						.join("\n"),
				);
			}
			const declaration = ts.transpileDeclaration(code, {
				fileName: `${filename}.tsx`,
				compilerOptions: { jsx: ts.JsxEmit.Preserve },
			});
			if (declaration.diagnostics?.length) {
				throw new Error(
					ts.formatDiagnosticsWithColorAndContext(declaration.diagnostics, {
						getCanonicalFileName: (name) => name,
						getCurrentDirectory: () => root,
						getNewLine: () => "\n",
					}),
				);
			}
			await writeFile(`${filename}.d.ts`, declaration.outputText);
		}
		for (const [entry, component] of [
			["ui-search", "LiveSearch"],
			["ui-webmcp-search", "WebMcpSearch"],
		]) {
			await writeFile(
				join(src, `${entry}.ts`),
				`export { default } from "./components/${component}.astro";\nexport type { Props } from "./components/${component}.astro";\n`,
			);
		}
		await build({
			config: false,
			entry: {
				ui: join(src, "ui.ts"),
				"ui-comments": join(src, "ui-comments.ts"),
				"ui-search": join(src, "ui-search.ts"),
				"ui-webmcp-search": join(src, "ui-webmcp-search.ts"),
			},
			outDir: resolve(root, "dist"),
			clean: false,
			format: "esm",
			dts: { emitDtsOnly: true, sourcemap: false, compilerOptions: { rootDir: src } },
			sourcemap: false,
			external,
			inputOptions: { experimental: { attachDebugInfo: "none" } },
			plugins: [
				{
					name: "astro-declarations",
					resolveId(id, importer) {
						if (id.endsWith(".astro") && importer) {
							return resolve(dirname(importer), `${id}.d.ts`);
						}
					},
				},
			],
		});
	} finally {
		await rm(temporary, { recursive: true, force: true });
	}
}
