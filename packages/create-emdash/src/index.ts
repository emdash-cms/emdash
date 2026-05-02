/**
 * create-emdash
 *
 * CLI for creating new EmDash projects.
 *
 * Defaults to an interactive flow. Pass flags (or --yes) to run
 * non-interactively — see `--help` or {@link HELP_TEXT} for the full set.
 *
 * Usage: npm create emdash@latest [name] [options]
 */

import { exec } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

import * as p from "@clack/prompts";
import { downloadTemplate } from "giget";
import pc from "picocolors";

import {
	FlagError,
	HELP_TEXT,
	type PackageManager,
	type ParsedFlags,
	type Platform,
	type TemplateKey,
	parseFlags,
	validateProjectName,
	wantsHelp,
} from "./flags.js";
import {
	PROJECT_NAME_PATTERN,
	isDirNonEmpty,
	sanitizePackageName,
	writeEncryptionKey,
} from "./utils.js";

const GITHUB_REPO = "emdash-cms/templates";

interface TemplateConfig {
	name: string;
	description: string;
	/** Directory name in the templates repo */
	dir: string;
}

const NODE_TEMPLATES = {
	blog: {
		name: "Blog",
		description: "A blog with posts, pages, and authors",
		dir: "blog",
	},
	starter: {
		name: "Starter",
		description: "A general-purpose starter with posts and pages",
		dir: "starter",
	},
	marketing: {
		name: "Marketing",
		description: "A marketing site with landing pages and CTAs",
		dir: "marketing",
	},
	portfolio: {
		name: "Portfolio",
		description: "A portfolio site with projects and case studies",
		dir: "portfolio",
	},
} as const satisfies Record<TemplateKey, TemplateConfig>;

const CLOUDFLARE_TEMPLATES = {
	blog: {
		name: "Blog",
		description: "A blog with posts, pages, and authors",
		dir: "blog-cloudflare",
	},
	starter: {
		name: "Starter",
		description: "A general-purpose starter with posts and pages",
		dir: "starter-cloudflare",
	},
	marketing: {
		name: "Marketing",
		description: "A marketing site with landing pages and CTAs",
		dir: "marketing-cloudflare",
	},
	portfolio: {
		name: "Portfolio",
		description: "A portfolio site with projects and case studies",
		dir: "portfolio-cloudflare",
	},
} as const satisfies Record<TemplateKey, TemplateConfig>;

/** Defaults applied under `--yes` when the user omits a flag. */
const DEFAULT_PLATFORM: Platform = "cloudflare";
const DEFAULT_TEMPLATE: TemplateKey = "blog";
/** Used by `--yes` when the user omits the project name positional. */
const DEFAULT_PROJECT_NAME = "my-site";

/** Detect which package manager invoked us, or fall back to npm */
function detectPackageManager(): PackageManager {
	const agent = process.env.npm_config_user_agent ?? "";
	if (agent.startsWith("pnpm")) return "pnpm";
	if (agent.startsWith("yarn")) return "yarn";
	if (agent.startsWith("bun")) return "bun";
	return "npm";
}

/** Build select options from a config object, preserving literal key types */
function selectOptions<K extends string>(
	obj: Readonly<Record<K, Readonly<{ name: string; description: string }>>>,
): { value: K; label: string; hint: string }[] {
	const keys: K[] = Object.keys(obj).filter((k): k is K => k in obj);
	return keys.map((key) => ({
		value: key,
		label: obj[key].name,
		hint: obj[key].description,
	}));
}

const NEWLINE_PATTERN = /\r?\n/;

/**
 * Make sure `fileName` is excluded by `.gitignore`. Templates' gitignores
 * already cover `.env*` but not `.dev.vars`; rather than relying on every
 * template being current, the scaffolder defensively appends a stanza if
 * no existing line matches.
 */
function ensureGitignored(projectDir: string, fileName: string): void {
	const target = resolve(projectDir, ".gitignore");
	const existing = existsSync(target) ? readFileSync(target, "utf-8") : "";
	const lines = existing.split(NEWLINE_PATTERN);
	if (lines.some((line) => line.trim() === fileName)) {
		return;
	}
	const sep = existing.length === 0 ? "" : existing.endsWith("\n") ? "" : "\n";
	const next = `${existing}${sep}${fileName}\n`;
	writeFileSync(target, next);
}

function getTemplateConfig(platform: Platform, key: TemplateKey): TemplateConfig {
	return platform === "node" ? NODE_TEMPLATES[key] : CLOUDFLARE_TEMPLATES[key];
}

