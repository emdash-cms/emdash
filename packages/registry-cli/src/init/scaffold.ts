/**
 * Filesystem half of `emdash-registry init`. Takes the scaffold inputs +
 * the target directory and writes the file tree. Pure templates live in
 * `./templates.ts` so this module is just policy: which files exist,
 * where they go, what happens when something's already there.
 *
 * Overwrite policy: refuses by default if any target file exists. Pass
 * `--force` to allow overwriting (file-by-file, not directory-wide).
 * This avoids the common "I ran init in the wrong dir and clobbered my
 * package.json" surprise.
 */

import { access, mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import {
	renderGitignore,
	renderManifest,
	renderPackageJson,
	renderPluginEntry,
	renderReadme,
	renderTest,
	renderTsconfig,
	type ScaffoldInputs,
} from "./templates.js";

export type InitErrorCode = "TARGET_FILE_EXISTS" | "INVALID_SLUG" | "INVALID_PUBLISHER";

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
const FILES = [
	"emdash-plugin.jsonc",
	"package.json",
	"tsconfig.json",
	".gitignore",
	"README.md",
	"src/plugin.ts",
	"tests/plugin.test.ts",
] as const;

type ScaffoldFile = (typeof FILES)[number];

/**
 * Scaffold a plugin into `targetDir`. The target dir is created if it
 * doesn't exist; missing intermediate directories under it are created
 * per-file as needed.
 *
 * If any target file already exists and `force` is false, the function
 * throws BEFORE writing anything. Partial writes don't happen — either
 * every file gets written or none do.
 */
export async function scaffold(options: ScaffoldOptions): Promise<ScaffoldResult> {
	const { targetDir, inputs, force, onFileWritten } = options;
	const absDir = resolve(targetDir);

	// Pre-flight: check for conflicts. We do this before any write so a
	// partial scaffold can't leave the target dir in a half-broken state.
	if (!force) {
		const conflicts: string[] = [];
		for (const file of FILES) {
			const absPath = join(absDir, file);
			if (await exists(absPath)) {
				conflicts.push(file);
			}
		}
		if (conflicts.length > 0) {
			throw new InitError(
				"TARGET_FILE_EXISTS",
				`Cannot scaffold into ${absDir}: the following files already exist. Pass --force to overwrite them.\n  ${conflicts.join("\n  ")}`,
				conflicts,
			);
		}
	}

	await mkdir(absDir, { recursive: true });

	const written: string[] = [];
	for (const file of FILES) {
		const absPath = join(absDir, file);
		await mkdir(dirname(absPath), { recursive: true });
		await writeFile(absPath, renderFile(file, inputs), "utf8");
		written.push(absPath);
		onFileWritten?.(file);
	}

	return { written };
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
			return renderTest();
	}
}

async function exists(path: string): Promise<boolean> {
	try {
		await access(path);
		return true;
	} catch {
		return false;
	}
}
