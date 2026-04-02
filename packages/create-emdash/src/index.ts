/**
 * create-emdash
 *
 * Interactive CLI for creating new EmDash projects
 *
 * Usage: npm create emdash@latest
 */

import { exec } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { promisify } from "node:util";

const execAsync = promisify(exec);

import * as p from "@clack/prompts";
import { downloadTemplate } from "giget";
import pc from "picocolors";

const PROJECT_NAME_PATTERN = /^[a-z0-9-]+$/;
const NEWLINE_REGEX = /\r?\n/;
const SQLITE_IMPORT_REGEX = /import\s+\{\s*sqlite\s*\}\s+from\s+"emdash\/db";/;
const SQLITE_DATABASE_CONFIG_REGEX = /database:\s*sqlite\(\{[^}]*\}\),/m;

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

type Platform = "node" | "bun" | "cloudflare";
type RuntimeDatabase = "sqlite" | "postgres" | "mongodb";
type DatabaseChoice = RuntimeDatabase | "d1";

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
	const keys: K[] = Object.keys(obj).filter((k): k is K => k in obj);
	return keys.map((key) => ({
		value: key,
		label: obj[key].name,
		hint: obj[key].description,
	}));
}

async function selectTemplate(platform: Platform): Promise<TemplateConfig> {
	if (platform === "node" || platform === "bun") {
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

function ensureEnvVar(projectDir: string, name: string, value: string): void {
	const envPath = resolve(projectDir, ".env.example");
	const nextLine = `${name}=${value}`;

	if (!existsSync(envPath)) {
		writeFileSync(envPath, `${nextLine}\n`);
		return;
	}

	const current = readFileSync(envPath, "utf-8");
	const lines = current.split(NEWLINE_REGEX);
	if (lines.some((line) => line.startsWith(`${name}=`))) return;

	const suffix = current.endsWith("\n") ? "" : "\n";
	writeFileSync(envPath, `${current}${suffix}${nextLine}\n`);
}

function normalizeStringMap(value: unknown): Record<string, string> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const output: Record<string, string> = {};
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") output[key] = entry;
	}
	return output;
}

function normalizePackageJson(value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const pkg: Record<string, unknown> = { ...value };
	pkg.dependencies = normalizeStringMap(Reflect.get(pkg, "dependencies"));
	pkg.scripts = normalizeStringMap(Reflect.get(pkg, "scripts"));
	return pkg;
}

function configureDatabase(projectDir: string, database: DatabaseChoice): string[] {
	if (database === "d1" || database === "sqlite") return [];

	const notes: string[] = [];
	const pkgPath = resolve(projectDir, "package.json");
	const pkg = normalizePackageJson(JSON.parse(readFileSync(pkgPath, "utf-8")));
	const dependencies = normalizeStringMap(Reflect.get(pkg, "dependencies"));
	pkg.dependencies = dependencies;

	if (database === "postgres") {
		const astroConfigPath = resolve(projectDir, "astro.config.mjs");
		if (existsSync(astroConfigPath)) {
			let astroConfig = readFileSync(astroConfigPath, "utf-8");
			astroConfig = astroConfig.replace(SQLITE_IMPORT_REGEX, 'import { postgres } from "emdash/db";');
			astroConfig = astroConfig.replace(
				SQLITE_DATABASE_CONFIG_REGEX,
				"database: postgres({\n\t\t\t\tconnectionString: process.env.DATABASE_URL,\n\t\t\t}),",
			);
			writeFileSync(astroConfigPath, astroConfig);
		}

		dependencies.pg = dependencies.pg ?? "^8.16.0";
		delete dependencies["better-sqlite3"];
		ensureEnvVar(projectDir, "DATABASE_URL", "postgres://user:password@localhost:5432/emdash");
		notes.push("Database: PostgreSQL configured (set DATABASE_URL in .env)");
	}

	if (database === "mongodb") {
		dependencies.mongodb = dependencies.mongodb ?? "^6.18.0";
		ensureEnvVar(projectDir, "MONGODB_URL", "mongodb://localhost:27017/emdash");

		const libDir = resolve(projectDir, "src", "lib");
		mkdirSync(libDir, { recursive: true });
		const mongoHelperPath = resolve(libDir, "mongodb.ts");
		if (!existsSync(mongoHelperPath)) {
			writeFileSync(
				mongoHelperPath,
				`import { MongoClient } from "mongodb";

let client: MongoClient | null = null;

export async function getMongoClient(): Promise<MongoClient> {
	if (client) return client;

	const url = process.env.MONGODB_URL;
	if (!url) {
		throw new Error("MONGODB_URL is not set");
	}

	client = new MongoClient(url);
	await client.connect();
	return client;
}
`,
			);
		}

		notes.push("MongoDB helper added at src/lib/mongodb.ts for custom app data");
		notes.push("EmDash core content storage remains SQL-based (SQLite by default)");
	}

	writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
	return notes;
}