async function selectTemplate(platform: Platform): Promise<TemplateKey> {
	const map = platform === "node" ? NODE_TEMPLATES : CLOUDFLARE_TEMPLATES;
	const key = await p.select<TemplateKey>({
		message: "Which template?",
		options: selectOptions(map),
		initialValue: "blog",
	});
	if (p.isCancel(key)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}
	return key;
}

/**
 * Resolve the project name + directory. Honours flags first, then falls back
 * to the interactive prompt.
 *
 * Returns `null` if the user declined to overwrite a non-empty target.
 */
async function resolveProjectLocation(
	flags: ParsedFlags,
): Promise<{ projectName: string; projectDir: string; isCurrentDir: boolean } | null> {
	// Validate the positional once, here, so the error message matches the
	// prompt path and parseFlags stays purely structural. parseFlags already
	// captured the raw value; this is the only place that enforces the
	// pattern across both flag and prompt entry points.
	if (flags.name !== undefined) {
		const error = validateProjectName(flags.name);
		if (error) {
			p.cancel(`${error}.`);
			process.exit(1);
		}
	}

	const target = flags.name;
	const isCurrentDir = target === ".";

	if (isCurrentDir) {
		const projectDir = process.cwd();
		const projectName = sanitizePackageName(basename(projectDir));
		if (isDirNonEmpty(projectDir)) {
			// Under --yes we refuse to clobber unless --force is also set.
			// Silently overwriting source files in the user's cwd is the
			// kind of default we should never ship.
			if (flags.yes && !flags.force) {
				p.cancel("Current directory is not empty. Re-run with --force to allow overwriting.");
				process.exit(1);
			}
			if (!flags.yes) {
				const proceed = await p.confirm({
					message: "Current directory is not empty. Files may be overwritten. Continue?",
					initialValue: false,
				});
				if (p.isCancel(proceed) || !proceed) return null;
			}
			// flags.yes && flags.force: proceed silently.
		}
		return { projectName, projectDir, isCurrentDir: true };
	}

	let projectName: string;
	if (target !== undefined) {
		projectName = target;
	} else if (flags.yes) {
		// --yes with no positional: fall back to the documented default
		// rather than silently dropping into the (broken-in-non-TTY) prompt.
		// This is the contract documented in flags.ts and HELP_TEXT.
		projectName = DEFAULT_PROJECT_NAME;
	} else {
		const name = await p.text({
			message: "Project name?",
			placeholder: DEFAULT_PROJECT_NAME,
			defaultValue: DEFAULT_PROJECT_NAME,
			validate: (value) => {
				if (!value) return "Project name is required";
				if (!PROJECT_NAME_PATTERN.test(value))
					return "Project name can only contain lowercase letters, numbers, and hyphens";
				return undefined;
			},
		});
		if (p.isCancel(name)) return null;
		projectName = name;
	}

	const projectDir = resolve(process.cwd(), projectName);
	if (isDirNonEmpty(projectDir)) {
		if (flags.yes && !flags.force) {
			p.cancel(
				`Directory ${projectName} already exists and is not empty. Re-run with --force to allow overwriting.`,
			);
			process.exit(1);
		}
		if (!flags.yes) {
			const overwrite = await p.confirm({
				message: `Directory ${projectName} already exists and is not empty. Files may be overwritten. Continue?`,
				initialValue: false,
			});
			if (p.isCancel(overwrite) || !overwrite) return null;
		}
		// flags.yes && flags.force: proceed silently.
	}
	return { projectName, projectDir, isCurrentDir: false };
}

async function resolvePlatform(flags: ParsedFlags): Promise<Platform> {
	if (flags.platform !== undefined) return flags.platform;
	if (flags.yes) return DEFAULT_PLATFORM;
	const platform = await p.select<Platform>({
		message: "Where will you deploy?",
		options: [
			{ value: "cloudflare", label: "Cloudflare Workers", hint: "D1 + R2" },
			{ value: "node", label: "Node.js", hint: "SQLite + local file storage" },
		],
		initialValue: "cloudflare",
	});
	if (p.isCancel(platform)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}
	return platform;
}

async function resolveTemplate(flags: ParsedFlags, platform: Platform): Promise<TemplateKey> {
	if (flags.template !== undefined) return flags.template;
	if (flags.yes) return DEFAULT_TEMPLATE;
	return selectTemplate(platform);
}

async function resolvePackageManager(flags: ParsedFlags): Promise<PackageManager> {
	if (flags.packageManager !== undefined) return flags.packageManager;
	const detected = detectPackageManager();
	if (flags.yes) return detected;
	const pm = await p.select<PackageManager>({
		message: "Which package manager?",
		options: [
			{ value: "pnpm", label: "pnpm" },
			{ value: "npm", label: "npm" },
			{ value: "yarn", label: "yarn" },
			{ value: "bun", label: "bun" },
		],
		initialValue: detected,
	});
	if (p.isCancel(pm)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}
	return pm;
}

