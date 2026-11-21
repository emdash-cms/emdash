import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import ts from "typescript";
import { afterAll, expect, it } from "vitest";

const coreDir = resolve(import.meta.dirname, "../..");
const consumer = mkdtempSync(join(tmpdir(), "emdash-ui-consumer-"));
mkdirSync(join(consumer, "node_modules"));
symlinkSync(coreDir, join(consumer, "node_modules/emdash"), "dir");
afterAll(() => rmSync(consumer, { recursive: true, force: true }));

it.each(["emdash/ui", "emdash/ui/search", "emdash/ui/comments", "emdash/ui/webmcp-search"])(
	"resolves %s to a declaration file",
	(specifier) => {
		const { resolvedModule } = ts.resolveModuleName(
			specifier,
			join(consumer, "index.ts"),
			{ moduleResolution: ts.ModuleResolutionKind.Bundler },
			ts.sys,
		);
		expect(resolvedModule?.extension).toBe(ts.Extension.Dmts);
		if (!resolvedModule) throw new Error(`Could not resolve ${specifier}`);
		const declaration = readFileSync(resolvedModule.resolvedFileName, "utf8");
		for (const imported of ts.preProcessFile(declaration).importedFiles) {
			expect(imported.fileName.endsWith(".astro"), imported.fileName).toBe(false);
			if (imported.fileName.startsWith(".")) {
				expect(
					resolve(coreDir, "dist", imported.fileName).startsWith(join(coreDir, "src")),
					imported.fileName,
				).toBe(false);
			}
		}
	},
);

it("checks UI imports without loading EmDash implementation source", () => {
	const astroModules = join(consumer, "env.d.ts");
	writeFileSync(astroModules, 'declare module "*.astro";\n');
	const entry = join(consumer, "index.ts");
	writeFileSync(
		entry,
		`import { Image, PortableText, Block, Blocks, defineBlockComponents, type BlockValue } from "emdash/ui";
import LiveSearch from "emdash/ui/search";
import WebMcpSearch from "emdash/ui/webmcp-search";
import { Comments, CommentForm } from "emdash/ui/comments";
Image({ image: null, quality: "high" });
LiveSearch({ locale: null, collections: ["posts"] });
WebMcpSearch({});
Comments({ collection: "posts", contentId: "1" });
CommentForm({ collection: "posts", contentId: "1" });
type Hero = BlockValue & { _type: "hero"; title: string };
const components = defineBlockComponents<Hero>({ hero: ({ value }) => value.title });
Blocks<Hero>({ value: [], components });
PortableText({ value: [] });
PortableText({ value: undefined });
PortableText({ value: null });
const block: Block = { _type: "block", children: [], _key: "1", style: "normal" };
Block({ node: block, index: 0, isInline: false });
// @ts-expect-error PortableText value is required
PortableText({});
// @ts-expect-error invalid Block node
Block({ node: 42, index: 0, isInline: false });
// @ts-expect-error image is required
Image({});
// @ts-expect-error invalid quality
Image({ image: null, quality: false });
// @ts-expect-error invalid locale
LiveSearch({ locale: 42 });
// @ts-expect-error invalid block renderer
Blocks<Hero>({ components: { hero: ({ value }: { value: { title: number } }) => value.title } });
`,
	);
	const program = ts.createProgram([entry, astroModules], {
		module: ts.ModuleKind.Preserve,
		moduleResolution: ts.ModuleResolutionKind.Bundler,
		target: ts.ScriptTarget.ESNext,
		strict: true,
		exactOptionalPropertyTypes: true,
		noUncheckedIndexedAccess: true,
		skipLibCheck: true,
		noEmit: true,
		types: [join(coreDir, "node_modules/astro/client.d.ts")],
	});
	const implementationFiles = program
		.getSourceFiles()
		.filter((file) => file.fileName.startsWith(join(coreDir, "src")))
		.map((file) => file.fileName);
	expect(implementationFiles).toEqual([]);
	expect(
		ts
			.getPreEmitDiagnostics(program)
			.map(
				(diagnostic) =>
					`${diagnostic.file?.fileName}:${diagnostic.start}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")}`,
			),
	).toEqual([]);
});