async function main() {
	console.clear();

	console.log(`\n  ${pc.bold(pc.cyan("— E M D A S H —"))}\n`);
	p.intro("Create a new EmDash project");

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
				value: "cloudflare",
				label: "Cloudflare Workers",
				hint: "D1 + R2",
			},
			{
				value: "node",
				label: "Node.js",
				hint: "SQLite + local file storage",
			},
			{
				value: "bun",
				label: "Bun Runtime",
				hint: "Node adapter running on Bun",
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

	// Step 3: pick database
	const database: DatabaseChoice =
		platform === "cloudflare"
			? "d1"
			: await (async () => {
				const selected = await p.select<RuntimeDatabase>({
					message: "Which database setup?",
					options: [
						{
							value: "sqlite",
							label: "SQLite",
							hint: "Simplest local setup",
						},
						{
							value: "postgres",
							label: "PostgreSQL",
							hint: "Production relational database",
						},
						{
							value: "mongodb",
							label: "MongoDB (companion)",
							hint: "Adds MongoDB helper for custom app data",
						},
					],
					initialValue: "sqlite",
				});

				if (p.isCancel(selected)) {
					p.cancel("Operation cancelled.");
					process.exit(0);
				}

				return selected;
			})();

	// Step 4: pick package manager
	const detectedPm = detectPackageManager();
	const pm = await p.select<PackageManager>({
		message: "Which package manager?",
		options: [
			{ value: "pnpm", label: "pnpm" },
			{ value: "npm", label: "npm" },
			{ value: "yarn", label: "yarn" },
			{ value: "bun", label: "bun" },
		],
		initialValue: platform === "bun" ? "bun" : detectedPm,
	});

	if (p.isCancel(pm)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

	// Step 5: install dependencies?
	const shouldInstall = await p.confirm({
		message: "Install dependencies?",
		initialValue: true,
	});

	if (p.isCancel(shouldInstall)) {
		p.cancel("Operation cancelled.");
		process.exit(0);
	}

	const installCmd = `${pm} install`;
	const runCmd = (script: string) => {
		if (pm === "npm") return `npm run ${script}`;
		if (pm === "bun") return `bun run ${script}`;
		return `${pm} ${script}`;
	};

	const s = p.spinner();
	s.start("Creating project...");

	try {
		await downloadTemplate(`github:${GITHUB_REPO}/${templateConfig.dir}`, {
			dir: projectDir,
			force: true,
		});

		// Set project name in package.json
		const pkgPath = resolve(projectDir, "package.json");
		let configNotes: string[] = [];
		if (existsSync(pkgPath)) {
			const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
			pkg.name = projectName;

			if (platform === "bun") {
				pkg.scripts = pkg.scripts || {};
				if (!pkg.scripts["start:bun"]) {
					pkg.scripts["start:bun"] = "bun ./dist/server/entry.mjs";
				}
			}

			// Add emdash config if template has seed data
			const seedPath = resolve(projectDir, "seed", "seed.json");
			if (existsSync(seedPath)) {
				pkg.emdash = {
					label: templateConfig.name,
					seed: "seed/seed.json",
				};
			}

			writeFileSync(pkgPath, JSON.stringify(pkg, null, 2));
			configNotes = configureDatabase(projectDir, database);

			if (platform === "bun") {
				configNotes.push("Runtime: Bun selected (use bun run dev / bun run build)");
			}

			if (configNotes.length > 0) {
				p.note(configNotes.join("\n"), "Configuration");
			}
		}

		s.stop("Project created!");

		if (shouldInstall) {
			s.start(`Installing dependencies with ${pc.cyan(pm)}...`);
			try {
				await execAsync(installCmd, { cwd: projectDir });
				s.stop("Dependencies installed!");
			} catch {
				s.stop("Failed to install dependencies");
				p.log.warn(`Run ${pc.cyan(`cd ${projectName} && ${installCmd}`)} manually`);
			}
		}

		const steps = [`cd ${projectName}`];
		if (!shouldInstall) steps.push(installCmd);
		steps.push(runCmd("dev"));

		p.note(steps.join("\n"), "Next steps");

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