async function resolveShouldInstall(flags: ParsedFlags): Promise<boolean> {
	if (flags.install !== undefined) return flags.install;
	if (flags.yes) return true;
	const shouldInstall = await p.confirm({
		message: "Install dependencies?",
		initialValue: true,
	});
	if (p.isCancel(shouldInstall)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}
	return shouldInstall;
}

async function main() {
	// Short-circuit --help before strict parsing so a user typing
	// `npm create emdash@latest --help --template nope` gets the help they
	// asked for, not the parse error for the bad template.
	if (wantsHelp(process.argv)) {
		console.log(HELP_TEXT);
		process.exit(0);
	}

	let flags: ParsedFlags;
	try {
		flags = parseFlags(process.argv);
	} catch (error) {
		// FlagError carries a friendly message; parseArgs's own errors do too
		// (e.g. "Unknown option '--templat'"). Either way, surface and exit.
		const message =
			error instanceof FlagError || error instanceof Error ? error.message : String(error);
		console.error(`\n${pc.red("Error:")} ${message}\n`);
		console.error(HELP_TEXT);
		process.exit(1);
	}

	console.clear();
	console.log(`\n  ${pc.bold(pc.cyan("— E M D A S H —"))}\n`);
	p.intro("Create a new EmDash project");

	const location = await resolveProjectLocation(flags);
	if (location === null) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}
	const { projectName, projectDir, isCurrentDir } = location;

	const platform = await resolvePlatform(flags);
	const templateKey = await resolveTemplate(flags, platform);
	const templateConfig = getTemplateConfig(platform, templateKey);
	const pm = await resolvePackageManager(flags);
	const shouldInstall = await resolveShouldInstall(flags);

	const installCmd = `${pm} install`;
	const runCmd = (script: string) => (pm === "npm" ? `npm run ${script}` : `${pm} ${script}`);

	const s = p.spinner();
	s.start("Creating project...");

	try {
		await downloadTemplate(`github:${GITHUB_REPO}/${templateConfig.dir}`, {
			dir: projectDir,
			force: true,
		});

		// Set project name in package.json
		const pkgPath = resolve(projectDir, "package.json");
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			pkg.name = projectName;

			// Add emdash config if template has seed data
			const seedPath = resolve(projectDir, "seed", "seed.json");
			if (existsSync(seedPath)) {
				pkg.emdash = {
					label: templateConfig.name,
					seed: "seed/seed.json",
				};
			}

			writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
		}

		// Scaffold a fresh EMDASH_ENCRYPTION_KEY into the local-secrets file
		// (Workers: .dev.vars, Node: .env). Idempotent — won't overwrite an
		// existing entry if the user re-runs scaffolding into a non-empty
		// directory. We also defensively ensure the file is gitignored.
		const secretsFile = platform === "cloudflare" ? ".dev.vars" : ".env";
		const keyResult = writeEncryptionKey(projectDir, secretsFile);
		ensureGitignored(projectDir, secretsFile);

		s.stop("Project created!");

		if (keyResult === "skipped") {
			p.log.info(
				`Existing ${pc.cyan("EMDASH_ENCRYPTION_KEY")} found in ${pc.cyan(secretsFile)}; leaving it alone.`,
			);
		} else {
			p.log.info(`Wrote ${pc.cyan("EMDASH_ENCRYPTION_KEY")} to ${pc.cyan(secretsFile)}.`);
		}

		if (shouldInstall) {
			s.start(`Installing dependencies with ${pc.cyan(pm)}...`);
			try {
				await execAsync(installCmd, { cwd: projectDir });
				s.stop("Dependencies installed!");
			} catch {
				s.stop("Failed to install dependencies");
				p.log.warn(
					isCurrentDir
						? `Run ${pc.cyan(installCmd)} manually`
						: `Run ${pc.cyan(`cd ${projectName} && ${installCmd}`)} manually`,
				);
			}
		}

		const steps: string[] = [];
		if (!isCurrentDir) steps.push(`cd ${projectName}`);
		if (!shouldInstall) steps.push(installCmd);
		steps.push(runCmd("dev"));

		p.note(steps.join("\n"), "Next steps");

		p.outro(
			isCurrentDir
				? `${pc.green("Done!")} Your EmDash project is ready in the current directory`
				: `${pc.green("Done!")} Your EmDash project is ready at ${pc.cyan(projectName)}`,
		);
	} catch (error) {
		s.stop("Failed to create project");
		p.log.error(error instanceof Error ? error.message : String(error));
		process.exit(1);
	}
}

main().catch((error) => {
	console.error(error);
	process.exit(1);
});
