/**
 * create-emdash
 *
 * Interactive CLI for creating new EmDash projects
 *
 * Usage: npm create emdash@latest [directory]
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
	PROJECT_NAME_PATTERN,
	isDirNonEmpty,
	parseTargetArg,
	sanitizePackageName,
	writeEncryptionKey,
} from "./utils.js";

const targetArg = parseTargetArg(process.argv);

const GITHUB_REPO = "emdash-cms/templates";

type PackageManager = "pnpm" | "npm" | "yarn" | "bun";

/** Detect which package manager invoked us, or fall back to npm */
function detectPackageManager(): PackageManager {
	const agent = process.env.npm_config_user_agent ?? "";
	if (agent.startsWith("pnpm")) return "pnpm";
	if (agent.startsWith("yarn")) return "yarn";
	if (agent.startsWith("bun")) return "bun";
	return "npm";
}

type Platform = "node" | "cloudflare";

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
} as const satisfies Record<string, TemplateConfig>;

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
} as const satisfies Record<string, TemplateConfig>;

type NodeTemplate = keyof typeof NODE_TEMPLATES;
type CloudflareTemplate = keyof typeof CLOUDFLARE_TEMPLATES;

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

async function selectTemplate(platform: Platform): Promise<TemplateConfig> {
	if (platform === "node") {
		const key = await p.select<NodeTemplate>({
			message: "Which template?",
			options: selectOptions(NODE_TEMPLATES),
			initialValue: "blog",
		});
		if (p.isCancel(key)) {
			p.cancel("Operation cancelled.");
			process.exit(0);
		}
		return NODE_TEMPLATES[key];
	}
	const key = await p.select<CloudflareTemplate>({
		message: "Which template?",
		options: selectOptions(CLOUDFLARE_TEMPLATES),
		initialValue: "blog",
	});
	if (p.isCancel(key)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}
	return CLOUDFLARE_TEMPLATES[key];
}

async function main() {
	console.clear();

	console.log(`\n  ${pc.bold(pc.cyan("— E M D A S H —"))}\n`);
	p.intro("Create a new EmDash project");

	const isCurrentDir = targetArg === ".";
	let projectName: string;
	let projectDir: string;

	if (isCurrentDir) {
		// "npm create emdash ." — scaffold into the current directory
		projectDir = process.cwd();
		projectName = sanitizePackageName(basename(projectDir));

		if (isDirNonEmpty(projectDir)) {
			const proceed = await p.confirm({
				message: "Current directory is not empty. Files may be overwritten. Continue?",
				initialValue: false,
			});

			if (p.isCancel(proceed) || !proceed) {
				p.cancel("Operation cancelled.");
				process.exit(0);
			}
		}
	} else if (targetArg) {
		// "npm create emdash my-project" — use the argument as the project name
		if (!PROJECT_NAME_PATTERN.test(targetArg)) {
			p.cancel("Project name can only contain lowercase letters, numbers, and hyphens.");
			process.exit(1);
		}
		projectName = targetArg;
		projectDir = resolve(process.cwd(), projectName);

		if (isDirNonEmpty(projectDir)) {
			const overwrite = await p.confirm({
				message: `Directory ${projectName} already exists and is not empty. Files may be overwritten. Continue?`,
				initialValue: false,
			});

			if (p.isCancel(overwrite) || !overwrite) {
				p.cancel("Operation cancelled.");
				process.exit(0);
			}
		}
	} else {
		// No argument — interactive prompt
		const name = await p.text({
			message: "Project name?",
			placeholder: "my-site",
			defaultValue: "my-site",
			validate: (value) => {
				if (!value) return "Project name is required";
				if (!PROJECT_NAME_PATTERN.test(value))
					return "Project name can only contain lowercase letters, numbers, and hyphens";
				return undefined;
			},
		});

		if (p.isCancel(name)) {
			p.cancel("Operation cancelled.");
			process.exit(0);
		}

		projectName = name;
		projectDir = resolve(process.cwd(), projectName);

		if (isDirNonEmpty(projectDir)) {
			const overwrite = await p.confirm({
				message: `Directory ${projectName} already exists and is not empty. Files may be overwritten. Continue?`,
				initialValue: false,
			});

			if (p.isCancel(overwrite) || !overwrite) {
				p.cancel("Operation cancelled.");
				process.exit(0);
			}
		}
	}

	// Step 1: pick platform
	const platform = await p.select<Platform>({
		message: "Where will you deploy?",
		options: [
			{
				value: "cloudflare",
				label: "Cloudflare Workers",
				hint: "D1 + R2",
			},
			{
				value: "node",
				label: "Node.js",
				hint: "SQLite + local file storage",
			},
		],
		initialValue: "cloudflare",
	});

	if (p.isCancel(platform)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

	// Step 2: pick template
	const templateConfig = await selectTemplate(platform);

	// Step 3: pick package manager
	const detectedPm = detectPackageManager();
	const pm = await p.select<PackageManager>({
		message: "Which package manager?",
		options: [
			{ value: "pnpm", label: "pnpm" },
			{ value: "npm", label: "npm" },
			{ value: "yarn", label: "yarn" },
			{ value: "bun", label: "bun" },
		],
		initialValue: detectedPm,
	});

	if (p.isCancel(pm)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

	// Step 4: install dependencies?
	const shouldInstall = await p.confirm({
		message: "Install dependencies?",
		initialValue: true,
	});

	if (p.isCancel(shouldInstall)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

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
