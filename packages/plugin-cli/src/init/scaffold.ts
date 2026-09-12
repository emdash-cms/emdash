/**
 * Filesystem half of `emdash-plugin init`. Takes the scaffold inputs +
 * the target directory and writes the file tree. Pure templates live in
 * `./templates.ts` so this module is just policy: which files exist,
 * where they go, what happens when something's already there.
 *
 * Overwrite policy: refuses by default if any target file exists. Pass
 * `--force` to allow overwriting (file-by-file, not directory-wide).
 * This avoids the common "I ran init in the wrong dir and clobbered my
 * package.json" surprise.
 */

import {
	link as createHardLink,
	lstat,
	mkdir,
	mkdtemp,
	rename,
	rm,
	symlink,
	unlink,
	writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";

import { parse, type ParseError } from "jsonc-parser";

import { ManifestSchema } from "../manifest/schema.js";
import {
	renderAgentsGuide,
	renderCreatingPluginsSkill,
	renderGitignore,
	renderManifest,
	renderPackageJson,
	renderPluginEntry,
	renderPnpmWorkspace,
	renderReadme,
	renderTest,
	renderTsconfig,
	type ScaffoldInputs,
} from "./templates.js";

export type InitErrorCode =
	| "TARGET_FILE_EXISTS"
	| "INVALID_MANIFEST"
	| "INVALID_SLUG"
	| "INVALID_PUBLISHER";

export class InitError extends Error {
	override readonly name = "InitError";
	readonly code: InitErrorCode;
	/** When set, the list of paths that already exist and would be overwritten. */
	readonly conflicts: string[];

	constructor(code: InitErrorCode, message: string, conflicts: string[] = []) {
		super(message);
		this.code = code;
		this.conflicts = conflicts;
	}
}

export interface ScaffoldOptions {
	/** Absolute path to the target directory. Created if it doesn't exist. */
	targetDir: string;
	/** Validated scaffold inputs. */
	inputs: ScaffoldInputs;
	/**
	 * When true, overwrite existing files. When false, refuse with
	 * `TARGET_FILE_EXISTS` listing the conflicting paths.
	 */
	force: boolean;
	/** Optional callback per file written, for CLI progress output. */
	onFileWritten?: (relativePath: string) => void;
}

export interface ScaffoldResult {
	/** Absolute paths of every file the scaffolder wrote. */
	written: string[];
}

/**
 * The file tree the scaffolder produces. Order matters: parents must
 * appear before children (the writer creates intermediate dirs from
 * the file path, so order is informational rather than mandatory, but
 * a consistent order keeps the per-file progress output predictable).
 */
const BASE_FILES = [
	"emdash-plugin.jsonc",
	"package.json",
	"tsconfig.json",
	".gitignore",
	"README.md",
	"src/plugin.ts",
	"tests/plugin.test.ts",
	"AGENTS.md",
	"skills/creating-plugins/SKILL.md",
] as const;

const SKILL_LINKS = [
	{ path: ".agents/skills", target: "../skills", kind: "dir" },
	{ path: ".claude/skills", target: "../skills", kind: "dir" },
	{ path: ".claude/CLAUDE.md", target: "../AGENTS.md", kind: "file" },
] as const;

type ScaffoldFile = (typeof BASE_FILES)[number] | "pnpm-workspace.yaml";

function scaffoldFiles(inputs: ScaffoldInputs): ScaffoldFile[] {
	return [
		...BASE_FILES,
		...(inputs.packageManager === "pnpm" ? (["pnpm-workspace.yaml"] as const) : []),
	];
}

/**
 * Scaffold a plugin into `targetDir`. The target dir is created if it
 * doesn't exist; missing intermediate directories under it are created
 * per-file as needed.
 *
 * If any target file or required parent path conflicts and `force` is
 * false, the function throws before writing anything. A new target is
 * staged beside its destination and renamed only after every file is
 * ready. Existing directories are preflighted before their generated
 * files are updated.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
	const { targetDir, inputs, force, onFileWritten } = options;
	const absDir = resolve(targetDir);
	const files = scaffoldFiles(inputs);
	const rendered = new Map(files.map((file) => [file, renderFile(file, inputs)]));
	validateScaffoldInputs(inputs);
	await assertScaffoldTargetAvailable(absDir, inputs.packageManager, force);
	const targetInfo = await pathStat(absDir);
	if (targetInfo === null) {
		await mkdir(dirname(absDir), { recursive: true });
		const staged = await mkdtemp(join(dirname(absDir), `.${basename(absDir)}-`));
		try {
			await writeRenderedFiles(staged, files, rendered);
			await writeSkillLinks(staged);
			await rename(staged, absDir);
		} catch (error) {
			await rm(staged, { recursive: true, force: true });
			throw error;
		}
		for (const path of [...files, ...SKILL_LINKS.map((link) => link.path)]) {
			onFileWritten?.(path);
		}
	} else {
		await writeRenderedFiles(absDir, files, rendered, onFileWritten);
		await writeSkillLinks(absDir, onFileWritten, force);
	}
	return {
		written: [...files, ...SKILL_LINKS.map((link) => link.path)].map((path) => join(absDir, path)),
	};
}

export async function assertScaffoldTargetAvailable(
	targetDir: string,
	packageManager: ScaffoldInputs["packageManager"],
	force: boolean,
): Promise<void> {
	const absDir = resolve(targetDir);
	const targetInfo = await pathStat(absDir);
	if (targetInfo && !targetInfo.isDirectory()) {
		throw new InitError("TARGET_FILE_EXISTS", `${absDir} exists and is not a directory.`, ["."]);
	}
	const conflicts = new Set<string>();
	for (const file of [
		...BASE_FILES,
		...(packageManager === "pnpm" ? (["pnpm-workspace.yaml"] as const) : []),
	]) {
		const segments = file.split("/");
		for (let index = 1; index < segments.length; index += 1) {
			const parent = segments.slice(0, index).join("/");
			const info = await pathStat(join(absDir, parent));
			if (info && !info.isDirectory()) conflicts.add(parent);
		}
		const fileInfo = await pathStat(join(absDir, file));
		if (fileInfo && (!force || !fileInfo.isFile())) conflicts.add(file);
	}
	for (const link of SKILL_LINKS) {
		const parent = link.path.slice(0, link.path.lastIndexOf("/"));
		const parentInfo = await pathStat(join(absDir, parent));
		if (parentInfo && !parentInfo.isDirectory()) conflicts.add(parent);
		const linkInfo = await pathStat(join(absDir, link.path));
		const replaceable =
			linkInfo?.isSymbolicLink() ||
			(process.platform === "win32" && link.kind === "file" && linkInfo?.isFile());
		if (linkInfo && (!force || !replaceable)) conflicts.add(link.path);
	}
	if (conflicts.size > 0) {
		const items = [...conflicts].toSorted();
		throw new InitError(
			"TARGET_FILE_EXISTS",
			`Cannot scaffold into ${absDir}: the following paths conflict. Pass --force to replace generated files.\n  ${items.join("\n  ")}`,
			items,
		);
	}
}

export function validateScaffoldInputs(inputs: ScaffoldInputs): void {
	const source = renderManifest(inputs);
	const errors: ParseError[] = [];
	const parsed: unknown = parse(source, errors, { allowTrailingComma: true });
	const result = errors.length === 0 ? ManifestSchema.safeParse(parsed) : null;
	if (result?.success) return;
	const message = result
		? result.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("\n")
		: "Generated manifest is not valid JSONC.";
	throw new InitError("INVALID_MANIFEST", `Generated plugin manifest is invalid:\n${message}`);
}

async function writeRenderedFiles(
	directory: string,
	files: ScaffoldFile[],
	rendered: ReadonlyMap<ScaffoldFile, string>,
	onFileWritten?: (relativePath: string) => void,
): Promise<void> {
	for (const file of files) {
		const path = join(directory, file);
		await mkdir(dirname(path), { recursive: true });
		await writeFile(path, rendered.get(file)!, "utf8");
		onFileWritten?.(file);
	}
}

async function writeSkillLinks(
	directory: string,
	onLinkWritten?: (relativePath: string) => void,
	force = false,
): Promise<void> {
	for (const link of SKILL_LINKS) {
		const path = join(directory, link.path);
		await mkdir(dirname(path), { recursive: true });
		const existing = await pathStat(path);
		if (existing && force) await unlink(path);
		if (!existing || force) {
			if (process.platform === "win32" && link.kind === "file") {
				await createHardLink(resolve(dirname(path), link.target), path);
			} else {
				await symlink(
					process.platform === "win32" ? resolve(dirname(path), link.target) : link.target,
					path,
					process.platform === "win32" ? "junction" : link.kind,
				);
			}
		}
		onLinkWritten?.(link.path);
	}
}

/**
 * Dispatch each scaffold-file path to its renderer. Centralised here so
 * adding a new file (icon, screenshot stub, docs page) is one place to
 * update — append to FILES, add a case.
 */
function renderFile(file: ScaffoldFile, inputs: ScaffoldInputs): string {
	switch (file) {
		case "emdash-plugin.jsonc":
			return renderManifest(inputs);
		case "package.json":
			return renderPackageJson(inputs);
		case "tsconfig.json":
			return renderTsconfig();
		case ".gitignore":
			return renderGitignore();
		case "README.md":
			return renderReadme(inputs);
		case "src/plugin.ts":
			return renderPluginEntry();
		case "tests/plugin.test.ts":
			return renderTest(inputs);
		case "AGENTS.md":
			return renderAgentsGuide();
		case "skills/creating-plugins/SKILL.md":
			return renderCreatingPluginsSkill();
		case "pnpm-workspace.yaml":
			return renderPnpmWorkspace();
	}
}

async function pathStat(path: string) {
	try {
		return await lstat(path);
	} catch (error) {
		if (
			error instanceof Error &&
			"code" in error &&
			(error.code === "ENOENT" || error.code === "ENOTDIR")
		) {
			return null;
		}
		throw error;
	}
}
