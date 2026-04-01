/**
 * create-emdash
 *
 * Interactive CLI for creating new EmDash projects
 *
 * Usage: npm create emdash@latest
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

import * as p from "@clack/prompts";
import { downloadTemplate } from "giget";
import pc from "picocolors";

const PROJECT_NAME_PATTERN = /^[a-z0-9-]+$/;

const GITHUB_REPO = "emdash-cms/templates";

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
	blank: {
		name: "Blank",
		description: "A minimal starter with no content or styling",
		dir: "blank",
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
	return (Object.keys(obj) as K[]).map((key) => ({
		value: key,
		label: obj[key].name,
		hint: obj[key].description,
	}));
}

async function main() {
	console.clear();

	p.intro(`${pc.bgCyan(pc.black(" create-emdash "))}`);

	const projectName = await p.text({
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

	if (p.isCancel(projectName)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

	const projectDir = resolve(process.cwd(), projectName);

	if (existsSync(projectDir)) {
		const overwrite = await p.confirm({
			message: `Directory ${projectName} already exists. Overwrite?`,
			initialValue: false,
		});

		if (p.isCancel(overwrite) || !overwrite) {
			p.cancel("Operation cancelled.");
			process.exit(0);
		}
	}

	// Step 1: pick platform
	const platform = await p.select<Platform>({
		message: "Where will you deploy?",
		options: [
			{
				value: "node",
				label: "Node.js",
				hint: "SQLite + local file storage",
			},
			{
				value: "cloudflare",
				label: "Cloudflare Workers",
				hint: "D1 + R2",
			},
		],
		initialValue: "node",
	});

	if (p.isCancel(platform)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

	// Step 2: pick template
	const templateKey =
		platform === "node"
			? await p.select<NodeTemplate>({
					message: "Which template?",
					options: selectOptions(NODE_TEMPLATES),
					initialValue: "blog",
				})
			: await p.select<CloudflareTemplate>({
					message: "Which template?",
					options: selectOptions(CLOUDFLARE_TEMPLATES),
					initialValue: "blog",
				});

	if (p.isCancel(templateKey)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

	const templateConfig =
		platform === "node"
			? NODE_TEMPLATES[templateKey as NodeTemplate]
			: CLOUDFLARE_TEMPLATES[templateKey as CloudflareTemplate];

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

		s.stop("Project created!");

		s.start("Installing dependencies...");
		try {
			execSync("pnpm install", {
				cwd: projectDir,
				stdio: "ignore",
			});
			s.stop("Dependencies installed!");
		} catch {
			s.stop("Failed to install dependencies");
			p.log.warn(`Run ${pc.cyan(`cd ${projectName} && pnpm install`)} manually`);
		}

		p.note(`cd ${projectName}\npnpm run bootstrap\npnpm run dev`, "Next steps");

		p.outro(`${pc.green("Done!")} Your EmDash project is ready at ${pc.cyan(projectName)}`);
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
